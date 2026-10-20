// webview 录音层。
//
// 两个平台的 MediaRecorder 产物不一样,这是这层存在的主要理由:
//   macOS / WKWebView  只能写 mp4(AAC),不支持 webm / opus
//   Windows / WebView2 是 Chromium,出 webm(opus)
// 所以必须 isTypeSupported 探测,不能写死。
//
// channelCount:1 是硬要求 —— 上游的说话人分离只支持单声道,立体声进去会直接
// 被拒或者分离结果错乱。

/** 探测顺序:opus 体积最小放最前,mp4/AAC 是 macOS 的唯一选择。 */
export const PREFERRED_AUDIO_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
]

/** 说话人分离只支持单声道,这里是整条链路的源头,不能改。 */
export const AUDIO_CONSTRAINTS = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

/**
 * 选一个当前 webview 真的支持的录音容器。
 * 全都不支持时返回空串 —— 交给浏览器用它自己的默认值,而不是硬塞一个会抛错的。
 */
export function pickRecorderMimeType(isTypeSupported, candidates = PREFERRED_AUDIO_MIME_TYPES) {
  if (typeof isTypeSupported !== 'function') return ''
  for (const candidate of candidates) {
    try {
      if (isTypeSupported(candidate)) return candidate
    } catch {
      // isTypeSupported 对畸形字符串可能抛错,跳过继续探
    }
  }
  return ''
}

/** 'audio/webm;codecs=opus' -> 'audio/webm'(存储桶的 allowed_mime_types 只认基础类型)。 */
export function contentTypeFromMimeType(mimeType, fallback = 'audio/mp4') {
  const base = String(mimeType || '').split(';')[0].trim().toLowerCase()
  return base || fallback
}

/** 录音时长展示用。和服务端 formatClock 的规则保持一致。 */
export function formatRecordingClock(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = Math.floor(total % 60)
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

export function isRecordingSupported(deps = {}) {
  const mediaDevices = deps.mediaDevices || (typeof navigator !== 'undefined' ? navigator.mediaDevices : null)
  const RecorderCtor = deps.MediaRecorderCtor || (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null)
  return Boolean(mediaDevices?.getUserMedia && RecorderCtor)
}

/**
 * 起一段录音。依赖全部可注入,方便在 node 里跑单测(没有真 webview)。
 *
 * 返回的 controller:
 *   stop()   -> Promise<{ blob, contentType, durationMs }>
 *   cancel() 丢弃并释放麦克风
 */
export async function startAudioRecording(deps = {}) {
  const mediaDevices = deps.mediaDevices || (typeof navigator !== 'undefined' ? navigator.mediaDevices : null)
  const RecorderCtor = deps.MediaRecorderCtor || (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null)
  const now = deps.now || (() => Date.now())
  if (!mediaDevices?.getUserMedia) throw new Error('当前环境不支持录音(没有麦克风接口)')
  if (!RecorderCtor) throw new Error('当前环境不支持录音(没有 MediaRecorder)')

  const stream = await mediaDevices.getUserMedia({ audio: { ...AUDIO_CONSTRAINTS }, video: false })
  const mimeType = pickRecorderMimeType(RecorderCtor.isTypeSupported)
  const recorder = new RecorderCtor(stream, mimeType ? { mimeType } : undefined)
  const chunks = []
  const startedAt = now()
  let stopped = false

  recorder.ondataavailable = event => {
    if (event?.data && event.data.size > 0) chunks.push(event.data)
  }

  const stopTracks = () => {
    for (const track of stream.getTracks?.() || []) {
      try {
        track.stop()
      } catch {
        // 轨道可能已经结束,忽略
      }
    }
  }

  recorder.start()

  return {
    mimeType,
    contentType: contentTypeFromMimeType(recorder.mimeType || mimeType),
    startedAt,
    get state() {
      return recorder.state
    },
    stop() {
      if (stopped) return Promise.reject(new Error('录音已经停止'))
      stopped = true
      return new Promise((resolve, reject) => {
        recorder.onerror = event => {
          stopTracks()
          reject(new Error(String(event?.error?.message || '录音失败')))
        }
        recorder.onstop = () => {
          stopTracks()
          const contentType = contentTypeFromMimeType(recorder.mimeType || mimeType)
          const BlobCtor = deps.BlobCtor || (typeof Blob !== 'undefined' ? Blob : null)
          if (!BlobCtor) {
            reject(new Error('当前环境不支持 Blob'))
            return
          }
          resolve({
            blob: new BlobCtor(chunks, { type: contentType }),
            contentType,
            durationMs: Math.max(0, now() - startedAt),
          })
        }
        recorder.stop()
      })
    },
    cancel() {
      stopped = true
      try {
        if (recorder.state !== 'inactive') recorder.stop()
      } catch {
        // 已经停了就算了
      }
      stopTracks()
    },
  }
}
