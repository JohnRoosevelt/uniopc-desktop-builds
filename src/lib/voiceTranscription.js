// transcribe Edge Function 的客户端封装 + 轮询状态机。
//
// 链路:签名直传 URL -> 音频直传 storage(不经过 Edge Function)-> 提交上游
// 作业 -> 轮询 -> 归一化结果 + 服务端渲染好的 markdown -> 落 BlockSuite 文档。
//
// 这个模块**不 import supabase 单例** —— 和 cloudDocuments.js 一样,client 由
// 调用方传进来。否则 node --test 一加载就会撞上 import.meta.env。

export const TRANSCRIBE_FUNCTION = 'transcribe'
export const TRANSCRIPTION_BUCKET = 'voice-transcriptions'

/** 终态:轮询到这几个就停。 */
export const TERMINAL_TRANSCRIPTION_STATUSES = ['succeeded', 'failed', 'cancelled']

export function isTerminalTranscriptionStatus(status) {
  return TERMINAL_TRANSCRIPTION_STATUSES.includes(String(status || ''))
}

/**
 * 轮询退避。开头快一点让短录音秒回,之后退到 5s 封顶 —— 一小时的会议要轮
 * 很久,每秒打一次纯属浪费。
 */
export function transcriptionPollDelayMs(attempt) {
  const ladder = [1000, 1000, 2000, 3000, 5000]
  const index = Math.max(0, Math.min(Math.trunc(Number(attempt) || 0), ladder.length - 1))
  return ladder[index]
}

/** 贴名字表单 -> 提交给后端的 { spk_0: '张三' },空值不提交(留着用默认标签)。 */
export function speakerNamesFromDraft(draft = {}) {
  const names = {}
  for (const [speakerId, value] of Object.entries(draft || {})) {
    const name = String(value || '').trim()
    if (speakerId && name) names[speakerId] = name
  }
  return names
}

/** 从转写结果推一个文档标题:第一段话的前 20 个字,兜底用传入的默认值。 */
export function documentTitleFromTranscript(job = {}, fallback = '录音转写') {
  const segments = Array.isArray(job?.segments) ? job.segments : []
  const first = String(segments[0]?.text || '').trim()
  if (!first) return fallback
  const clipped = first.replace(/\s+/g, ' ').slice(0, 20)
  return clipped.length < first.replace(/\s+/g, ' ').length ? `${clipped}…` : clipped
}

/** 转写进度文案。状态机就这几档,集中在一处免得 UI 各写各的。 */
export function transcriptionStatusLabel(status) {
  switch (String(status || '')) {
    case 'uploading':
      return '正在上传录音…'
    case 'queued':
      return '已排队,等待识别…'
    case 'processing':
      return '正在识别(长录音需要几分钟)…'
    case 'succeeded':
      return '识别完成'
    case 'failed':
      return '识别失败'
    case 'cancelled':
      return '已取消'
    default:
      return '处理中…'
  }
}

/** 令牌剩余寿命低于这个阈值就先续期,别拿一个马上要过期的 token 去发大请求。 */
export const SESSION_REFRESH_MARGIN_SECONDS = 300

/**
 * 上传大文件前要求的最低令牌寿命。网关会把整个请求体收完才交给 storage 校验,
 * 所以令牌必须活过整个传输过程:163MB 实测 79 秒,慢网翻十倍也该在半小时内。
 */
export const UPLOAD_SESSION_MARGIN_SECONDS = 1800

/**
 * 取一个「够新」的 access token。
 *
 * 录音可能持续一小时,而 Supabase 的 access token 默认就是 1 小时 —— 录完再去
 * 上传时,手里那个 token 很可能刚好过期,服务端回 `"exp" claim timestamp check
 * failed`。supabase-js 的自动续期在网络抖动时也会失败,所以这里显式判临期并续。
 */
export async function freshAccessToken(client, marginSeconds = SESSION_REFRESH_MARGIN_SECONDS) {
  const { data } = await client.auth.getSession()
  const session = data?.session
  if (!session?.access_token) throw new Error('请先登录')

  const expiresAt = Number(session.expires_at) || 0
  const secondsLeft = expiresAt ? expiresAt - Math.floor(Date.now() / 1000) : Infinity
  if (secondsLeft > marginSeconds) return session.access_token

  const refreshed = await client.auth.refreshSession()
  const nextToken = refreshed?.data?.session?.access_token
  if (nextToken) return nextToken
  // 续期失败(常见于断网):把旧 token 交出去,让服务端给出真实原因,
  // 而不是在这里编一个。
  return session.access_token
}

export async function callTranscribe(client, action, payload = {}) {
  const token = await freshAccessToken(client)

  const { data, error } = await client.functions.invoke(TRANSCRIBE_FUNCTION, {
    body: { action, payload },
    headers: { Authorization: `Bearer ${token}` },
  })
  if (error) throw await functionError(error)
  if (data?.error) throw new Error(String(data.error))
  return data
}

/**
 * supabase-js 对非 2xx 只给一句 "Edge Function returned a non-2xx status code",
 * 真正的原因在 error.context(那个 Response)的 body 里。不读出来的话,线上任何
 * 失败在界面上都长一个样,没法排查。
 */
async function functionError(error) {
  const context = error?.context
  try {
    if (context && typeof context.json === 'function') {
      const payload = await context.json()
      if (payload?.error) {
        const next = new Error(String(payload.error))
        next.cause = error
        return next
      }
    }
  } catch {
    // body 读不出来就退回原始信息
  }
  return new Error(String(error?.message || '转写服务调用失败'))
}

export async function createTranscriptionUpload(client, input = {}) {
  return callTranscribe(client, 'create_transcription_upload', {
    contentType: input.contentType || 'audio/mp4',
    title: input.title || '',
    diarizationEnabled: input.diarizationEnabled !== false,
    speakerCount: Number(input.speakerCount) || 0,
    languageHints: Array.isArray(input.languageHints) ? input.languageHints : ['zh', 'en'],
  })
}

/**
 * 音频直传 storage —— 用登录令牌走认证上传,**不能改回签名上传 URL**。
 *
 * 阿里云 opentrust 的 storage 给签名上传 token 的有效期只有 60 秒(标准
 * Supabase 是 2 小时,`expiresIn` 参数也被无视),而网关会把整个请求体收完
 * 才交给 storage 校验 —— 传输超过 60 秒的长录音必被判过期,回
 * `"exp" claim timestamp check failed`,且重试永远失败。2026-07-28 一段
 * 163MB/传输 79 秒的真机录音把这条路彻底钉死。
 *
 * 认证上传靠 storage 的 RLS 策略放行(voice-transcriptions 桶,只许写自己
 * `auth.uid()` 目录);令牌由 supabase-js 在请求发出时注入当前会话的
 * access token,这里先把会话续到至少还剩 UPLOAD_SESSION_MARGIN_SECONDS,
 * 慢网大文件也传得完。
 */
export async function uploadTranscriptionAudio(client, upload, blob) {
  const storagePath = String(upload?.storagePath || '')
  if (!storagePath) throw new Error('上传凭据缺失')
  const bucket = String(upload?.bucket || TRANSCRIPTION_BUCKET)
  // 续期是副作用:storage 请求的 Authorization 头由 supabase-js 按当前会话注入。
  await freshAccessToken(client, UPLOAD_SESSION_MARGIN_SECONDS)
  const { error } = await client.storage
    .from(bucket)
    .upload(storagePath, blob, {
      contentType: upload?.contentType || blob?.type || 'audio/mp4',
      upsert: false,
    })
  if (error) throw new Error(String(error.message || '音频上传失败'))
  return { storagePath, bucket }
}

export async function startTranscription(client, jobId) {
  return callTranscribe(client, 'start_transcription', { jobId })
}

export async function fetchTranscriptionStatus(client, jobId) {
  return callTranscribe(client, 'transcription_status', { jobId })
}

export async function updateTranscriptionSpeakers(client, jobId, speakerNames) {
  return callTranscribe(client, 'update_transcription_speakers', {
    jobId,
    speakerNames: speakerNamesFromDraft(speakerNames),
  })
}

export async function deleteTranscription(client, jobId) {
  return callTranscribe(client, 'delete_transcription', { jobId })
}

export async function listTranscriptions(client) {
  return callTranscribe(client, 'list_transcriptions', {})
}

export async function fetchTranscriptionAudio(client, jobId) {
  return callTranscribe(client, 'get_transcription_audio', { jobId })
}

/**
 * 取原录音并转成可播放的 blob: URL。
 *
 * 为什么不把签名 URL 直接塞进 <audio src>:CSP 的 media-src 只有
 * `'self' asset: http://asset.localhost blob:`,不含存储域名,直接放会被拦。
 * 而 connect-src 放行了该域名,所以 fetch 下来转 blob: 是唯一不用改 CSP 的路。
 *
 * 代价是整段音频要先下完才能播。长录音(一小时约 100MB)体验会差,那时候
 * 得改成把存储域名加进 media-src 直接流式播放。
 */
export async function loadTranscriptionAudioUrl(client, jobId, options = {}) {
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null)
  const createObjectUrl = options.createObjectUrl
    || (typeof URL !== 'undefined' && URL.createObjectURL ? value => URL.createObjectURL(value) : null)
  if (!fetchImpl || !createObjectUrl) throw new Error('当前环境不支持音频回放')

  const info = await fetchTranscriptionAudio(client, jobId)
  const response = await fetchImpl(info.audioUrl)
  if (!response.ok) throw new Error(`音频下载失败(${response.status})`)
  const blob = await response.blob()
  return {
    objectUrl: createObjectUrl(blob),
    contentType: info.contentType || 'audio/webm',
    durationMs: Number(info.durationMs) || 0,
  }
}

/** 文档 metadata 里记录来源录音的字段名。存在即说明这篇文档可以回放。 */
export const TRANSCRIPTION_JOB_METADATA_KEY = 'transcription_job_id'

export function transcriptionJobIdOfDocument(document) {
  return String(document?.metadata?.[TRANSCRIPTION_JOB_METADATA_KEY] || '').trim()
}

/**
 * 轮到终态为止。依赖可注入,单测里不需要真的等。
 *
 * shouldStop 让调用方随时中断(关面板、切页),中断后返回 null,调用方据此
 * 不再更新任何组件状态 —— 避免卸载后 setState。
 */
export async function waitForTranscription(jobId, options = {}) {
  const fetchStatus = options.fetchStatus
  if (typeof fetchStatus !== 'function') throw new Error('waitForTranscription 需要 fetchStatus')
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const shouldStop = options.shouldStop || (() => false)
  const onTick = options.onTick || (() => {})
  const maxAttempts = Number(options.maxAttempts) || 720 // 5s 封顶 * 720 ≈ 1 小时

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (shouldStop()) return null
    const job = await fetchStatus(jobId)
    // 请求飞在路上时面板可能已经关了 —— 抢在 onTick 之前再判一次,
    // 否则会对着已卸载的组件 setState。
    if (shouldStop()) return null
    onTick(job, attempt)
    if (isTerminalTranscriptionStatus(job?.status)) return job
    if (shouldStop()) return null
    await sleep(transcriptionPollDelayMs(attempt))
  }
  throw new Error('转写超时,请稍后在转写记录里查看结果')
}
