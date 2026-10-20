use serde::Serialize;
use tauri::AppHandle;

#[derive(Clone, Debug, Serialize)]
pub struct NativeVoiceInputResult {
    pub status: String,
    pub transcript: String,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeVoiceInputEvent {
    status: String,
    transcript: String,
    is_final: bool,
    error: Option<String>,
}

#[cfg(target_os = "macos")]
const EVENT_NAME: &str = "native-voice-input-event";

#[cfg(target_os = "macos")]
mod platform {
    use super::{NativeVoiceInputEvent, NativeVoiceInputResult, EVENT_NAME};
    use block2::RcBlock;
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::process::Command;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    };
    use tauri::{AppHandle, Emitter};

    #[repr(C)]
    struct ObjcObject {
        _private: [u8; 0],
    }

    type TapBlock = RcBlock<dyn Fn(*mut c_void, *mut c_void)>;
    type RecognitionBlock = RcBlock<dyn Fn(*mut c_void, *mut c_void)>;

    struct NativeVoiceSession {
        recognizer: usize,
        request: usize,
        task: usize,
        engine: usize,
        input: usize,
        tap_block: TapBlock,
        recognition_block: RecognitionBlock,
        transcript: Arc<Mutex<String>>,
        active: Arc<AtomicBool>,
    }

    // The raw ObjC references are only touched while protected by SESSION and released on stop.
    unsafe impl Send for NativeVoiceSession {}

    static SESSION: OnceLock<Mutex<Option<NativeVoiceSession>>> = OnceLock::new();

    pub async fn start(
        app: AppHandle,
        locale: Option<String>,
    ) -> Result<NativeVoiceInputResult, String> {
        let session = SESSION.get_or_init(|| Mutex::new(None));
        if session
            .lock()
            .map_err(|_| "Native voice session lock failed")?
            .is_some()
        {
            stop(app.clone()).await?;
        }

        ensure_tcc_usage_descriptions_are_available()?;
        ensure_permissions()?;

        let transcript = Arc::new(Mutex::new(String::new()));
        let active = Arc::new(AtomicBool::new(true));
        let recognizer = create_recognizer(locale.as_deref())?;
        let available = unsafe { objc_msg_send_i8(recognizer, objc_sel("isAvailable")) != 0 };
        if !available {
            release_obj(recognizer);
            return Err("macOS speech recognizer is unavailable.".to_string());
        }

        let request = unsafe {
            objc_msg_send_id(
                objc_class("SFSpeechAudioBufferRecognitionRequest"),
                objc_sel("new"),
            )
        };
        if request.is_null() {
            release_obj(recognizer);
            return Err("Failed to create speech recognition request.".to_string());
        }
        unsafe {
            objc_msg_send_void_i8(request, objc_sel("setShouldReportPartialResults:"), 1);
            objc_msg_send_void_isize(request, objc_sel("setTaskHint:"), 1);
        }

        let engine = unsafe { objc_msg_send_id(objc_class("AVAudioEngine"), objc_sel("new")) };
        if engine.is_null() {
            release_obj(request);
            release_obj(recognizer);
            return Err("Failed to create AVAudioEngine.".to_string());
        }

        let input = unsafe { objc_msg_send_id(engine, objc_sel("inputNode")) };
        if input.is_null() {
            release_obj(engine);
            release_obj(request);
            release_obj(recognizer);
            return Err("No usable audio input device available.".to_string());
        }
        let format = unsafe { objc_msg_send_id_usize(input, objc_sel("outputFormatForBus:"), 0) };
        if format.is_null() {
            release_obj(engine);
            release_obj(request);
            release_obj(recognizer);
            return Err("No audio input format available.".to_string());
        }

        let request_for_tap = request as usize;
        let tap_block: TapBlock = RcBlock::new(move |buffer: *mut c_void, _when: *mut c_void| {
            if !buffer.is_null() {
                unsafe {
                    objc_msg_send_void_id(
                        request_for_tap as *mut ObjcObject,
                        objc_sel("appendAudioPCMBuffer:"),
                        buffer.cast::<ObjcObject>(),
                    );
                }
            }
        });
        unsafe {
            objc_msg_send_void_usize_usize_id_id(
                input,
                objc_sel("installTapOnBus:bufferSize:format:block:"),
                0,
                2048,
                format,
                RcBlock::as_ptr(&tap_block).cast::<c_void>(),
            );
            objc_msg_send_void(engine, objc_sel("prepare"));
        }

        let mut error: *mut ObjcObject = std::ptr::null_mut();
        let started = unsafe {
            objc_msg_send_i8_error(engine, objc_sel("startAndReturnError:"), &mut error) != 0
        };
        if !started {
            unsafe {
                objc_msg_send_void_usize(input, objc_sel("removeTapOnBus:"), 0);
            }
            let detail = objc_error_description(error)
                .unwrap_or_else(|| "Failed to start audio engine.".to_string());
            release_obj(engine);
            release_obj(request);
            release_obj(recognizer);
            return Err(detail);
        }

        let app_for_recognition = app.clone();
        let transcript_for_recognition = transcript.clone();
        let active_for_recognition = active.clone();
        let recognition_block: RecognitionBlock =
            RcBlock::new(move |result: *mut c_void, error: *mut c_void| {
                if !active_for_recognition.load(Ordering::SeqCst) {
                    return;
                }
                if !error.is_null() {
                    let _ = app_for_recognition.emit(
                        EVENT_NAME,
                        NativeVoiceInputEvent {
                            status: "error".to_string(),
                            transcript: String::new(),
                            is_final: false,
                            error: objc_error_description(error.cast::<ObjcObject>()),
                        },
                    );
                    return;
                }
                if result.is_null() {
                    return;
                }
                let result = result.cast::<ObjcObject>();
                let transcription =
                    unsafe { objc_msg_send_id(result, objc_sel("bestTranscription")) };
                let text = ns_string_to_string(unsafe {
                    objc_msg_send_id(transcription, objc_sel("formattedString"))
                })
                .unwrap_or_default();
                let trimmed = text.trim().to_string();
                if trimmed.is_empty() {
                    return;
                }
                if let Ok(mut current) = transcript_for_recognition.lock() {
                    *current = trimmed.clone();
                }
                let is_final = unsafe { objc_msg_send_i8(result, objc_sel("isFinal")) != 0 };
                let _ = app_for_recognition.emit(
                    EVENT_NAME,
                    NativeVoiceInputEvent {
                        status: if is_final { "final" } else { "partial" }.to_string(),
                        transcript: trimmed,
                        is_final,
                        error: None,
                    },
                );
            });

        let task = unsafe {
            objc_msg_send_id_id_id(
                recognizer,
                objc_sel("recognitionTaskWithRequest:resultHandler:"),
                request,
                RcBlock::as_ptr(&recognition_block).cast::<c_void>(),
            )
        };
        if task.is_null() {
            unsafe {
                objc_msg_send_void(engine, objc_sel("stop"));
                objc_msg_send_void_usize(input, objc_sel("removeTapOnBus:"), 0);
            }
            release_obj(engine);
            release_obj(request);
            release_obj(recognizer);
            return Err("Failed to start speech recognition task.".to_string());
        }
        unsafe {
            objc_msg_send_id(task, objc_sel("retain"));
        }

        *session
            .lock()
            .map_err(|_| "Native voice session lock failed")? = Some(NativeVoiceSession {
            recognizer: recognizer as usize,
            request: request as usize,
            task: task as usize,
            engine: engine as usize,
            input: input as usize,
            tap_block,
            recognition_block,
            transcript,
            active,
        });

        emit_status(&app, "started", "", false, None);
        Ok(NativeVoiceInputResult {
            status: "started".to_string(),
            transcript: String::new(),
        })
    }

    pub async fn stop(app: AppHandle) -> Result<NativeVoiceInputResult, String> {
        finish(app, false)
    }

    pub async fn cancel(app: AppHandle) -> Result<NativeVoiceInputResult, String> {
        finish(app, true)
    }

    fn finish(app: AppHandle, cancel: bool) -> Result<NativeVoiceInputResult, String> {
        let session = SESSION.get_or_init(|| Mutex::new(None));
        let Some(session) = session
            .lock()
            .map_err(|_| "Native voice session lock failed")?
            .take()
        else {
            let status = if cancel { "cancelled" } else { "stopped" };
            emit_status(&app, status, "", true, None);
            return Ok(NativeVoiceInputResult {
                status: status.to_string(),
                transcript: String::new(),
            });
        };

        session.active.store(false, Ordering::SeqCst);
        unsafe {
            objc_msg_send_void(session.task as *mut ObjcObject, objc_sel("cancel"));
            objc_msg_send_void(session.request as *mut ObjcObject, objc_sel("endAudio"));
            objc_msg_send_void_usize(
                session.input as *mut ObjcObject,
                objc_sel("removeTapOnBus:"),
                0,
            );
            objc_msg_send_void(session.engine as *mut ObjcObject, objc_sel("stop"));
        }

        let transcript = session
            .transcript
            .lock()
            .map(|value| value.trim().to_string())
            .unwrap_or_default();

        release_obj(session.task as *mut ObjcObject);
        release_obj(session.engine as *mut ObjcObject);
        release_obj(session.request as *mut ObjcObject);
        release_obj(session.recognizer as *mut ObjcObject);
        drop(session.tap_block);
        drop(session.recognition_block);

        if cancel {
            emit_status(&app, "cancelled", "", true, None);
            Ok(NativeVoiceInputResult {
                status: "cancelled".to_string(),
                transcript: String::new(),
            })
        } else {
            if !transcript.is_empty() {
                emit_status(&app, "final", &transcript, true, None);
            }
            emit_status(&app, "stopped", &transcript, true, None);
            Ok(NativeVoiceInputResult {
                status: "stopped".to_string(),
                transcript,
            })
        }
    }

    fn ensure_permissions() -> Result<(), String> {
        let mic_status = av_capture_authorization_status("soun");
        if mic_status == 0 {
            request_av_capture("soun");
        }
        if av_capture_authorization_status("soun") != 3 {
            return Err("Microphone permission is required for native voice input.".to_string());
        }

        let speech_status = unsafe {
            objc_msg_send_usize(
                objc_class("SFSpeechRecognizer"),
                objc_sel("authorizationStatus"),
            )
        };
        if speech_status == 0 {
            request_speech_recognition();
        }
        let speech_status = unsafe {
            objc_msg_send_usize(
                objc_class("SFSpeechRecognizer"),
                objc_sel("authorizationStatus"),
            )
        };
        if speech_status != 3 {
            return Err(
                "Speech Recognition permission is required for native voice input.".to_string(),
            );
        }
        Ok(())
    }

    fn ensure_tcc_usage_descriptions_are_available() -> Result<(), String> {
        if !code_signature_binds_info_plist() {
            return Err(
                "Native macOS voice input requires a codesigned app or debug binary with microphone and speech privacy descriptions. Please open the packaged app, or codesign the debug binary before testing voice input."
                    .to_string(),
            );
        }
        for key in [
            "NSMicrophoneUsageDescription",
            "NSSpeechRecognitionUsageDescription",
        ] {
            if !main_bundle_has_info_value(key) {
                return Err(format!(
                    "Native macOS voice input requires {key} in the app Info.plist."
                ));
            }
        }
        Ok(())
    }

    fn code_signature_binds_info_plist() -> bool {
        let Ok(exe) = std::env::current_exe() else {
            return false;
        };
        let Ok(output) = Command::new("/usr/bin/codesign")
            .arg("-dvvv")
            .arg(exe)
            .output()
        else {
            return false;
        };
        let details = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        !details.contains("Info.plist=not bound") && details.contains("Info.plist entries=")
    }

    fn main_bundle_has_info_value(key: &str) -> bool {
        let bundle = unsafe { objc_msg_send_id(objc_class("NSBundle"), objc_sel("mainBundle")) };
        if bundle.is_null() {
            return false;
        }
        let info = unsafe { objc_msg_send_id(bundle, objc_sel("infoDictionary")) };
        if info.is_null() {
            return false;
        }
        let key = ns_string(key);
        if key.is_null() {
            return false;
        }
        let value = unsafe { objc_msg_send_id_id(info, objc_sel("objectForKey:"), key) };
        !value.is_null()
    }

    fn emit_status(
        app: &AppHandle,
        status: &str,
        transcript: &str,
        is_final: bool,
        error: Option<String>,
    ) {
        let _ = app.emit(
            EVENT_NAME,
            NativeVoiceInputEvent {
                status: status.to_string(),
                transcript: transcript.to_string(),
                is_final,
                error,
            },
        );
    }

    fn create_recognizer(locale: Option<&str>) -> Result<*mut ObjcObject, String> {
        if let Some(locale) = locale.map(str::trim).filter(|value| !value.is_empty()) {
            let locale_string = ns_string(locale);
            if !locale_string.is_null() {
                let locale_obj = unsafe {
                    objc_msg_send_id_id(
                        objc_class("NSLocale"),
                        objc_sel("localeWithLocaleIdentifier:"),
                        locale_string,
                    )
                };
                if !locale_obj.is_null() {
                    let recognizer = unsafe {
                        let allocated =
                            objc_msg_send_id(objc_class("SFSpeechRecognizer"), objc_sel("alloc"));
                        objc_msg_send_id_id(allocated, objc_sel("initWithLocale:"), locale_obj)
                    };
                    if !recognizer.is_null() {
                        return Ok(recognizer);
                    }
                }
            }
        }
        let recognizer =
            unsafe { objc_msg_send_id(objc_class("SFSpeechRecognizer"), objc_sel("new")) };
        if recognizer.is_null() {
            Err("Failed to create macOS speech recognizer.".to_string())
        } else {
            Ok(recognizer)
        }
    }

    fn av_capture_authorization_status(media_type: &str) -> usize {
        let media_type = ns_string(media_type);
        if media_type.is_null() {
            return 0;
        }
        unsafe {
            objc_msg_send_usize_id(
                objc_class("AVCaptureDevice"),
                objc_sel("authorizationStatusForMediaType:"),
                media_type,
            )
        }
    }

    fn request_av_capture(media_type: &str) {
        let media_type = ns_string(media_type);
        if media_type.is_null() {
            return;
        }
        let block: RcBlock<dyn Fn(i8)> = RcBlock::new(move |_granted: i8| {});
        unsafe {
            objc_msg_send_void_id_id(
                objc_class("AVCaptureDevice"),
                objc_sel("requestAccessForMediaType:completionHandler:"),
                media_type,
                RcBlock::as_ptr(&block).cast::<c_void>(),
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(700));
    }

    fn request_speech_recognition() {
        let block: RcBlock<dyn Fn(usize)> = RcBlock::new(move |_status: usize| {});
        unsafe {
            objc_msg_send_void_block(
                objc_class("SFSpeechRecognizer"),
                objc_sel("requestAuthorization:"),
                RcBlock::as_ptr(&block).cast::<c_void>(),
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(700));
    }

    fn ns_string(value: &str) -> *mut ObjcObject {
        let Ok(value) = CString::new(value) else {
            return std::ptr::null_mut();
        };
        unsafe {
            objc_msg_send_id_char(
                objc_class("NSString"),
                objc_sel("stringWithUTF8String:"),
                value.as_ptr(),
            )
        }
    }

    fn ns_string_to_string(value: *mut ObjcObject) -> Option<String> {
        if value.is_null() {
            return None;
        }
        let raw = unsafe { objc_msg_send_char(value, objc_sel("UTF8String")) };
        if raw.is_null() {
            return None;
        }
        Some(
            unsafe { CStr::from_ptr(raw) }
                .to_string_lossy()
                .into_owned(),
        )
    }

    fn objc_error_description(error: *mut ObjcObject) -> Option<String> {
        if error.is_null() {
            return None;
        }
        let description = unsafe { objc_msg_send_id(error, objc_sel("localizedDescription")) };
        ns_string_to_string(description)
    }

    fn release_obj(value: *mut ObjcObject) {
        if !value.is_null() {
            unsafe {
                objc_msg_send_void(value, objc_sel("release"));
            }
        }
    }

    fn objc_class(name: &str) -> *mut ObjcObject {
        let Ok(name) = CString::new(name) else {
            return std::ptr::null_mut();
        };
        unsafe { objc_getClass(name.as_ptr()).cast::<ObjcObject>() }
    }

    fn objc_sel(name: &str) -> *mut c_void {
        let Ok(name) = CString::new(name) else {
            return std::ptr::null_mut();
        };
        unsafe { sel_registerName(name.as_ptr()).cast::<c_void>() }
    }

    #[allow(clashing_extern_declarations)]
    #[link(name = "objc", kind = "dylib")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_i8(receiver: *mut ObjcObject, selector: *mut c_void) -> i8;
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_i8_error(
            receiver: *mut ObjcObject,
            selector: *mut c_void,
            error: *mut *mut ObjcObject,
        ) -> i8;
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_char(receiver: *mut ObjcObject, selector: *mut c_void) -> *const c_char;
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_id(receiver: *mut ObjcObject, selector: *mut c_void) -> *mut ObjcObject;
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_id_char(
            receiver: *mut ObjcObject,
            selector: *mut c_void,
            arg: *const c_char,
        ) -> *mut ObjcObject;
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_id_id(
            receiver: *mut ObjcObject,
            selector: *mut c_void,
            arg: *mut ObjcObject,
        ) -> *mut ObjcObject;
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_id_id_id(
            receiver: *mut ObjcObject,
            selector: *mut c_void,
            arg1: *mut ObjcObject,
            arg2: *const c_void,
        ) -> *mut ObjcObject;
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_id_usize(
            receiver: *mut ObjcObject,
            selector: *mut c_void,
            arg: usize,
        ) -> *mut ObjcObject;
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_usize(receiver: *mut ObjcObject, selector: *mut c_void) -> usize;
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_usize_id(
            receiver: *mut ObjcObject,
            selector: *mut c_void,
            arg: *mut ObjcObject,
        ) -> usize;
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_void(receiver: *mut ObjcObject, selector: *mut c_void);
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_void_i8(receiver: *mut ObjcObject, selector: *mut c_void, arg: i8);
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_void_id(
            receiver: *mut ObjcObject,
            selector: *mut c_void,
            arg: *mut ObjcObject,
        );
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_void_block(
            receiver: *mut ObjcObject,
            selector: *mut c_void,
            arg: *const c_void,
        );
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_void_id_id(
            receiver: *mut ObjcObject,
            selector: *mut c_void,
            arg1: *mut ObjcObject,
            arg2: *const c_void,
        );
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_void_isize(receiver: *mut ObjcObject, selector: *mut c_void, arg: isize);
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_void_usize(receiver: *mut ObjcObject, selector: *mut c_void, arg: usize);
        #[link_name = "objc_msgSend"]
        fn objc_msg_send_void_usize_usize_id_id(
            receiver: *mut ObjcObject,
            selector: *mut c_void,
            arg1: usize,
            arg2: usize,
            arg3: *mut ObjcObject,
            arg4: *const c_void,
        );
    }

    #[link(name = "AVFoundation", kind = "framework")]
    unsafe extern "C" {}

    #[link(name = "Speech", kind = "framework")]
    unsafe extern "C" {}
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::NativeVoiceInputResult;
    use tauri::AppHandle;

    pub async fn start(
        _app: AppHandle,
        _locale: Option<String>,
    ) -> Result<NativeVoiceInputResult, String> {
        Err("Native voice input is only available on macOS.".to_string())
    }

    pub async fn stop(_app: AppHandle) -> Result<NativeVoiceInputResult, String> {
        Ok(NativeVoiceInputResult {
            status: "stopped".to_string(),
            transcript: String::new(),
        })
    }

    pub async fn cancel(_app: AppHandle) -> Result<NativeVoiceInputResult, String> {
        Ok(NativeVoiceInputResult {
            status: "cancelled".to_string(),
            transcript: String::new(),
        })
    }
}

pub async fn start(
    app: AppHandle,
    locale: Option<String>,
) -> Result<NativeVoiceInputResult, String> {
    platform::start(app, locale).await
}

pub async fn stop(app: AppHandle) -> Result<NativeVoiceInputResult, String> {
    platform::stop(app).await
}

pub async fn cancel(app: AppHandle) -> Result<NativeVoiceInputResult, String> {
    platform::cancel(app).await
}
