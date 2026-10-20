// Display-layer brand sanitizer (L2 of the white-label work).
//
// The engine's raw error/status strings can contain the upstream "OpenClaw"
// brand (gateway errors are rendered verbatim in Conversations and toasts).
// The engine dist is already patched at bundle build time (L3), but strings
// minted by an unpatched path — or by a future upstream bump before the
// patch list catches up — must not leak the upstream brand to users. This is
// the last-line safety net; it rewrites display text only, never data sent
// back to the engine.

const BRAND_REWRITES = [
  [/OpenClaw Gateway/gi, 'Uniopc 本地服务'],
  [/@openclaw\/codex/gi, 'Uniopc 模型组件'],
  [/\bopenclaw\s+doctor(?:\s+--[\w-]+)*/gi, '运行环境诊断'],
  [/\bopenclaw\s+secrets\s+apply\b/gi, '应用模型密钥'],
  [/\bopenclaw\s+backup\s+create\b/gi, '创建本地备份'],
  [/\b(?:docs\.)?openclaw\.(?:ai|bot)\b/gi, 'Uniopc 帮助中心'],
  [/openclaw/gi, 'Uniopc'],
]

// Generated media stays in a profile-private state directory. The full path
// is needed by the renderer, but is implementation detail and must not leak
// into assistant prose when a model echoes a tool result verbatim.
const INTERNAL_MEDIA_PATH = /(?:MEDIA:)?\/.*?\/state-v8\/(?:openclaw|Uniopc)-[^/\s]+(?:\/[^/\s]+)*\/media(?:\/[^/\s]+)*\/([^/\s]+\.(?:mp4|mov|webm|m4v))/gi

export function sanitizeBrand(text) {
  if (typeof text !== 'string' || !text) return text
  let output = text.replace(INTERNAL_MEDIA_PATH, (_match, fileName) => `本地视频：${fileName}`)
  for (const [pattern, replacement] of BRAND_REWRITES) {
    output = output.replace(pattern, replacement)
  }
  return output
}
