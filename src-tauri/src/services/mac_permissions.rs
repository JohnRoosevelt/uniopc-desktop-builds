#[cfg(target_os = "macos")]
use block2::RcBlock;
use serde::Serialize;
#[cfg(any(target_os = "macos", test))]
use std::{ffi::OsStr, path::Path};
#[cfg(target_os = "macos")]
use std::{
    ffi::{c_char, c_void, CString},
    sync::mpsc,
    time::Duration,
};

#[derive(Clone, Debug, Serialize)]
pub struct MacPermissionItem {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub granted: bool,
    pub supported: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct MacPermissionStatus {
    pub supported: bool,
    pub granted: usize,
    pub total: usize,
    pub permissions: Vec<MacPermissionItem>,
}

struct PermissionDefinition {
    id: &'static str,
    title: &'static str,
    subtitle: &'static str,
}

const PERMISSIONS: &[PermissionDefinition] = &[
    PermissionDefinition {
        id: "appleScript",
        title: "Automation (AppleScript)",
        subtitle: "Control other apps (e.g. Terminal) for automation actions",
    },
    PermissionDefinition {
        id: "notifications",
        title: "Notifications",
        subtitle: "Show desktop alerts for agent activity",
    },
    PermissionDefinition {
        id: "accessibility",
        title: "Accessibility",
        subtitle: "Control UI elements when an action requires it",
    },
    PermissionDefinition {
        id: "screenRecording",
        title: "Screen Recording",
        subtitle: "Capture the screen for context or screenshots",
    },
    PermissionDefinition {
        id: "microphone",
        title: "Microphone",
        subtitle: "Allow Voice Wake and audio capture",
    },
    PermissionDefinition {
        id: "speechRecognition",
        title: "Speech Recognition",
        subtitle: "Transcribe Voice Wake trigger phrases on-device",
    },
    PermissionDefinition {
        id: "camera",
        title: "Camera",
        subtitle: "Capture photos and video from the camera",
    },
    PermissionDefinition {
        id: "location",
        title: "Location",
        subtitle: "Share location when requested by the agent",
    },
];

pub async fn status() -> Result<MacPermissionStatus, String> {
    let permissions: Vec<MacPermissionItem> = PERMISSIONS
        .iter()
        .map(|definition| {
            let supported = permission_supported(definition.id);
            MacPermissionItem {
                id: definition.id.to_string(),
                title: definition.title.to_string(),
                subtitle: definition.subtitle.to_string(),
                granted: supported && permission_granted(definition.id),
                supported,
            }
        })
        .collect();
    let granted = permissions
        .iter()
        .filter(|permission| permission.supported && permission.granted)
        .count();
    let total = permissions
        .iter()
        .filter(|permission| permission.supported)
        .count();
    Ok(MacPermissionStatus {
        supported: cfg!(target_os = "macos"),
        granted,
        total,
        permissions,
    })
}

pub async fn request(capability: &str) -> Result<(), String> {
    let id = capability.trim();
    if !PERMISSIONS.iter().any(|definition| definition.id == id) {
        return Err(format!("Unknown macOS permission: {id}"));
    }
    request_permission(id)
}

#[cfg(target_os = "macos")]
fn permission_supported(id: &str) -> bool {
    match id {
        "notifications" => notifications_runtime_supported(),
        _ => true,
    }
}

#[cfg(not(target_os = "macos"))]
fn permission_supported(_id: &str) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn permission_granted(id: &str) -> bool {
    match id {
        "appleScript" => apple_script_granted(),
        "notifications" => notifications_granted(),
        "accessibility" => accessibility_granted(),
        "screenRecording" => screen_recording_granted(),
        "microphone" => av_capture_granted("soun"),
        "speechRecognition" => speech_recognition_granted(),
        "camera" => av_capture_granted("vide"),
        "location" => location_granted(),
        _ => false,
    }
}

#[cfg(not(target_os = "macos"))]
fn permission_granted(_id: &str) -> bool {
    false
}

#[cfg(any(target_os = "macos", test))]
fn notifications_supported_for_executable_path(path: &Path) -> bool {
    let Some(macos_dir) = path.parent() else {
        return false;
    };
    if macos_dir.file_name() != Some(OsStr::new("MacOS")) {
        return false;
    }
    let Some(contents_dir) = macos_dir.parent() else {
        return false;
    };
    if contents_dir.file_name() != Some(OsStr::new("Contents")) {
        return false;
    }
    let Some(app_dir) = contents_dir.parent() else {
        return false;
    };
    app_dir.extension() == Some(OsStr::new("app"))
}

#[cfg(target_os = "macos")]
fn notifications_runtime_supported() -> bool {
    std::env::current_exe()
        .ok()
        .as_deref()
        .map(notifications_supported_for_executable_path)
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn request_permission(id: &str) -> Result<(), String> {
    match id {
        "appleScript" => {
            let _ = determine_terminal_automation_permission(true);
            open_settings(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
            )
        }
        "accessibility" => open_settings(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        ),
        "screenRecording" => {
            unsafe {
                let _ = CGRequestScreenCaptureAccess();
            }
            open_settings(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            )
        }
        "notifications" => {
            request_notifications();
            open_settings("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
        }
        "microphone" => {
            request_av_capture("soun");
            open_settings(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            )
        }
        "speechRecognition" => {
            request_speech_recognition();
            open_settings(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
            )
        }
        "camera" => {
            request_av_capture("vide");
            open_settings("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")
        }
        "location" => {
            request_location();
            open_settings(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices",
            )
        }
        _ => Ok(()),
    }
}

#[cfg(not(target_os = "macos"))]
fn request_permission(_id: &str) -> Result<(), String> {
    Err("macOS permissions are only available on macOS.".to_string())
}

#[cfg(target_os = "macos")]
fn apple_script_granted() -> bool {
    determine_terminal_automation_permission(false)
}

#[cfg(target_os = "macos")]
fn determine_terminal_automation_permission(ask_user_if_needed: bool) -> bool {
    const TERMINAL_BUNDLE_ID: &[u8] = b"com.apple.Terminal";
    let mut target = AEDesc {
        descriptor_type: 0,
        data_handle: std::ptr::null_mut(),
    };
    let create_status = unsafe {
        AECreateDesc(
            fourcc(*b"bund"),
            TERMINAL_BUNDLE_ID.as_ptr().cast::<c_void>(),
            TERMINAL_BUNDLE_ID.len() as isize,
            &mut target,
        )
    };
    if create_status != 0 {
        return false;
    }
    let permission_status = unsafe {
        AEDeterminePermissionToAutomateTarget(
            &target,
            fourcc(*b"aevt"),
            fourcc(*b"oapp"),
            u8::from(ask_user_if_needed),
        )
    };
    unsafe {
        let _ = AEDisposeDesc(&mut target);
    }
    permission_status == 0
}

#[cfg(target_os = "macos")]
fn fourcc(value: [u8; 4]) -> u32 {
    u32::from_be_bytes(value)
}

#[cfg(target_os = "macos")]
fn notifications_granted() -> bool {
    let center = notification_center();
    if center.is_null() {
        return false;
    }
    let (tx, rx) = mpsc::sync_channel(1);
    let block: RcBlock<dyn Fn(*mut c_void)> = RcBlock::new(move |settings: *mut c_void| {
        let settings = settings.cast::<ObjcObject>();
        let status = if settings.is_null() {
            0
        } else {
            unsafe { objc_msg_send_usize(settings, objc_sel("authorizationStatus")) }
        };
        let _ = tx.send(status);
    });
    unsafe {
        objc_msg_send_void_id(
            center,
            objc_sel("getNotificationSettingsWithCompletionHandler:"),
            RcBlock::as_ptr(&block).cast::<c_void>(),
        );
    }
    matches!(rx.recv_timeout(Duration::from_millis(700)), Ok(2 | 3 | 4))
}

#[cfg(target_os = "macos")]
fn request_notifications() {
    let center = notification_center();
    if center.is_null() {
        return;
    }
    let (tx, rx) = mpsc::sync_channel(1);
    let block: RcBlock<dyn Fn(i8, *mut c_void)> =
        RcBlock::new(move |_granted: i8, _error: *mut c_void| {
            let _ = tx.send(());
        });
    unsafe {
        objc_msg_send_void_usize_id(
            center,
            objc_sel("requestAuthorizationWithOptions:completionHandler:"),
            7,
            RcBlock::as_ptr(&block).cast::<c_void>(),
        );
    }
    let _ = rx.recv_timeout(Duration::from_millis(700));
}

#[cfg(target_os = "macos")]
fn notification_center() -> *mut ObjcObject {
    if !notifications_runtime_supported() {
        return std::ptr::null_mut();
    }
    run_on_main_queue(|| unsafe {
        objc_msg_send_id(
            objc_class("UNUserNotificationCenter"),
            objc_sel("currentNotificationCenter"),
        )
    })
}

#[cfg(target_os = "macos")]
fn run_on_main_queue<R, F>(work: F) -> R
where
    F: FnOnce() -> R,
{
    if is_main_thread() {
        return work();
    }

    struct MainQueueCall<R, F: FnOnce() -> R> {
        work: Option<F>,
        result: Option<R>,
    }

    extern "C" fn invoke<R, F>(context: *mut c_void)
    where
        F: FnOnce() -> R,
    {
        let call = unsafe { &mut *(context.cast::<MainQueueCall<R, F>>()) };
        let work = call.work.take().expect("main queue work missing");
        call.result = Some(work());
    }

    let mut call = MainQueueCall {
        work: Some(work),
        result: None,
    };
    unsafe {
        dispatch_sync_f(
            dispatch_get_main_queue(),
            (&mut call as *mut MainQueueCall<R, F>).cast::<c_void>(),
            invoke::<R, F>,
        );
    }
    call.result.expect("main queue result missing")
}

#[cfg(target_os = "macos")]
fn dispatch_get_main_queue() -> DispatchQueue {
    std::ptr::addr_of_mut!(_dispatch_main_q)
}

#[cfg(target_os = "macos")]
fn is_main_thread() -> bool {
    unsafe { objc_msg_send_i8(objc_class("NSThread"), objc_sel("isMainThread")) != 0 }
}

#[cfg(target_os = "macos")]
fn av_capture_granted(media_type: &str) -> bool {
    let media_type = ns_string(media_type);
    if media_type.is_null() {
        return false;
    }
    let status = unsafe {
        objc_msg_send_usize_id(
            objc_class("AVCaptureDevice"),
            objc_sel("authorizationStatusForMediaType:"),
            media_type,
        )
    };
    status == 3
}

#[cfg(target_os = "macos")]
fn request_av_capture(media_type: &str) {
    let media_type = ns_string(media_type);
    if media_type.is_null() {
        return;
    }
    let (tx, rx) = mpsc::sync_channel(1);
    let block: RcBlock<dyn Fn(i8)> = RcBlock::new(move |_granted: i8| {
        let _ = tx.send(());
    });
    unsafe {
        objc_msg_send_void_id_id(
            objc_class("AVCaptureDevice"),
            objc_sel("requestAccessForMediaType:completionHandler:"),
            media_type,
            RcBlock::as_ptr(&block).cast::<c_void>(),
        );
    }
    let _ = rx.recv_timeout(Duration::from_millis(700));
}

#[cfg(target_os = "macos")]
fn speech_recognition_granted() -> bool {
    let status = unsafe {
        objc_msg_send_usize(
            objc_class("SFSpeechRecognizer"),
            objc_sel("authorizationStatus"),
        )
    };
    status == 3
}

#[cfg(target_os = "macos")]
fn request_speech_recognition() {
    let (tx, rx) = mpsc::sync_channel(1);
    let block: RcBlock<dyn Fn(usize)> = RcBlock::new(move |_status: usize| {
        let _ = tx.send(());
    });
    unsafe {
        objc_msg_send_void_id(
            objc_class("SFSpeechRecognizer"),
            objc_sel("requestAuthorization:"),
            RcBlock::as_ptr(&block).cast::<c_void>(),
        );
    }
    let _ = rx.recv_timeout(Duration::from_millis(700));
}

#[cfg(target_os = "macos")]
fn location_granted() -> bool {
    let services_enabled = unsafe {
        objc_msg_send_i8(
            objc_class("CLLocationManager"),
            objc_sel("locationServicesEnabled"),
        )
    };
    if services_enabled == 0 {
        return false;
    }
    let status = unsafe {
        objc_msg_send_isize(
            objc_class("CLLocationManager"),
            objc_sel("authorizationStatus"),
        )
    };
    matches!(status, 3 | 4)
}

#[cfg(target_os = "macos")]
fn request_location() {
    let manager = unsafe { objc_msg_send_id(objc_class("CLLocationManager"), objc_sel("new")) };
    if manager.is_null() {
        return;
    }
    unsafe {
        objc_msg_send_void(manager, objc_sel("requestWhenInUseAuthorization"));
    }
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
fn objc_class(name: &str) -> *mut ObjcObject {
    let Ok(name) = CString::new(name) else {
        return std::ptr::null_mut();
    };
    unsafe { objc_getClass(name.as_ptr()).cast::<ObjcObject>() }
}

#[cfg(target_os = "macos")]
fn objc_sel(name: &str) -> *mut c_void {
    let Ok(name) = CString::new(name) else {
        return std::ptr::null_mut();
    };
    unsafe { sel_registerName(name.as_ptr()).cast::<c_void>() }
}

#[cfg(target_os = "macos")]
fn open_settings(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .status()
        .map_err(|error| format!("Failed to open System Settings: {error}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn accessibility_granted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

#[cfg(target_os = "macos")]
fn screen_recording_granted() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AECreateDesc(
        descriptor_type: u32,
        data_ptr: *const c_void,
        data_size: isize,
        result: *mut AEDesc,
    ) -> i32;
    fn AEDeterminePermissionToAutomateTarget(
        target: *const AEDesc,
        event_class: u32,
        event_id: u32,
        ask_user_if_needed: u8,
    ) -> i32;
    fn AEDisposeDesc(desc: *mut AEDesc) -> i32;
}

#[cfg(target_os = "macos")]
#[link(name = "objc")]
#[allow(clashing_extern_declarations)]
unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    #[link_name = "objc_msgSend"]
    fn objc_msg_send_i8(receiver: *mut ObjcObject, selector: *mut c_void) -> i8;
    #[link_name = "objc_msgSend"]
    fn objc_msg_send_id(receiver: *mut ObjcObject, selector: *mut c_void) -> *mut ObjcObject;
    #[link_name = "objc_msgSend"]
    fn objc_msg_send_id_char(
        receiver: *mut ObjcObject,
        selector: *mut c_void,
        arg: *const c_char,
    ) -> *mut ObjcObject;
    #[link_name = "objc_msgSend"]
    fn objc_msg_send_isize(receiver: *mut ObjcObject, selector: *mut c_void) -> isize;
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
    fn objc_msg_send_void_id(receiver: *mut ObjcObject, selector: *mut c_void, arg: *const c_void);
    #[link_name = "objc_msgSend"]
    fn objc_msg_send_void_id_id(
        receiver: *mut ObjcObject,
        selector: *mut c_void,
        arg1: *mut ObjcObject,
        arg2: *const c_void,
    );
    #[link_name = "objc_msgSend"]
    fn objc_msg_send_void_usize_id(
        receiver: *mut ObjcObject,
        selector: *mut c_void,
        arg1: usize,
        arg2: *const c_void,
    );
}

#[cfg(target_os = "macos")]
type DispatchQueue = *mut DispatchQueueObject;

#[cfg(target_os = "macos")]
#[repr(C)]
struct DispatchQueueObject {
    _private: [u8; 0],
}

#[cfg(target_os = "macos")]
#[link(name = "System", kind = "dylib")]
unsafe extern "C" {
    static mut _dispatch_main_q: DispatchQueueObject;
    fn dispatch_sync_f(
        queue: DispatchQueue,
        context: *mut c_void,
        work: extern "C" fn(*mut c_void),
    );
}

#[cfg(target_os = "macos")]
#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {}

#[cfg(target_os = "macos")]
#[link(name = "UserNotifications", kind = "framework")]
unsafe extern "C" {}

#[cfg(target_os = "macos")]
#[link(name = "Speech", kind = "framework")]
unsafe extern "C" {}

#[cfg(target_os = "macos")]
#[link(name = "CoreLocation", kind = "framework")]
unsafe extern "C" {}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct AEDesc {
    descriptor_type: u32,
    data_handle: *mut c_void,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct ObjcObject {
    _private: [u8; 0],
}

#[cfg(test)]
mod tests {
    use super::{notifications_supported_for_executable_path, status};
    use std::path::Path;
    use tokio::runtime::Runtime;

    #[test]
    fn notifications_support_rejects_dev_binary_paths() {
        assert!(!notifications_supported_for_executable_path(Path::new(
            "/Users/lan/Documents/New project 2/uniopc/src-tauri/target/debug/imai",
        )));
    }

    #[test]
    fn notifications_support_accepts_bundled_app_binaries() {
        assert!(notifications_supported_for_executable_path(Path::new(
            "/Applications/Uniopc.app/Contents/MacOS/Uniopc",
        )));
    }

    #[test]
    fn notifications_support_rejects_non_macos_bundle_layouts() {
        assert!(!notifications_supported_for_executable_path(Path::new(
            "/Applications/Uniopc.app/Contents/Resources/Uniopc",
        )));
    }

    #[test]
    fn status_disables_notifications_for_non_app_processes() {
        let runtime = Runtime::new().expect("runtime");
        let status = runtime.block_on(status()).expect("status");
        let notification = status
            .permissions
            .iter()
            .find(|permission| permission.id == "notifications")
            .expect("notifications permission");
        assert!(!notification.supported);
        assert!(!notification.granted);
    }
}
