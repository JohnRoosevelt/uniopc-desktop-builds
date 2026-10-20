import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ACTION, SURFACE, TEXT } from '../lib/theme'
import { supabase } from '../lib/supabase'
import {
  formatRecordingClock,
  isRecordingSupported,
  startAudioRecording,
} from '../lib/audioRecorder'
import {
  createTranscriptionUpload,
  documentTitleFromTranscript,
  fetchTranscriptionStatus,
  startTranscription,
  transcriptionStatusLabel,
  updateTranscriptionSpeakers,
  uploadTranscriptionAudio,
  waitForTranscription,
} from '../lib/voiceTranscription'

// 录音成文面板:录音 -> 上传 -> 转写 -> 给说话人贴名字 -> 交回 markdown。
//
// 落文档这一步不在这里做 —— 面板只负责产出 { markdown, title },由
// CloudDocuments 走它已有的「新建草稿 -> 编辑器 -> 保存」路径。录音只属于当前
// Owner 的个人文档，不再附带项目归属或成员权限。
//
// macOS 上额外并行跑一路 native_voice_input 只为显示实时字幕:它那道服务端
// 1 分钟上限对预览无所谓,断了就断了,录音本身完全不受影响。

const STEP = {
  record: 'record',
  working: 'working',
  // 上传/识别失败,但音频还在手里 —— 只丢一次网络请求,不丢用户说的话。
  retry: 'retry',
  speakers: 'speakers',
}

export default function VoiceToDocumentPanel({ memberNames = [], onCancel, onComplete, minimized = false, onMinimize, onExpand }) {
  const [step, setStep] = useState(STEP.record)
  const [recording, setRecording] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [livePartial, setLivePartial] = useState('')
  const [statusLabel, setStatusLabel] = useState('')
  const [job, setJob] = useState(null)
  const [speakerDraft, setSpeakerDraft] = useState({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const recorderRef = useRef(null)
  // 录完的音频留在这里,直到成功落库为止。以前它只是 handleStopRecording 里的
  // 局部变量,任何一次上传失败(网络抖动、令牌过期)都会让用户说的话永久消失
  // —— 一小时的会议丢过一次,这是不可接受的。
  const recordedRef = useRef(null)
  const startedAtRef = useRef(0)
  const disposedRef = useRef(false)
  const nativeCaptionRef = useRef(false)

  const supported = isRecordingSupported()

  // 面板卸载后一切副作用停手:轮询靠 shouldStop,录音靠 cancel。
  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      recorderRef.current?.cancel?.()
      recorderRef.current = null
      if (nativeCaptionRef.current) {
        invoke('native_voice_input_cancel').catch(() => {})
        nativeCaptionRef.current = false
      }
    }
  }, [])

  // 录音计时
  useEffect(() => {
    if (!recording) return undefined
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current)
    }, 200)
    return () => clearInterval(timer)
  }, [recording])

  // macOS 实时字幕。失败(Windows、未签名的 dev 二进制、无权限)一律静默降级
  // 成"只有计时没有字幕",绝不能因此打断录音。
  useEffect(() => {
    let unlisten = null
    let cancelled = false
    listen('native-voice-input-event', event => {
      if (cancelled) return
      const payload = event?.payload || {}
      const transcript = typeof payload.transcript === 'string' ? payload.transcript.trim() : ''
      if (payload.status === 'partial' || payload.status === 'final') setLivePartial(transcript)
      if (payload.status === 'error' || payload.status === 'stopped') setLivePartial('')
    })
      .then(dispose => {
        if (cancelled) dispose()
        else unlisten = dispose
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const fail = useCallback(reason => {
    if (disposedRef.current) return
    setError(String(reason?.message || reason || '录音转写失败'))
    setBusy(false)
    setStatusLabel('')
  }, [])

  async function handleStartRecording() {
    if (recording || busy) return
    setError('')
    setLivePartial('')
    try {
      const controller = await startAudioRecording()
      recorderRef.current = controller
      startedAtRef.current = Date.now()
      setElapsedMs(0)
      setRecording(true)
    } catch (err) {
      fail(err)
      return
    }
    // 字幕是加分项,起不来就算了。
    invoke('native_voice_input_start', { locale: 'zh-CN' })
      .then(() => {
        nativeCaptionRef.current = true
      })
      .catch(() => {})
  }

  async function handleStopRecording() {
    const controller = recorderRef.current
    if (!controller || !recording) return
    setRecording(false)
    if (nativeCaptionRef.current) {
      invoke('native_voice_input_stop').catch(() => {})
      nativeCaptionRef.current = false
    }
    setLivePartial('')

    let recorded = null
    try {
      recorded = await controller.stop()
    } catch (err) {
      fail(err)
      return
    } finally {
      recorderRef.current = null
    }

    if (!recorded?.blob?.size) {
      fail('没有录到声音,请检查麦克风后重试')
      return
    }

    recordedRef.current = recorded
    await runTranscriptionPipeline()
  }

  /** 上传 → 提交 → 轮询。音频留在 recordedRef 里,失败后可原样重试。 */
  async function runTranscriptionPipeline() {
    const recorded = recordedRef.current
    if (!recorded?.blob?.size) {
      fail('录音数据已丢失,请重新录制')
      return
    }

    setStep(STEP.working)
    setBusy(true)
    // 重试是同一个函数再进一次 —— 不清掉上一轮的报错,界面上会出现
    // 「正在上传录音…」和旧错误同屏,像是正在失败。
    setError('')
    try {
      setStatusLabel('正在上传录音…')
      const upload = await createTranscriptionUpload(supabase, {
        contentType: recorded.contentType,
      })
      await uploadTranscriptionAudio(supabase, upload, recorded.blob)
      if (disposedRef.current) return

      setStatusLabel('已提交,等待识别…')
      await startTranscription(supabase, upload.jobId)

      const finished = await waitForTranscription(upload.jobId, {
        fetchStatus: jobId => fetchTranscriptionStatus(supabase, jobId),
        shouldStop: () => disposedRef.current,
        onTick: value => setStatusLabel(transcriptionStatusLabel(value?.status)),
      })
      if (!finished || disposedRef.current) return

      if (finished.status !== 'succeeded') {
        fail(finished.errorMessage || '识别失败,请重试')
        setStep(STEP.retry)
        return
      }

      setJob(finished)
      setStatusLabel('')
      // 没有说话人(没开分离或全程一个人)就跳过贴名字那一步。
      if ((finished.speakers || []).length === 0) {
        setStatusLabel('正在保存文档…')
        await onComplete?.({ markdown: finished.markdown, title: documentTitleFromTranscript(finished), jobId: finished.jobId })
        recordedRef.current = null
        setBusy(false)
        return
      }
      setBusy(false)
      setStep(STEP.speakers)
    } catch (err) {
      // 关键:不清 recordedRef —— 音频还在,用户可以直接重试,不必重录。
      fail(err)
      setStep(STEP.retry)
    }
  }

  async function handleConfirmSpeakers() {
    if (!job || busy) return
    setBusy(true)
    setError('')
    try {
      const named = await updateTranscriptionSpeakers(supabase, job.jobId, speakerDraft)
      if (disposedRef.current) return
      await onComplete?.({ markdown: named.markdown, title: documentTitleFromTranscript(named), jobId: named.jobId })
      recordedRef.current = null
      setBusy(false)
    } catch (err) {
      fail(err)
    }
  }

  function handleCancel() {
    if ((recording || recordedRef.current?.blob?.size || busy) && !window.confirm('还有一段未上传的录音,关闭后就找不回来了。确定关闭吗?')) return
    recordedRef.current = null
    recorderRef.current?.cancel?.()
    recorderRef.current = null
    if (nativeCaptionRef.current) {
      invoke('native_voice_input_cancel').catch(() => {})
      nativeCaptionRef.current = false
    }
    onCancel?.()
  }

  const canMinimize = recording || step === STEP.working || step === STEP.retry || step === STEP.speakers

  return (
    <>
      {minimized && (
        <div className={`${SURFACE.modal} fixed bottom-5 right-5 z-40 flex items-center gap-3 p-3 shadow-lg`}>
          <button type="button" onClick={onExpand} className="text-left">
            <div className="text-sm font-medium text-primary">{recording ? '正在录音' : statusLabel || '录音成文'}</div>
            <div className={`text-xs tabular-nums ${TEXT.muted}`}>{formatRecordingClock(elapsedMs)}</div>
          </button>
          {recording && (
            <button type="button" onClick={handleStopRecording} className={ACTION.primary}>
              结束并转写
            </button>
          )}
        </div>
      )}

      {!minimized && (
        <div className={`${SURFACE.modal} w-full max-w-md space-y-5 p-5`} onClick={event => event.stopPropagation()}>
      <div>
        <h2 className="text-lg font-semibold text-primary">录音成文</h2>
        <p className={`mt-1 text-sm ${TEXT.muted}`}>
          录一段话,自动转成带说话人的文档草稿。录完可以在编辑器里继续改。
        </p>
      </div>

      {!supported && (
        <div className={`${SURFACE.panelSoft} px-3 py-2 text-sm ${TEXT.secondary}`}>
          当前环境没有可用的麦克风接口,无法录音。
        </div>
      )}

      {step === STEP.record && (
        <div className="space-y-4">
          <div className={`${SURFACE.inset} flex flex-col items-center gap-3 px-4 py-6`}>
            <button
              type="button"
              onClick={recording ? handleStopRecording : handleStartRecording}
              disabled={!supported || busy}
              aria-label={recording ? '停止录音' : '开始录音'}
              className={`inline-flex h-16 w-16 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${
                recording
                  ? 'bg-state-selected text-accent-text ring-2 ring-brand/40 motion-safe:animate-pulse'
                  : 'bg-brand text-white hover:bg-brand-strong'
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {recording ? (
                  <rect x="7" y="7" width="10" height="10" rx="2" />
                ) : (
                  <>
                    <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <path d="M12 19v3" />
                  </>
                )}
              </svg>
            </button>
            <div className="text-2xl font-semibold tabular-nums text-primary">{formatRecordingClock(elapsedMs)}</div>
            <div className={`text-xs ${TEXT.muted}`}>{recording ? '正在录音' : '点击开始录音'}</div>
            {recording && (
              <div className={`text-xs ${TEXT.muted}`}>文字会在结束后统一生成</div>
            )}
          </div>

          {livePartial && (
            <div className={`${SURFACE.panelSoft} max-h-24 overflow-y-auto px-3 py-2 text-sm ${TEXT.secondary}`}>
              {livePartial}
            </div>
          )}
        </div>
      )}

      {step === STEP.retry && (
        <div className={`${SURFACE.inset} space-y-2 px-4 py-5 text-center`}>
          <div className="text-sm font-medium text-primary">上传失败,但录音还在</div>
          <div className={`text-xs ${TEXT.muted}`}>
            {formatRecordingClock(elapsedMs)} 的录音已保留在本地,点「重试上传」即可继续,不用重录。
          </div>
        </div>
      )}

      {step === STEP.working && (
        <div className={`${SURFACE.inset} space-y-2 px-4 py-6 text-center`}>
          <div className="text-sm font-medium text-primary">{statusLabel || '处理中…'}</div>
          <div className={`text-xs ${TEXT.muted}`}>时长越长识别越久,这个窗口可以一直开着。</div>
        </div>
      )}

      {step === STEP.speakers && job && (
        <div className="space-y-3">
          <div className={`text-sm ${TEXT.secondary}`}>
            识别到 {job.speakers.length} 位说话人。给他们起个名字,纪要才读得下去。
          </div>
          <datalist id="voice-speaker-name-options">
            {memberNames.map(name => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
            {job.speakers.map(speaker => {
              const sample = (job.segments || []).find(segment => segment.speakerId === speaker.id)
              return (
                <div key={speaker.id} className={`${SURFACE.panelSoft} space-y-2 px-3 py-2`}>
                  <input
                    className={SURFACE.input}
                    list="voice-speaker-name-options"
                    placeholder={speaker.label}
                    value={speakerDraft[speaker.id] || ''}
                    onChange={event => setSpeakerDraft(prev => ({ ...prev, [speaker.id]: event.target.value }))}
                  />
                  {sample && (
                    <div className={`line-clamp-2 text-xs ${TEXT.muted}`}>「{sample.text}」</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {error && (
        <div className={`${SURFACE.panelSoft} px-3 py-2 text-sm text-danger-text`}>{error}</div>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={handleCancel} className={ACTION.secondary}>
          取消
        </button>
        {canMinimize && (
          <button type="button" onClick={() => onMinimize?.()} className={ACTION.secondary}>
            最小化
          </button>
        )}
        {/* 主操作必须出现在 footer。原本只把它做成圆钮的图标态(麦克风↔方块),
            用户的视线习惯性落在右下角,结果那里只有「取消」—— 真机测试第一次
            就卡在这里,不知道怎么结束录音。 */}
        {step === STEP.record && recording && (
          <button type="button" onClick={handleStopRecording} disabled={busy} className={ACTION.primary}>
            结束并转写
          </button>
        )}
        {step === STEP.retry && (
          <button type="button" onClick={runTranscriptionPipeline} disabled={busy} className={ACTION.primary}>
            重试上传
          </button>
        )}
        {step === STEP.speakers && (
          <button type="button" onClick={handleConfirmSpeakers} disabled={busy} className={ACTION.primary}>
            生成文档
          </button>
        )}
      </div>
        </div>
      )}
    </>
  )
}
