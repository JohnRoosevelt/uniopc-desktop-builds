// Media paths may contain spaces (macOS "Application Support"), so match
// non-greedily up to a known extension and stop at a whitespace/quote/paren/CJK
// boundary — `[^\s]+` used to break on the first space and drop the token.
const MEDIA_PATH = '\\/.+?\\.(?:png|jpe?g|gif|webp|bmp|mp4|mov|webm|m4v)(?![A-Za-z0-9])'
const COMMAND_PATTERN = new RegExp('`(?<code>[^`]+)`|@(?<atKind>project):(?<atName>[A-Za-z0-9_.@/-]+)|@(?<documentKind>doc):(?<documentName>《[^》\\r\\n]+》|[A-Za-z0-9_.@/-]+)|\\/(?<slashKind>plugin|mcp|skill):(?<slashName>[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_:-]+)?)|MEDIA:(?<mediaPath>' + MEDIA_PATH + ')', 'gi')
const MEDIA_ONLY_PATTERN = new RegExp('MEDIA:(?<mediaPath>' + MEDIA_PATH + ')', 'gi')
const VIDEO_MEDIA_PATTERN = /\.(?:mp4|mov|webm|m4v)$/i
const CAPABILITY_CODE_PATTERN = /^(?:(plugin|mcp|skill):)?[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+(?:\.[A-Za-z0-9_:-]+)?$/

export function capabilityKindFromCode(value) {
  const trimmed = String(value || '').trim()
  const prefixed = trimmed.match(/^(plugin|mcp|skill):(.+)$/)
  if (prefixed) return prefixed[1]
  return CAPABILITY_CODE_PATTERN.test(trimmed) ? 'plugin' : ''
}

function pushText(tokens, value) {
  if (!value) return
  const previous = tokens[tokens.length - 1]
  if (previous?.type === 'text') {
    previous.value += value
  } else {
    tokens.push({ type: 'text', value })
  }
}

export function tokenizeConversationMessageContent(source, { documentLabels = {} } = {}) {
  const value = String(source || '')
  const tokens = []
  let lastIndex = 0

  for (const match of value.matchAll(COMMAND_PATTERN)) {
    pushText(tokens, value.slice(lastIndex, match.index))
    const groups = match.groups || {}
    if (groups.mediaPath != null) {
      tokens.push({
        type: 'media',
        value: groups.mediaPath,
        mediaKind: VIDEO_MEDIA_PATTERN.test(groups.mediaPath) ? 'video' : 'image',
      })
    } else if (groups.code != null) {
      const code = groups.code
      const kind = capabilityKindFromCode(code)
      tokens.push(kind
        ? { type: 'capability', value: code, kind, source: 'code' }
        : { type: 'code', value: code })
    } else {
      const kind = groups.atKind || groups.documentKind || groups.slashKind
      const documentName = groups.documentName || ''
      const documentTitle = documentName.startsWith('《') && documentName.endsWith('》')
        ? documentName.slice(1, -1)
        : ''
      const documentLabel = kind === 'doc'
        ? documentTitle || documentLabels[documentName] || documentName
        : ''
      tokens.push({
        type: 'capability',
        value: match[0],
        kind,
        ...(kind === 'doc' ? { label: `@doc:${documentLabel}` } : {}),
        source: 'command',
      })
    }
    lastIndex = match.index + match[0].length
  }

  pushText(tokens, value.slice(lastIndex))
  return tokens
}

// Collects every distinct media file an assistant produced across a session, in
// order of first appearance. Powers the "产物" (artifacts) drawer — the chat
// stream shows files inline, this gives one place to see/reuse the whole set.
export function collectConversationArtifacts(messages) {
  const list = Array.isArray(messages) ? messages : []
  const seen = new Set()
  const artifacts = []
  for (const message of list) {
    if (!message || message.role !== 'assistant') continue
    for (const token of tokenizeConversationMessageContent(message.content)) {
      if (token.type !== 'media' || seen.has(token.value)) continue
      seen.add(token.value)
      artifacts.push({
        path: token.value,
        kind: token.mediaKind,
        name: token.value.split('/').pop() || token.value,
        messageId: message.id != null ? String(message.id) : '',
      })
    }
  }
  return artifacts
}

// Splits assistant content into text / media segments so the markdown renderer
// never sees the MEDIA: pseudo-syntax (it would read as plain text).
export function splitConversationMediaSegments(source) {
  const value = String(source || '')
  const segments = []
  let lastIndex = 0

  for (const match of value.matchAll(MEDIA_ONLY_PATTERN)) {
    const leading = value.slice(lastIndex, match.index)
    if (leading.trim()) segments.push({ type: 'text', value: leading })
    const mediaPath = match.groups.mediaPath
    segments.push({
      type: 'media',
      value: mediaPath,
      mediaKind: VIDEO_MEDIA_PATTERN.test(mediaPath) ? 'video' : 'image',
    })
    lastIndex = match.index + match[0].length
  }

  const trailing = value.slice(lastIndex)
  if (trailing.trim() || segments.length === 0) segments.push({ type: 'text', value: trailing })
  return segments
}
