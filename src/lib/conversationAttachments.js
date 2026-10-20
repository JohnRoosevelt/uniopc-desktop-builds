export const CONVERSATION_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const CONVERSATION_IMAGE_MAX_COUNT = 4
export const CONVERSATION_ATTACHMENT_MAX_TOTAL_BYTES = 100 * 1024 * 1024
export const CONVERSATION_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024
export const CONVERSATION_VIDEO_MAX_BYTES = 10 * 1024 * 1024

export function conversationAttachmentTypeLabel(mimeType) {
  const normalized = String(mimeType || '').trim().toLowerCase()
  if (normalized === 'application/pdf') return 'PDF'
  if (normalized === 'application/vnd.ms-powerpoint'
    || normalized === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'PPT'
  if (normalized === 'video/mp4') return 'MP4'
  return 'TXT'
}

export function nativeDragPositionToViewport(position, {
  eventType,
  platform,
  scaleFactor = 1,
  viewportHeight,
} = {}) {
  if (!position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.y))) return null
  if (platform === 'macos') {
    // Tauri's native Finder drag event already reports webview-local points on
    // macOS, despite the PhysicalPosition wrapper used by the JS API.
    return { x: Number(position.x), y: Number(position.y) }
  }
  const safeScaleFactor = Number(scaleFactor) > 0 ? Number(scaleFactor) : 1
  return { x: Number(position.x) / safeScaleFactor, y: Number(position.y) / safeScaleFactor }
}

const IMAGE_DATA_URL_PATTERN = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/
const PDF_DATA_URL_PATTERN = /^data:(application\/pdf);base64,([\s\S]+)$/

function defaultImageFileName(mimeType) {
  const normalized = String(mimeType || '').trim().toLowerCase()
  if (normalized === 'application/pdf') return 'attachment.pdf'
  if (normalized === 'application/vnd.ms-powerpoint') return 'attachment.ppt'
  if (normalized === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'attachment.pptx'
  if (normalized === 'text/plain') return 'attachment.txt'
  if (normalized === 'video/mp4') return 'attachment.mp4'
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'image.jpg'
  if (normalized === 'image/webp') return 'image.webp'
  if (normalized === 'image/gif') return 'image.gif'
  if (normalized === 'image/heic') return 'image.heic'
  return 'image.png'
}

function normalizeImageFileName(name, mimeType) {
  const value = String(name || '').trim()
  if (!value) return defaultImageFileName(mimeType)
  return value.split(/[\\/]/).filter(Boolean).at(-1) || defaultImageFileName(mimeType)
}

export function validateConversationImageAttachment(attachment) {
  const mimeType = String(attachment?.mimeType || '').trim().toLowerCase()
  const isImage = mimeType.startsWith('image/')
  const isSupportedFile = [
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'video/mp4',
  ].includes(mimeType)
  if (!isImage && !isSupportedFile) {
    throw new Error('仅支持图片、PDF、PPT/PPTX、UTF-8 TXT 或 MP4 附件。')
  }
  const size = Number(attachment?.size || 0)
  const maxBytes = mimeType === 'video/mp4'
    ? CONVERSATION_VIDEO_MAX_BYTES
    : isImage ? CONVERSATION_IMAGE_MAX_BYTES : CONVERSATION_DOCUMENT_MAX_BYTES
  if (size <= 0 || size > maxBytes) {
    throw new Error(`附件大小无效或超过 ${Math.round(maxBytes / (1024 * 1024))} MiB 限制。`)
  }
  if (attachment?.localMediaId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(attachment.localMediaId))) {
      throw new Error('本地附件引用无效。')
    }
    if (!String(attachment.path || '').trim()) throw new Error('本地附件路径无效。')
    return true
  }
  const dataUrl = String(attachment?.dataUrl || '')
  const match = (mimeType === 'application/pdf' ? PDF_DATA_URL_PATTERN : IMAGE_DATA_URL_PATTERN).exec(dataUrl)
  if (!match || match[1].toLowerCase() !== mimeType) {
    throw new Error('图片数据格式无效。')
  }
  return true
}

export function validateConversationImageAttachments(attachments) {
  const items = Array.isArray(attachments) ? attachments : []
  if (items.length > CONVERSATION_IMAGE_MAX_COUNT) {
    throw new Error(`一次最多发送 ${CONVERSATION_IMAGE_MAX_COUNT} 个附件。`)
  }
  const totalBytes = items.reduce((total, item) => total + Math.max(0, Number(item?.size || 0)), 0)
  if (totalBytes > CONVERSATION_ATTACHMENT_MAX_TOTAL_BYTES) throw new Error('附件总大小不能超过 100 MiB。')
  items.forEach(validateConversationImageAttachment)
  return true
}

export function conversationImageAttachmentToGateway(attachment) {
  validateConversationImageAttachment(attachment)
  const mimeType = String(attachment.mimeType || '').trim().toLowerCase()
  const base = {
    type: mimeType.startsWith('image/') ? 'image' : 'file',
    mimeType,
    fileName: normalizeImageFileName(attachment.name, mimeType),
  }
  if (attachment.localMediaId) {
    return { ...base, localMediaId: attachment.localMediaId, sizeBytes: Number(attachment.size || 0) }
  }
  const match = (mimeType === 'application/pdf' ? PDF_DATA_URL_PATTERN : IMAGE_DATA_URL_PATTERN).exec(String(attachment.dataUrl || ''))
  return {
    ...base,
    mimeType: match[1],
    content: match[2],
  }
}

export function conversationImageAttachmentsToGateway(attachments) {
  validateConversationImageAttachments(attachments)
  return (Array.isArray(attachments) ? attachments : []).map(conversationImageAttachmentToGateway)
}

// The gateway never replays image bytes — it strips `data` off image content
// blocks unconditionally — but it does persist every inbound image under
// state/<profile>/media/inbound/ and hands the absolute paths back on the
// history envelope as stable `mediaPaths` / `mediaTypes` fields.
// Turning those into `attachments` lets a reloaded message render through the
// exact same <img> branch as a freshly sent one.
//
// `toAssetUrl` is injected so this stays testable outside a Tauri webview; the
// caller passes `convertFileSrc`. The asset protocol scope in tauri.conf.json
// already covers `$DATA/Uniopc/state/*/media/**`.
export function gatewayHistoryMediaToAttachments(mediaPaths, mediaTypes, toAssetUrl) {
  const paths = Array.isArray(mediaPaths) ? mediaPaths : []
  const types = Array.isArray(mediaTypes) ? mediaTypes : []
  return paths
    .map((path, index) => {
      const value = String(path || '').trim()
      if (!value) return null
      const mimeType = String(types[index] || '').trim().toLowerCase()
      return {
        id: `media-${value}`,
        name: normalizeImageFileName(value, mimeType),
        mimeType: mimeType || 'image/png',
        path: value,
        dataUrl: toAssetUrl(value),
      }
    })
    .filter(Boolean)
}

export function readFileAsConversationImageAttachment(file) {
  if (!file) return Promise.reject(new Error('没有选择附件。'))
  const id = globalThis.crypto?.randomUUID?.() || `image-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const attachment = {
        id,
        name: file.name || 'image',
        mimeType: file.type || '',
        size: file.size || 0,
        dataUrl: String(reader.result || ''),
      }
      try {
        validateConversationImageAttachment(attachment)
        resolve(attachment)
      } catch (error) {
        reject(error)
      }
    }
    reader.onerror = () => reject(new Error('读取图片失败。'))
    reader.readAsDataURL(file)
  })
}
