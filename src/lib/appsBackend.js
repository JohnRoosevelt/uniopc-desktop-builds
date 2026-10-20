/**
 * 应用（Apps）后端接入层 —— 与小程序 pages/admin 的 utils/privateConversion.js 同源。
 *
 * 小程序端的「应用」tab（创作广场 + 超级IP + 公域三应用 + 私域转化）全部走这三个
 * Edge Function：private-conversion / socials / super-ip，外加少量 PostgREST RPC。
 * 桌面端复用同一套 action 名和 payload 形状，所以两端行为天然 1:1；差异只在传输层：
 *   - 小程序用 wx.request / wx.uploadFile，这里用 supabaseFetch（Tauri HTTP，绕系统代理）
 *   - 小程序用 wx.getStorageSync 拿 token，这里用 supabase.auth.getSession()
 *
 * 映射函数（mapChannel / mapPost / mapSuperIp* …）是小程序 admin.js 里同名函数的逐条移植，
 * 字段兼容分支（camelCase / snake_case 双写）必须原样保留：后端两套实现返回的键名并不一致。
 */
import { supabase, supabaseFetch, directFetch } from './supabase'
import {
  callMedia as callPluginsMedia,
  callMontage as callPluginsMontage,
  callPrivateConversion as callPluginsPrivateConversion,
  callSocials as callPluginsSocials,
  callSuperIp as callPluginsSuperIp,
} from './privateConversionService'

const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

// ── 常量（与小程序一致） ──────────────────────────────

export const PLAZA_TOPIC_ROWS = [
  {
    id: 'row-a',
    topics: [
      '巨头纷纷布局，AI数字人迎来商业爆发新机遇',
      '一人公司崛起：AI员工如何替你打理全部业务',
      '口播IP起号指南：3条视频免拍摄跑通人设',
    ],
  },
  {
    id: 'row-b',
    topics: [
      '直播电商下半场，AI数字人成私域转化新引擎',
      '同行都在做的获客玩法：从爆款评论区挖出精准客户',
      '把对标账号的爆款文案变成你的下一条视频',
    ],
  },
]

// 私域转化渠道详情页的四个 tab，全部作用于当前选中的渠道
export const CONTENT_MODES = ['profileInfo', 'shortVideo', 'article', 'wechatStore', 'liveVideo']

// 公域三个独立应用（字幕提取 / 公域获客 / 同行监听），共用 socials 工作台，各自独立入口
export const PUBLIC_TRAFFIC_APPS = [
  { mode: 'transcript', title: '字幕提取', subtitle: '从视频链接提取可复用文案' },
  { mode: 'leads', title: '公域获客', subtitle: '从内容互动里找到潜在客户' },
  { mode: 'tracker', title: '同行监听', subtitle: '持续关注同行账号内容变化' },
]

// 平台可选项按应用分开：能读到平台自有字幕的（字幕提取）比能挖线索的（获客/监听）
// 多一个 B 站。放在一起会让「公域获客」多出一个选了必被拒的空选项。
export const PUBLIC_TRAFFIC_PLATFORMS = [
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'douyin', label: '抖音' },
]

export const TRANSCRIPT_PLATFORMS = [
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'douyin', label: '抖音' },
  { value: 'bilibili', label: 'B 站' },
]

export function platformOptionsForMode(mode) {
  return mode === 'transcript' ? TRANSCRIPT_PLATFORMS : PUBLIC_TRAFFIC_PLATFORMS
}

export const SUPER_IP_TABS = [
  { key: 'avatars', label: '头像' },
  { key: 'voices', label: '声音' },
  { key: 'works', label: '作品' },
]

export const EMPTY_PROFILE_FORM = {
  displayName: '',
  slug: '',
  avatarUrl: '',
  coverUrl: '',
  bio: '',
  location: '',
  friendFollowText: '',
  contactText: '',
  profileTagsText: '',
  verificationLabel: '',
  showWechatStoreWindow: false,
  wechatStoreAppId: '',
  wechatStoreProductIdsText: '',
}

export const EMPTY_VIDEO_FORM = {
  videoKind: 'shortVideo',
  title: '',
  description: '',
  coverUrl: '',
  localCoverUrl: '',
  videoUrl: '',
  localVideoUrl: '',
  mediaAssetId: '',
  durationSeconds: 0,
  tagsText: '',
}

export const EMPTY_ARTICLE_FORM = {
  id: '',
  title: '',
  description: '',
  coverUrl: '',
  tagsText: '',
  articleBlocks: [{ type: 'paragraph', text: '' }],
}

export const EMPTY_LIVE_FORM = {
  title: '',
  slug: '',
  sourcePostId: '',
  mediaAssetId: '',
  durationSeconds: 0,
  scheduledDate: '',
  scheduledTime: '',
  passwordEnabled: false,
  password: '',
  openingVideoUrl: '',
}

// 现在只剩「当前正在运营的那条视频」这一个状态。互动数据（评论、直播弹幕、点赞收藏转发）
// 一律由 AI 员工带私域插件生成 (uniopc_private_conversion_*_comments_generate /
// update_post_stats / live_timeline_*)，客户端不再自造。
export const EMPTY_GENERATION_FORM = {
  postId: '',
}

export const EMPTY_PUBLIC_TRAFFIC_FORM = {
  platform: 'xiaohongshu',
  transcriptUrl: '',
  forceRefresh: false,
  leadKeyword: '',
  noteLimit: 20,
  includeCommenters: true,
  trackerUrls: '',
}

// 桌面端没有微信 10MB body 上限，但存储侧 Global file size limit 仍是 1GB。
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024

// ── 基础工具 ──────────────────────────────

export function safeArray(value) {
  return Array.isArray(value) ? value : []
}

export function text(value) {
  return String(value || '').trim()
}

export function countValue(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

export function splitTags(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean)
  return String(value || '')
    .split(/[,\s，、]+/)
    .map(text)
    .filter(Boolean)
}

export function joinTags(value) {
  return splitTags(value).join(' ')
}

export function splitLines(value) {
  return String(value || '').split(/\n+/).map(text).filter(Boolean)
}

export function booleanFlag(value) {
  if (value === true) return true
  if (typeof value === 'number') return value > 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return Boolean(normalized && normalized !== 'false' && normalized !== '0' && normalized !== 'no')
  }
  return false
}

export function formatDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = number => String(number).padStart(2, '0')
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

export function formatFileSize(bytes) {
  const size = Number(bytes || 0)
  if (!Number.isFinite(size) || size <= 0) return ''
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)}KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)}GB`
}

// ── 传输层 ──────────────────────────────

async function authToken() {
  const { data } = await supabase.auth.getSession()
  return data?.session?.access_token || ''
}

/** private-conversion 单体函数（全部真实流量都走它） */
export function callPrivateConversion(action, payload = {}) {
  return callPluginsPrivateConversion(action, payload)
}

/**
 * media 函数（素材存储，落阿里云 OSS）。
 *
 * 素材这一组 action（prepare/create/list/download_url）在单体里也有一份同名实现，
 * 区别只在存储后端：单体写 Supabase Storage，media 写 OSS。两边读同一张
 * private_conversion_media_assets，靠 storage_provider 列区分，media 对历史行
 * （provider 为空）会原样回退到永久公开 URL，所以切过来不影响存量素材。
 */
export function callMedia(action, payload = {}) {
  return callPluginsMedia(action, payload)
}

export function callMontage(action, payload = {}) {
  return callPluginsMontage(action, payload)
}

/** socials（公域三应用） */
export function callSocials(action, payload = {}) {
  return callPluginsSocials(action, payload)
}

/** super-ip（数字人 / 声音 / 作品） */
export function callSuperIp(action, payload = {}) {
  return callPluginsSuperIp(action, payload)
}

/** security definer RPC（PostgREST） */
export async function callRpc(name, payload = {}) {
  const { data, error } = await supabase.rpc(name, payload)
  if (error) {
    const nextError = new Error(error.message || `rpc_${name}_failed`)
    nextError.code = error.code
    throw nextError
  }
  return data
}

/** PostgREST 直读（RLS 生效），videoParse 的历史列表要用 */
export async function restGet(pathWithQuery) {
  const token = await authToken()
  if (!token) throw new Error('missing_authorization')
  const response = await supabaseFetch(`${SUPABASE_URL}/rest/v1/${pathWithQuery}`, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const body = data && typeof data === 'object' ? data : {}
    throw new Error(body.message || body.msg || body.error || `supabase_rest_http_${response.status}`)
  }
  return Array.isArray(data) ? data : data || []
}

export const UPLOAD_CANCELLED_MESSAGE = '已取消上传'

/**
 * OSS 签名 PUT 要用的请求头。
 *
 * 签名是按「方法 + 这批头」算出来的，多一个头就对不上：这里**绝不能**带
 * Authorization / apikey —— 那是打 Supabase 时的凭据，打到 OSS 上只会让签名校验失败。
 */
function ossUploadHeaders(prepared, mimeType) {
  const headers = { ...(prepared?.uploadHeaders || prepared?.upload_headers || {}) }
  if (!headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = mimeType || text(prepared?.mimeType || prepared?.mime_type) || 'application/octet-stream'
  }
  return headers
}

/**
 * 上传一个素材并登记为 media asset —— 与小程序 uploadSelectedAsset 同一条链路：
 *   operator_prepare_storage_upload → 签名 PUT → operator_create_media_asset
 *
 * 三步都打 media 函数，文件**只**落阿里云 OSS：prepare 没回 OSS 签名就直接失败，
 * 不再退回 Supabase Storage。留着那条退路的唯一后果是——服务端 OSS 配置一旦出问题，
 * 上传会「成功」但悄悄写回 Supabase，把刚收口的双存储又劈开一次，而且没人会发现。
 * 宁可当场报错。
 *
 * 桌面端没有进度回调（Tauri fetch 不透出上传进度），但支持 AbortSignal 取消。
 */
export async function uploadOperatorAsset({ file, assetKind, signal, durationSeconds = 0 }) {
  const isVideo = assetKind === 'video'
  const fileName = file?.name || (isVideo ? 'video.mp4' : 'image.jpg')
  const mimeType = file?.type || (isVideo ? 'video/mp4' : 'image/jpeg')
  if (file?.size > MAX_UPLOAD_BYTES) {
    throw new Error(`文件 ${formatFileSize(file.size)}，超过上传上限 1GB`)
  }

  const prepared = await callMedia('operator_prepare_storage_upload', {
    channelType: 'video',
    assetKind,
    fileName,
    mimeType,
  })

  const objectPath = text(prepared.path)
  if (!objectPath) throw new Error('storage_path_missing')

  const signedUrl = text(prepared.signedUrl || prepared.signed_url)
  const uploadHeaders = prepared.uploadHeaders || prepared.upload_headers
  if (!signedUrl || !uploadHeaders) {
    // 走到这里说明 media 函数没按 OSS 签发（多半是服务端那 6 个 OSS_* env 掉了）。
    // 报错点名它，否则只会看到一句没有信息量的「上传失败」。
    throw new Error('media 函数没有返回 OSS 签名地址，请检查服务端 OSS 配置')
  }

  const body = new Uint8Array(await file.arrayBuffer())

  let response
  try {
    // 打的是 OSS 域名，不是 Supabase —— 必须用 directFetch，supabaseFetch 的
    // noProxy 只放行 Supabase 那一个 host，OSS 会被丢进死代理里连不上。
    response = await directFetch(signedUrl, {
      method: 'PUT',
      headers: ossUploadHeaders(prepared, mimeType),
      body,
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw new Error(UPLOAD_CANCELLED_MESSAGE)
    throw error
  }
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`上传失败（HTTP ${response.status}）${errorBody ? `：${errorBody.slice(0, 120)}` : ''}`)
  }

  const created = await callMedia('operator_create_media_asset', {
    assetType: isVideo ? 'video' : 'cover',
    storagePath: prepared.path,
    publicUrl: prepared.publicUrl,
    // 缺省即 oss；prepare 回什么就登记什么，别让客户端猜存储后端。
    storageProvider: text(prepared.storageProvider || prepared.storage_provider) || undefined,
    mimeType: prepared.mimeType || mimeType,
    byteSize: Number(file?.size || body.byteLength),
    durationSeconds: countValue(durationSeconds),
    metadata: { fileName },
  })
  const mediaAsset = created.mediaAsset || created.media_asset || {}
  return {
    publicUrl: mediaAsset.public_url || mediaAsset.publicUrl || prepared.publicUrl,
    mediaAssetId: mediaAsset.id || '',
    storagePath: prepared.path,
  }
}

/**
 * 从本地视频里截一帧当默认封面，返回一个可直接上传的 jpg File；失败一律回 null。
 *
 * 没有封面时后端会兜底成「拿视频地址当封面」，前端再把 mp4 塞进 <img> —— macOS 的
 * WebKit 确实能解出首帧显示出来，看着是好的，代价是为了一张缩略图要把整个视频拖下来
 * （实测有 157MB 的），列表每渲染一次就重来一遍。所以封面必须在发布时就生成。
 *
 * 全程 blob: URL，在 CSP 的 media-src 白名单里；canvas 同源不会被污染。
 * 任何一步失败都返回 null 而不是抛错：封面是锦上添花，不能让它挡住视频发布。
 */
export function captureVideoThumbnail(file, { maxEdge = 1080, quality = 0.82, timeoutMs = 15000 } = {}) {
  return new Promise(resolve => {
    let objectUrl = ''
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      resolve(value)
    }

    try {
      objectUrl = URL.createObjectURL(file)
      const video = document.createElement('video')
      video.preload = 'auto'
      video.muted = true
      video.playsInline = true

      const timer = setTimeout(() => finish(null), timeoutMs)
      const bail = () => {
        clearTimeout(timer)
        finish(null)
      }

      const draw = () => {
        clearTimeout(timer)
        try {
          const width = video.videoWidth
          const height = video.videoHeight
          if (!width || !height) return finish(null)
          const scale = Math.min(1, maxEdge / Math.max(width, height))
          const canvas = document.createElement('canvas')
          canvas.width = Math.round(width * scale)
          canvas.height = Math.round(height * scale)
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
          canvas.toBlob(
            blob => finish(blob ? new File([blob], coverFileName(file.name), { type: 'image/jpeg' }) : null),
            'image/jpeg',
            quality,
          )
        } catch {
          finish(null)
        }
      }

      video.onerror = bail
      video.onloadeddata = () => {
        // 第 0 帧常是纯黑（淡入/转场），往后跳一点更可能取到有内容的一帧。
        const duration = Number(video.duration)
        const at = Number.isFinite(duration) && duration > 2 ? Math.min(1, duration / 10) : 0
        if (at <= 0) return draw()
        video.onseeked = draw
        try {
          video.currentTime = at
        } catch {
          draw()
        }
      }
      video.src = objectUrl
    } catch {
      finish(null)
    }
  })
}

function coverFileName(videoName) {
  const base = text(videoName).replace(/\.[^.]+$/, '') || 'video'
  return `${base}-cover.jpg`
}

/** 读取本地视频文件的时长（发布时要带给 media asset，直播排播靠它算结束时间） */
export function readVideoDuration(file) {
  return new Promise(resolve => {
    try {
      const url = URL.createObjectURL(file)
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.onloadedmetadata = () => {
        const duration = Number(video.duration)
        URL.revokeObjectURL(url)
        resolve(Number.isFinite(duration) ? Math.round(duration) : 0)
      }
      video.onerror = () => {
        URL.revokeObjectURL(url)
        resolve(0)
      }
      video.src = url
    } catch {
      resolve(0)
    }
  })
}

export function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function hexToBytes(hex) {
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '')
  const length = Math.floor(clean.length / 2)
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16)
  }
  return out
}

// ── 超级IP 映射 ──────────────────────────────

const SUPER_IP_ERROR_TEXT = {
  heygen_account_not_configured: '尚未开通 HeyGen 服务',
  voice_account_not_configured: '尚未开通声音服务',
  heygen_avatar_quota_exceeded: '头像数量已达上限，请先删除后再创建',
  voice_quota_exceeded: '声音数量已达上限，请先删除后再克隆',
  voice_not_owned: '该声音不属于当前团队',
  voice_prompt_required: '请先填写声音描述',
  voice_audio_required: '请先选择一段音频',
  voice_clone_validation_failed: '录音内容与校验文本对不上，请重录或修改校验文本',
  voice_daily_quota_exceeded: '今日配音额度已用完，请明天再试',
  heygen_register_requires_org_account: '登记已有头像需绑定自有 HeyGen 账号',
}

export function superIpFriendly(error, fallback) {
  const code = error && error.code
  if (code && SUPER_IP_ERROR_TEXT[code]) return SUPER_IP_ERROR_TEXT[code]
  return (error && error.message) || fallback || '操作失败'
}

function superIpStatusText(status) {
  const value = String(status || '').toLowerCase()
  if (value === 'active') return '可用'
  if (value === 'training') return '训练中'
  if (value === 'failed') return '失败'
  return value || ''
}

function superIpProviderLabel(account) {
  const value = account || {}
  const provider = value.provider || (value.configured ? 'org' : 'none')
  if (provider === 'official') return '官方服务'
  if (provider === 'org' || value.configured) return text(value.accountLabel || value.account_label) || '自有账号'
  return '未开通'
}

export function decorateSuperIpAccount(account) {
  const value = account || {}
  return {
    configured: Boolean(value.configured),
    provider: value.provider || (value.configured ? 'org' : 'none'),
    providerLabel: superIpProviderLabel(value),
    maskedApiKey: value.maskedApiKey || value.masked_api_key || '',
    accountLabel: value.accountLabel || value.account_label || '',
  }
}

export function mapSuperIpAvatar(avatar) {
  const value = avatar || {}
  const status = text(value.status) || 'active'
  const source = text(value.source)
  return {
    id: value.id || value.avatarId || value.avatar_id || '',
    avatarId: value.avatarId || value.avatar_id || '',
    name: text(value.name) || '未命名头像',
    previewImageUrl: value.previewImageUrl || value.preview_image_url || '',
    status,
    statusText: superIpStatusText(status),
    sourceText: source === 'created' ? '自建' : '登记',
  }
}

// 后端写的是 'created'(快速复刻)/ 'designed'(音色设计)/ 'registered'(登记已有)。
// 曾经这里只认 'trained',结果自己克隆出来的音色在列表上一律显示成「登记」。
function superIpVoiceSourceText(source) {
  const value = String(source || '').toLowerCase()
  if (value === 'created' || value === 'trained') return '克隆'
  if (value === 'designed') return '设计'
  if (value === 'system') return '官方'
  return '登记'
}

export function mapSuperIpVoice(voice) {
  const value = voice || {}
  const status = text(value.status) || 'active'
  return {
    id: value.id || value.voiceId || value.voice_id || '',
    voiceId: value.voiceId || value.voice_id || '',
    name: text(value.name) || '未命名声音',
    language: text(value.language),
    gender: text(value.gender),
    status,
    statusText: superIpStatusText(status),
    sourceText: superIpVoiceSourceText(value.source),
    demoAudioUrl: value.demoAudioUrl || value.demo_audio_url || '',
    canPreview: status === 'active',
  }
}

// 系统音色不落库,只是上游列表的投影:没有 id / 状态 / 归属,只能试听和被选用。
export function mapSuperIpSystemVoice(voice) {
  const value = voice || {}
  const voiceId = value.voiceId || value.voice_id || ''
  return {
    id: voiceId,
    voiceId,
    name: text(value.name) || text(value.voice_name) || voiceId,
    description: safeArray(value.description).map(item => text(item)).filter(Boolean).join(' · '),
    sourceText: '官方',
  }
}

export function mapSuperIpWork(work) {
  const value = work || {}
  const status = text(value.status) || 'ready'
  const duration = Number(value.duration_seconds || value.durationSeconds || 0)
  return {
    id: value.id || value.workId || '',
    title: text(value.title) || '未命名作品',
    videoUrl: value.video_url || value.videoUrl || '',
    durationText: duration ? `${Math.round(duration)}s` : '',
    status,
    statusText: status === 'uploading' ? '上传中' : status === 'failed' ? '上传失败' : '',
  }
}

// ── 公域流量映射 ──────────────────────────────

export function formatPublicTrafficCount(value) {
  const number = countValue(value)
  if (number < 1000) return String(number)
  if (number < 10000) return `${(number / 1000).toFixed(1)}k`
  return `${(number / 10000).toFixed(1)}万`
}

export function publicTrafficPlatformLabel(platform) {
  const item = TRANSCRIPT_PLATFORMS.find(option => option.value === platform)
  return item ? item.label : platform
}

export function decoratePublicTrafficTranscript(row = {}) {
  const body = text(row.transcript)
  return {
    ...row,
    id: row.id || row.note_id || '',
    transcript: body,
    char_count: row.char_count || body.length,
    platformLabel: publicTrafficPlatformLabel(row.platform || 'xiaohongshu'),
  }
}

export function mapPublicTrafficLead(lead) {
  const role = lead.role === 'commenter' ? '评论者' : lead.role === 'both' ? '作者+评论者' : '作者'
  return {
    id: lead.id || lead.external_user_id,
    title: lead.nickname || lead.external_user_id || '未知线索',
    subtitle: `${publicTrafficPlatformLabel(lead.platform)} · ${role}`,
    keyword: lead.keyword || '',
    followerText: lead.follower_count ? `${formatPublicTrafficCount(lead.follower_count)} 粉丝` : '',
  }
}

export function mapPublicTrafficAuthor(author) {
  return {
    id: author.id || author.external_user_id,
    title: author.nickname || author.external_user_id || '未命名账号',
    subtitle: `${publicTrafficPlatformLabel(author.platform)} · ${author.last_refreshed_at ? '已刷新' : '待刷新'}`,
    followerText: author.follower_count ? `${formatPublicTrafficCount(author.follower_count)} 粉丝` : '',
  }
}

// ── 私域转化映射 ──────────────────────────────

export function parseWechatStoreProducts(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\n,，\s]+/)
  return items.map(item => {
    if (item && typeof item === 'object') {
      const productId = text(item.productId || item.product_id || item.id)
      const productPromotionLink = text(
        item.productPromotionLink || item.product_promotion_link || item.promotionLink || item.promotion_link,
      )
      return productId ? { productId, productPromotionLink } : null
    }
    const [productId, productPromotionLink = ''] = String(item || '').split('|').map(text)
    return productId ? { productId, productPromotionLink } : null
  }).filter(Boolean)
}

export function formatWechatStoreProducts(value) {
  return parseWechatStoreProducts(value)
    .map(item => (item.productPromotionLink ? `${item.productId}|${item.productPromotionLink}` : item.productId))
    .join('\n')
}

export function channelWechatStore(channel) {
  const payload = channel.profile_payload || channel.profilePayload || {}
  const source = payload.wechatStore || payload.wechat_store || payload
  const appid = text(
    source.appid || source.appId || source.app_id || source.wechatStoreAppId ||
    source.wechat_store_app_id || channel.wechatStoreAppId || channel.wechat_store_app_id,
  )
  const products = parseWechatStoreProducts(
    source.products || source.productIds || source.product_ids || source.wechatStoreProducts ||
    source.wechat_store_products || channel.wechatStoreProducts || channel.wechat_store_products,
  )
  const enabled = Boolean(booleanFlag(
    source.enabled || source.showWechatStoreWindow || source.show_wechat_store_window ||
    channel.showWechatStoreWindow || channel.show_wechat_store_window,
  ) && appid)
  return { appid, products, enabled }
}

export function mapChannel(channel) {
  const payload = channel.profile_payload || {}
  const wechatStore = channelWechatStore(channel)
  return {
    id: channel.id,
    type: channel.channel_type,
    ownerId: channel.slug || channel.ownerId,
    nickname: channel.display_name || channel.nickname || '私域账号',
    avatar: channel.avatar_url || channel.avatar || '',
    location: channel.location || '',
    bio: channel.bio || payload.bioText || '',
    coverUrl: channel.cover_url || channel.cover || '',
    friendFollowText: channel.friendFollowText || channel.friend_follow_text ||
      payload.friendFollowText || payload.friend_follow_text || '',
    contactText: channel.contactText || channel.contact_text || payload.contactText || payload.contact_text || '',
    profileTags: safeArray(channel.profileTags || channel.profile_tags || payload.profileTags || payload.profile_tags),
    verificationLabel: channel.verification_label || payload.verificationLabel || '',
    showWechatStoreWindow: wechatStore.enabled,
    wechatStoreAppId: wechatStore.appid,
    wechatStoreProducts: wechatStore.products,
    organizationName: channel.organizationName || '未命名组织',
    postCount: channel.postCount || 0,
    liveSessionCount: channel.liveSessionCount || 0,
    statusText: `${channel.postCount || 0} 条视频 · ${channel.liveSessionCount || 0} 场直播`,
  }
}

function normalizedVideoKind(post, payload) {
  const kind = payload.videoKind || payload.video_kind || post.videoKind || post.video_kind
  if (kind === 'shortVideo' || kind === 'liveVideo') return kind
  return 'unclassifiedVideo'
}

export function videoKindLabel(kind) {
  if (kind === 'shortVideo') return '短视频'
  if (kind === 'liveVideo') return '直播视频'
  return '未分类'
}

// 后端 normalizePost 在没有封面时会兜底把**视频地址**当封面回过来。把它塞进 <img>
// 是有代价的：macOS 的 WebKit 会为了解首帧下载整个文件，实测有 157MB 的，重则直接
// 把 WebView 的渲染进程撑崩（表现就是整窗白屏）。宁可显示「无封面」。
function safeCoverUrl(coverUrl, videoUrl) {
  const cover = text(coverUrl)
  if (!cover) return ''
  if (cover === text(videoUrl)) return ''
  return /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(cover.split('?')[0]) ? '' : cover
}

export function mapPost(post) {
  const payload = post.content_payload || post.contentPayload || {}
  const media = post.media || post.mediaAsset || post.media_asset || {}
  const videoKind = normalizedVideoKind(post, payload)
  const videoUrl = post.video || payload.video || payload.videoUrl || post.public_url ||
    post.publicUrl || media.public_url || media.publicUrl || ''
  return {
    id: post.id,
    postType: post.post_type || post.postType || 'video',
    title: post.title || '未命名内容',
    description: post.description || payload.description || '',
    coverUrl: safeCoverUrl(
      post.cover || post.cover_url || payload.cover || payload.coverUrl ||
        media.cover_url || media.coverUrl || '',
      videoUrl,
    ),
    videoUrl,
    mediaAssetId: post.mediaAssetId || post.media_asset_id || media.id || '',
    storagePath: post.storagePath || post.storage_path || media.storage_path || media.storagePath || '',
    mediaBucket: post.mediaBucket || post.media_bucket ||
      (media.storage_path || media.storagePath ? 'private-conversion' : ''),
    videoKind,
    kindLabel: videoKindLabel(videoKind),
    tags: safeArray(post.tags || payload.tags),
    articleBlocks: safeArray(payload.articleBlocks || payload.article_blocks),
    statusText: post.status === 'draft' ? '草稿' : '已发布',
    likes: countValue(post.real_like_count || post.realLikes || post.likes || post.mock_like_count),
    comments: countValue(post.real_comment_count || post.realComments || post.comments_count || post.mock_comment_count),
    favorites: countValue(post.real_favorite_count || post.realFavorites || post.favorites || post.mock_favorite_count),
    shares: countValue(post.real_share_count || post.realShares || post.forwards || post.shares || post.mock_share_count),
    views: countValue(post.real_view_count || post.realViews || post.view_count || post.views || post.mock_view_count),
  }
}

export function mapMediaAsset(asset) {
  return {
    id: asset.id,
    name: (asset.metadata && (asset.metadata.fileName || asset.metadata.name)) || asset.storage_path || '视频素材',
    url: asset.public_url || asset.publicUrl || '',
    durationSeconds: countValue(asset.duration_seconds || asset.durationSeconds),
  }
}

function liveStatusText(status) {
  if (status === 'live') return '直播中'
  if (status === 'ended') return '已结束'
  return '待开播'
}

export function formatLiveStatusHint(status, scheduledStartAt, scheduledEndAt, nowMs = Date.now()) {
  if (status === 'ended') return '直播已结束'
  if (status === 'cancelled') return '直播已取消'
  const startMs = Date.parse(text(scheduledStartAt))
  const endMs = Date.parse(text(scheduledEndAt))
  if (status === 'scheduled' && Number.isFinite(startMs)) {
    return startMs > nowMs ? `距开播 ${formatDuration(startMs - nowMs)}` : '等待后端确认开播'
  }
  if (status === 'live') {
    if (Number.isFinite(endMs) && endMs > nowMs) return `距结束 ${formatDuration(endMs - nowMs)}`
    if (Number.isFinite(startMs)) return `已开播 ${formatDuration(nowMs - startMs)}`
    return '直播进行中'
  }
  return ''
}

export function mapLiveSession(session) {
  const channel = session.channel || {}
  const post = session.post || {}
  const scheduledStartAt = session.scheduledStartAt || session.scheduled_start_at
  const scheduledEndAt = session.scheduledEndAt || session.scheduled_end_at
  const effectiveStatus = session.effectiveStatus || session.effective_status || session.status || 'scheduled'
  return {
    id: session.id,
    slug: session.slug,
    title: session.title || '私域直播',
    status: effectiveStatus,
    scheduledStartAt,
    scheduledEndAt,
    statusText: liveStatusText(effectiveStatus),
    canPreview: effectiveStatus !== 'ended',
    statusHintText: formatLiveStatusHint(effectiveStatus, scheduledStartAt, scheduledEndAt),
    scheduledText: formatDateTime(scheduledStartAt) || '未设置开播时间',
    ownerName: channel.display_name || session.nickname || '视频号主页',
    ownerAvatar: channel.avatar_url || '',
    sourcePostId: session.sourcePostId || session.source_post_id || session.post_id || post.id || '',
    sourceTitle: post.title || '未关联视频',
    passwordText: session.room_payload && (session.room_payload.passwordEnabled || session.room_payload.password_enabled)
      ? '已开启直播间密码'
      : '未开启密码',
  }
}

export function profileFormFromChannel(channel) {
  if (!channel) return { ...EMPTY_PROFILE_FORM, slug: `video-${Date.now().toString(36)}` }
  const wechatStore = channelWechatStore(channel)
  return {
    displayName: channel.nickname || '',
    slug: channel.ownerId || '',
    avatarUrl: channel.avatar || '',
    coverUrl: channel.coverUrl || '',
    bio: channel.bio || '',
    location: channel.location || '',
    friendFollowText: channel.friendFollowText || '',
    contactText: channel.contactText || '',
    profileTagsText: joinTags(channel.profileTags || []),
    verificationLabel: channel.verificationLabel || '',
    showWechatStoreWindow: wechatStore.enabled,
    wechatStoreAppId: wechatStore.appid,
    wechatStoreProductIdsText: formatWechatStoreProducts(wechatStore.products),
  }
}

/** 渠道主页保存的 payload —— 新建 / 编辑 / 小店绑定三处共用同一形状 */
export function channelSavePayload(form) {
  const profileTags = splitTags(form.profileTagsText)
  const wechatStoreProducts = parseWechatStoreProducts(form.wechatStoreProductIdsText)
  const wechatStoreAppId = text(form.wechatStoreAppId)
  const showWechatStoreWindow = Boolean(form.showWechatStoreWindow && wechatStoreAppId)
  const wechatStore = { enabled: showWechatStoreWindow, appid: wechatStoreAppId, products: wechatStoreProducts }
  const tabs = showWechatStoreWindow
    ? ['主页', '视频', '商品橱窗', '直播回放', '音频']
    : ['主页', '视频', '直播回放', '音频']
  return {
    channelType: 'video',
    displayName: form.displayName,
    slug: form.slug,
    avatarUrl: form.avatarUrl,
    coverUrl: form.coverUrl,
    bio: form.bio,
    location: form.location,
    friendFollowText: form.friendFollowText,
    contactText: form.contactText,
    profileTags,
    verificationLabel: form.verificationLabel,
    showWechatStoreWindow,
    wechatStoreAppId,
    wechatStoreProducts,
    profilePayload: {
      tabs,
      profileTags,
      contactText: form.contactText,
      wechatStore,
      showWechatStoreWindow,
      wechatStoreAppId,
      wechatStoreProducts,
    },
  }
}

export function dateTimeFromLiveForm(form) {
  if (!form.scheduledDate || !form.scheduledTime) return ''
  return `${form.scheduledDate}T${form.scheduledTime}:00+08:00`
}

export function liveEndTimeFromForm(form, scheduledStartAt) {
  const durationSeconds = Number(form.durationSeconds || 0)
  const scheduledStartMs = Date.parse(scheduledStartAt)
  if (!Number.isFinite(scheduledStartMs) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return ''
  return new Date(scheduledStartMs + Math.round(durationSeconds) * 1000).toISOString()
}

// ── 数据分析映射 ──────────────────────────────

export function formatAnalyticsTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function maskOpenid(openid) {
  return openid ? `${String(openid).slice(0, 6)}…${String(openid).slice(-4)}` : '无 openid'
}

export function mapAnalyticsComment(comment = {}) {
  const openid = comment.openid || comment.viewerOpenid || comment.viewer_openid || ''
  return {
    id: comment.id,
    nickname: comment.authorName || comment.author_name || comment.nickname || '微信用户',
    avatar: comment.authorAvatarUrl || comment.author_avatar_url || comment.avatar || '',
    content: comment.content || comment.text || '',
    sourceLabel: (comment.sourceType || comment.source_type) === 'real' ? '真实用户' : '运营/种子',
    openidText: maskOpenid(openid),
    timeText: formatAnalyticsTime(comment.createdAt || comment.created_at),
    likes: countValue(comment.likeCount || comment.like_count),
  }
}

export function mapAnalyticsInteraction(item = {}) {
  const openid = item.openid || item.viewerOpenid || item.viewer_openid || ''
  const type = item.interactionType || item.interaction_type
  return {
    id: item.id || item.interaction_id,
    nickname: item.nickname || '微信用户',
    avatar: item.avatarUrl || item.avatar_url || item.avatar || '',
    openidText: maskOpenid(openid),
    timeText: formatAnalyticsTime(item.createdAt || item.created_at),
    typeLabel: type === 'like' ? '点赞' : (type === 'share' || type === 'forward') ? '转发' : '收藏',
  }
}

// ── 数据分析加载（Plugins 聚合接口 → Plugins 明细接口） ────

async function loadAnalyticsViaPluginsLists(postId, postOptions) {
  const commentResult = await callPrivateConversion('operator_list_comments', { postId, limit: 200 })
  const comments = safeArray(commentResult.comments)
  let likes = []
  let favorites = []
  let shares = []
  try {
    const interactionResult = await callPrivateConversion('operator_list_post_interactions', { postId, limit: 200 })
    const typeOf = item => item.interactionType || item.interaction_type
    const all = safeArray(interactionResult.interactions)
    likes = safeArray(interactionResult.likes || all).filter(item => typeOf(item) === 'like')
    favorites = safeArray(interactionResult.favorites || all).filter(item => ['favorite', 'collect'].includes(typeOf(item)))
    shares = safeArray(interactionResult.shares || all).filter(item => ['share', 'forward'].includes(typeOf(item)))
    if (!interactionResult.likes && !interactionResult.favorites && !interactionResult.shares) {
      likes = all.filter(item => typeOf(item) === 'like')
      favorites = all.filter(item => ['favorite', 'collect'].includes(typeOf(item)))
      shares = all.filter(item => ['share', 'forward'].includes(typeOf(item)))
    }
  } catch { /* 老后端没有互动明细：只展示评论 */ }
  return {
    post: safeArray(postOptions).find(item => item.id === postId) || { id: postId },
    comments,
    likes,
    favorites,
    shares,
    summary: {
      comments: comments.length,
      likes: likes.length,
      favorites: favorites.length,
      shares: shares.length,
      realComments: comments.filter(item => (item.source_type || item.sourceType) === 'real').length,
      realLikes: likes.length,
      realFavorites: favorites.length,
      realShares: shares.length,
    },
  }
}

/** operator_get_post_analytics → 同一 Plugins 项目的明细接口，任一层可用即返回 */
export async function loadPostAnalytics(postId, postOptions = []) {
  try {
    return await callPrivateConversion('operator_get_post_analytics', { postId, limit: 200 })
  } catch (edgeError) {
    try {
      return await loadAnalyticsViaPluginsLists(postId, postOptions)
    } catch {
      throw edgeError
    }
  }
}
