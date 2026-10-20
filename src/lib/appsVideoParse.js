/**
 * 视频解析（视频 → 音频 → 音频理解）—— 小程序 utils/videoParse.js 的桌面移植。
 *
 * 链路和小程序完全一致：
 *   operator_get_media_download_url 拿签名地址
 *     → video-to-audio convert（失败则 prepare_upload → PUT → convert(sourceKey)）
 *     → 轮询 query 到 succeeded
 *     → audio-understanding analyze_fragments → 轮询 query
 * 历史与「查看解析」优先走 PostgREST（RLS 自读），edge 的 list/latest_by_post 只是回退，
 * 因为那两个 action 在部分环境上还没部署。
 */
import { callMedia, restGet, safeArray } from './appsBackend'
import { callAudioUnderstanding, callVideoToAudio } from './privateConversionService'

const DEFAULT_POLL_INTERVAL_MS = 4000
const DEFAULT_POLL_TIMEOUT_MS = 15 * 60 * 1000

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = value => String(value).padStart(2, '0')
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`
  return `${pad(minutes)}:${pad(secs)}`
}

/** OSS/edge 的 Request header 不收非 ASCII 文件名，中文只留在 postTitle 里 */
function asciiSafeFileName(name, fallbackExt = 'mp4') {
  const raw = String(name || '').trim() || `video.${fallbackExt}`
  const extMatch = raw.match(/\.([a-z0-9]{1,8})$/i)
  const ext = (extMatch ? extMatch[1] : fallbackExt).toLowerCase()
  const base = raw.replace(/\.[a-z0-9]{1,8}$/i, '')
  const safe = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${safe || 'video'}.${ext}`
}

export function mapFragment(item = {}, index = 0) {
  const start = Number(item.start != null ? item.start : item.start_time != null ? item.start_time : 0)
  const end = Number(item.end != null ? item.end : item.end_time != null ? item.end_time : start)
  const channelId = item.channelId != null ? item.channelId : item.channel_id != null ? item.channel_id : null
  const body = String(item.text || item.content || '').trim()
  return {
    id: `${index}-${start}-${end}-${channelId == null ? 'x' : channelId}`,
    start,
    end,
    text: body,
    duration: item.duration || `${Math.max(0, end - start).toFixed(1)}s`,
    channelId,
    channelText: channelId == null ? '通道 —' : `通道 ${channelId}`,
    timeText: `${formatClock(start)} - ${formatClock(end)}`,
  }
}

export function extractFragments(result = {}) {
  const list = result.fragments ||
    (result.result && (result.result.fragments || result.result.segments)) ||
    result.segments ||
    []
  return (Array.isArray(list) ? list : []).map(mapFragment)
}

async function pollUntilSettled(queryFn, options = {}) {
  const intervalMs = options.intervalMs || DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs || DEFAULT_POLL_TIMEOUT_MS
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const startedAt = Date.now()
  let last = null

  while (Date.now() - startedAt < timeoutMs) {
    last = await queryFn()
    const status = String((last && last.status) || '').toLowerCase()
    if (onProgress) onProgress(last)
    if (status === 'succeeded') return last
    if (status === 'failed' || status === 'cancelled') {
      const message = (last.error && (last.error.message || last.error.code)) || `task_${status || 'failed'}`
      const error = new Error(message)
      error.code = (last.error && last.error.code) || status
      error.data = last
      throw error
    }
    await sleep(intervalMs)
  }

  const error = new Error('解析超时，请稍后重试')
  error.code = 'poll_timeout'
  error.data = last
  throw error
}

function postContextFromOptions(options = {}) {
  const post = options.post || {}
  const postId = String(options.postId || post.id || post.postId || '').trim()
  const postTitle = String(options.postTitle || post.title || options.fileName || '').trim()
  const coverUrl = String(options.coverUrl || post.coverUrl || post.cover_url || '').trim()
  const ownerId = String(options.ownerId || post.ownerId || post.owner_id || '').trim()
  const out = {}
  if (postId) out.postId = postId
  if (postTitle) out.postTitle = postTitle
  if (coverUrl) out.coverUrl = coverUrl
  if (ownerId) out.ownerId = ownerId
  return out
}

/** 从 DB 的 media key/bucket 换一个可访问的签名/公开地址 */
async function resolveMediaDownload(post = {}) {
  const postId = String(post.id || post.postId || '').trim()
  const mediaAssetId = String(post.mediaAssetId || post.media_asset_id || '').trim()
  const fallbackUrl = String(post.videoUrl || post.video || '').trim()

  if (postId || mediaAssetId) {
    try {
      // 走 media：OSS 素材现签一条下载地址，历史的 Supabase 素材原样回退到永久公开 URL。
      const result = await callMedia('operator_get_media_download_url', {
        postId,
        mediaAssetId,
        expiresInSeconds: 7200,
      })
      const signedUrl = String(result.signedUrl || result.signed_url || '').trim()
      const publicUrl = String(result.publicUrl || result.public_url || fallbackUrl || '').trim()
      const videoUrl = signedUrl || publicUrl
      if (!videoUrl) {
        const error = new Error('无法获取视频下载地址')
        error.code = 'media_download_url_missing'
        throw error
      }
      return {
        videoUrl,
        fileName: asciiSafeFileName(result.fileName || result.file_name || `${String(post.title || 'video').slice(0, 40)}.mp4`),
        mimeType: result.mimeType || result.mime_type || 'video/mp4',
      }
    } catch (error) {
      // 老的 private-conversion 构建还没有签名下载 action
      if (!/^https?:\/\//i.test(fallbackUrl)) throw error
    }
  }

  if (!/^https?:\/\//i.test(fallbackUrl)) {
    const error = new Error('视频地址无效')
    error.code = 'invalid_video_url'
    throw error
  }
  return {
    videoUrl: fallbackUrl,
    fileName: asciiSafeFileName(`${String(post.title || 'video').slice(0, 40)}.mp4`),
    mimeType: 'video/mp4',
  }
}

async function convertViaPrepareUpload(videoUrl, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const fileName = options.fileName || 'video.mp4'
  const mimeType = options.mimeType || 'video/mp4'
  const postContext = postContextFromOptions(options)

  onProgress({ stage: 'upload', message: '正在下载视频到本地…' })
  const download = await fetch(videoUrl)
  if (!download.ok) throw new Error(`download_http_${download.status}`)
  const bytes = new Uint8Array(await download.arrayBuffer())

  onProgress({ stage: 'upload', message: '正在准备转音频上传…' })
  const prepared = await callVideoToAudio('prepare_upload', {
    fileName,
    mimeType,
    expiresInSeconds: 7200,
    ...postContext,
  })
  const sourceKey = prepared.key || prepared.path || prepared.sourceKey
  const signedUrl = prepared.signedUrl || prepared.signed_url
  if (!sourceKey || !signedUrl) {
    const error = new Error('prepare_upload 未返回上传地址')
    error.code = 'prepare_upload_failed'
    error.data = prepared
    throw error
  }

  onProgress({ stage: 'upload', message: '正在上传视频到转音频存储…' })
  const headers = { ...(prepared.uploadHeaders || prepared.upload_headers || {}) }
  if (!headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = prepared.mimeType || prepared.mime_type || mimeType
  }
  const uploaded = await fetch(signedUrl, { method: 'PUT', headers, body: bytes })
  if (!uploaded.ok) throw new Error(`upload_http_${uploaded.status}`)

  onProgress({ stage: 'convert', message: '正在提交视频转音频…' })
  return callVideoToAudio('convert', {
    sourceKey,
    sourceBucket: prepared.bucket,
    audioContainer: options.audioContainer || 'mp3',
    fileName,
    mimeType,
    ...postContext,
  })
}

async function startVideoToAudio(videoUrl, options = {}) {
  try {
    return await callVideoToAudio('convert', {
      videoUrl,
      audioContainer: options.audioContainer || 'mp3',
      fileName: options.fileName || 'video.mp4',
      mimeType: options.mimeType || 'video/mp4',
      ...postContextFromOptions(options),
    })
  } catch (error) {
    // 老的 video-to-audio 构建忽略 videoUrl，返回 video_source_required；
    // 回退到 prepare_upload → PUT → convert(sourceKey)。
    const code = error && error.code
    const message = String((error && error.message) || '')
    const shouldFallback = code === 'video_source_required' ||
      /prepare_upload|sourceKey|ossUri|video_source_required/i.test(message)
    if (!shouldFallback) throw error
    return convertViaPrepareUpload(videoUrl, options)
  }
}

export async function parseVideo(postOrUrl, options = {}) {
  const post = typeof postOrUrl === 'string' ? { videoUrl: postOrUrl, title: options.fileName } : (postOrUrl || {})
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const postContext = postContextFromOptions({
    ...options,
    post,
    postId: options.postId || post.id || post.postId,
    postTitle: options.postTitle || post.title,
    coverUrl: options.coverUrl || post.coverUrl,
    ownerId: options.ownerId || post.ownerId,
  })

  onProgress({ stage: 'resolve', message: '正在获取视频签名地址…' })
  const media = await resolveMediaDownload(post)
  const fileName = asciiSafeFileName(options.fileName || media.fileName || 'video.mp4')

  onProgress({ stage: 'convert', message: '正在提交视频转音频…' })
  const convertResult = await startVideoToAudio(media.videoUrl, {
    ...options,
    ...postContext,
    post,
    fileName,
    mimeType: media.mimeType,
    onProgress,
  })
  const videoTaskId = convertResult.taskId || convertResult.task_id
  if (!videoTaskId) {
    const error = new Error((convertResult.error && convertResult.error.message) || '视频转音频提交失败')
    error.code = (convertResult.error && convertResult.error.code) || 'convert_failed'
    throw error
  }
  if (convertResult.ok === false || String(convertResult.status || '').toLowerCase() === 'failed') {
    const error = new Error((convertResult.error && convertResult.error.message) || '视频转音频失败')
    error.code = (convertResult.error && convertResult.error.code) || 'convert_failed'
    throw error
  }

  onProgress({ stage: 'convert', message: '视频转音频处理中…' })
  const videoDone = await pollUntilSettled(
    () => callVideoToAudio('query', { taskId: videoTaskId, includeSignedUrl: false }),
    {
      intervalMs: options.pollIntervalMs,
      timeoutMs: options.pollTimeoutMs,
      onProgress: () => onProgress({ stage: 'convert', message: '视频转音频处理中…' }),
    },
  )

  const audio = videoDone.audio || {}
  const audioKey = audio.key || audio.sourceKey || audio.source_key || ''
  const audioBucket = audio.bucket || audio.sourceBucket || audio.source_bucket || ''
  if (!audioKey) {
    const error = new Error('转音频成功但未返回音频对象')
    error.code = 'audio_missing'
    throw error
  }

  onProgress({ stage: 'analyze', message: '正在提交音频理解…' })
  const analyzePayload = { sourceKey: audioKey, fragments: true, videoTaskId, ...postContext }
  if (audioBucket) analyzePayload.sourceBucket = audioBucket
  if (audio.contentType || audio.content_type) {
    analyzePayload.mimeType = audio.contentType || audio.content_type
  }

  const analyzeResult = await callAudioUnderstanding('analyze_fragments', analyzePayload)
  const audioTaskId = analyzeResult.taskId || analyzeResult.task_id
  if (!audioTaskId) {
    const error = new Error((analyzeResult.error && analyzeResult.error.message) || '音频理解提交失败')
    error.code = (analyzeResult.error && analyzeResult.error.code) || 'analyze_failed'
    throw error
  }
  if (analyzeResult.ok === false || String(analyzeResult.status || '').toLowerCase() === 'failed') {
    const error = new Error((analyzeResult.error && analyzeResult.error.message) || '音频理解失败')
    error.code = (analyzeResult.error && analyzeResult.error.code) || 'analyze_failed'
    throw error
  }

  onProgress({ stage: 'analyze', message: '音频理解处理中…' })
  const audioDone = await pollUntilSettled(
    () => callAudioUnderstanding('query', { taskId: audioTaskId }),
    {
      intervalMs: options.pollIntervalMs,
      timeoutMs: options.pollTimeoutMs,
      onProgress: () => onProgress({ stage: 'analyze', message: '音频理解处理中…' }),
    },
  )

  const transcript = String(
    audioDone.transcript ||
    audioDone.text ||
    (audioDone.result && (audioDone.result.transcript || audioDone.result.text)) ||
    '',
  ).trim()

  onProgress({ stage: 'done', message: '解析完成' })

  return { videoTaskId, audioTaskId, transcript, fragments: extractFragments(audioDone) }
}

function statusTextFromStatus(status) {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'succeeded') return '已完成'
  if (normalized === 'failed') return '失败'
  if (normalized === 'cancelled') return '已取消'
  if (normalized === 'processing') return '处理中'
  if (normalized === 'queued') return '排队中'
  return status || '未知'
}

export function mapHistoryItem(item = {}) {
  const status = String(item.status || '').toLowerCase()
  return {
    taskId: item.taskId || item.task_id || item.id || '',
    status,
    statusText: item.statusText || statusTextFromStatus(status),
    postId: item.postId || item.post_id || '',
    postTitle: item.postTitle || item.post_title || item.title || '未命名视频',
    coverUrl: item.coverUrl || item.cover_url || '',
    transcriptPreview: item.transcriptPreview || item.transcript_preview || '',
    fragmentCount: Number(item.fragmentCount != null ? item.fragmentCount : item.fragment_count || 0),
    errorMessage: (item.error && (item.error.message || item.error.code)) || item.error_message || '',
    createdAt: item.createdAt || item.created_at || '',
    finishedAt: item.finishedAt || item.finished_at || '',
  }
}

function mapTaskRowToHistoryItem(row = {}) {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const result = row.result_json && typeof row.result_json === 'object' ? row.result_json : {}
  const fragments = Array.isArray(result.fragments)
    ? result.fragments
    : (Array.isArray(result.segments) ? result.segments : [])
  const transcript = String(result.transcript || result.text || '').trim()
  return mapHistoryItem({
    taskId: row.id,
    status: row.status,
    postId: meta.postId || '',
    postTitle: meta.postTitle || row.source_file_name || '未命名视频',
    coverUrl: meta.coverUrl || '',
    transcriptPreview: transcript.slice(0, 160),
    fragmentCount: fragments.length,
    error: row.error_json || null,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  })
}

function detailFromTaskRow(row = {}, fallbackPostId = '') {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const result = row.result_json && typeof row.result_json === 'object' ? row.result_json : {}
  return {
    found: true,
    taskId: row.id,
    status: row.status,
    transcript: String(result.transcript || result.text || '').trim(),
    fragments: extractFragments(result),
    post: {
      id: meta.postId || fallbackPostId || '',
      title: meta.postTitle || '',
      coverUrl: meta.coverUrl || '',
    },
    error: row.error_json || null,
    raw: row,
  }
}

function metadataContains(value) {
  return `metadata=cs.${encodeURIComponent(JSON.stringify(value))}`
}

export async function listParseHistory(options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 50)
  const offset = Math.max(Number(options.offset) || 0, 0)
  const mode = options.mode == null ? 'analyze_fragments' : options.mode
  const parts = ['select=*', 'order=created_at.desc', `limit=${limit}`, `offset=${offset}`]
  if (mode && mode !== 'all' && mode !== '*') parts.push(metadataContains({ mode }))
  if (options.status) parts.push(`status=eq.${encodeURIComponent(String(options.status))}`)
  if (options.postId) parts.push(metadataContains({ postId: String(options.postId) }))
  try {
    const rows = safeArray(await restGet(`audio_understanding_tasks?${parts.join('&')}`))
    return { tasks: rows.map(mapTaskRowToHistoryItem), total: rows.length, limit, offset }
  } catch (restError) {
    const result = await callAudioUnderstanding('list', {
      limit,
      offset,
      mode: mode || undefined,
      status: options.status || undefined,
      postId: options.postId || undefined,
    }).catch(() => { throw restError })
    const tasks = safeArray(result.tasks).map(mapHistoryItem)
    return { tasks, total: Number(result.total != null ? result.total : tasks.length), limit, offset }
  }
}

export async function getLatestParseByPost(postId, options = {}) {
  const id = String(postId || '').trim()
  if (!id) {
    const error = new Error('postId 不能为空')
    error.code = 'post_id_required'
    throw error
  }
  const mode = options.mode == null ? 'analyze_fragments' : options.mode
  const parts = ['select=*', metadataContains({ postId: id }), 'order=created_at.desc', 'limit=1']
  if (mode && mode !== 'all' && mode !== '*') parts.push(metadataContains({ mode }))
  if (options.status) parts.push(`status=eq.${encodeURIComponent(String(options.status))}`)
  try {
    const rows = safeArray(await restGet(`audio_understanding_tasks?${parts.join('&')}`))
    if (!rows[0]) return { found: false, task: null }
    return detailFromTaskRow(rows[0], id)
  } catch (restError) {
    const result = await callAudioUnderstanding('latest_by_post', {
      postId: id,
      mode: mode || undefined,
      status: options.status || undefined,
    }).catch(() => { throw restError })
    if (!result || result.found === false) return { found: false, task: null }
    return {
      found: true,
      taskId: result.taskId || result.task_id,
      status: result.status,
      transcript: String(
        result.transcript || result.text || (result.result && (result.result.transcript || result.result.text)) || '',
      ).trim(),
      fragments: extractFragments(result),
      post: result.post || { id },
      error: result.error || null,
      raw: result,
    }
  }
}
