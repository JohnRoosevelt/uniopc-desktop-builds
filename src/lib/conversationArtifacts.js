// Extension is explicit: `node --test` loads this module directly (see
// conversationArtifacts.test.mjs) and will not resolve a bare specifier.
import { invoke } from '@tauri-apps/api/core'
import { collectConversationArtifacts } from './conversationMessageFormatting.js'

// Tool-derived 产物 (artifacts).
//
// The chat text is an unreliable record of what a turn produced: the `MEDIA:`
// token only ever covers generated images/videos, and everything else — a
// .pptx built by a python script, a report written by the `write` tool — shows
// up as, at best, a path the model happened to print. The gateway's tool stream
// knows the truth, so Rust extracts file paths off every tool call
// (`services/tool_artifacts.rs`) and the UI records them here, keyed by owner so
// the global panel can read them without the Conversations page being mounted.

const STORAGE_PREFIX = 'imai.tool-artifacts.v1'
// Bound the store: artifacts are cheap rows, but a long-running install should
// not grow without limit. Oldest entries fall off first. The Rust-backed file
// makes this a soft budget (~1MB of JSON), not a localStorage-quota fight.
const MAX_STORED_ARTIFACTS = 5000
const RUST_INDEX_VERSION = 1

const ARTIFACT_KIND_BY_EXTENSION = {
  doc: 'word', docx: 'word', odt: 'word', rtf: 'word',
  ppt: 'slides', pptx: 'slides', odp: 'slides',
  xls: 'sheet', xlsx: 'sheet', csv: 'sheet', tsv: 'sheet', ods: 'sheet',
  pdf: 'pdf',
  md: 'markdown', markdown: 'markdown', txt: 'text',
  html: 'code', htm: 'code', json: 'code', yaml: 'code', yml: 'code', tex: 'code',
  zip: 'archive', tar: 'archive', gz: 'archive', '7z': 'archive', rar: 'archive',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio',
}

const ARTIFACT_ICON_BY_KIND = {
  word: '📄',
  slides: '📊',
  sheet: '📈',
  pdf: '📕',
  markdown: '📝',
  text: '📃',
  code: '🧾',
  archive: '🗜',
  audio: '🎵',
  file: '📎',
}

function storageKey(ownerId) {
  return `${STORAGE_PREFIX}:${ownerId || 'guest'}`
}

// ---------------------------------------------------------------------------
// Storage backend.
//
// In the Tauri app the index lives in a per-account file owned by Rust
// (`services/artifact_index.rs`, commands `artifact_index_read/write`) — that
// survives webview resets and raises the row cap. Reads must stay synchronous
// for the panel, so the file is mirrored into `rustCache` once at startup
// (`ensureToolArtifactStore`) and every write updates the mirror first, then
// persists fire-and-forget. Outside Tauri (unit tests, plain browser) the
// legacy localStorage path is the backend.
// ---------------------------------------------------------------------------

function isTauriHost() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
}

let rustCache = null // { ownerId, items } — in-memory mirror of the Rust file
let ensurePromise = null
let pendingRecords = [] // records that arrived before the mirror finished loading

function persistRustCache() {
  if (!rustCache) return
  const payload = JSON.stringify({ version: RUST_INDEX_VERSION, items: rustCache.items })
  invoke('artifact_index_write', { content: payload }).catch(() => {
    // Disk refused the write (full/locked): the in-memory mirror still serves
    // this session; next successful write persists the merged state.
  })
}

function parseRustIndex(content) {
  try {
    const parsed = JSON.parse(content || '{}')
    const items = Array.isArray(parsed?.items) ? parsed.items : []
    return items.filter(item => item && typeof item.path === 'string')
  } catch {
    return []
  }
}

// Loads the Rust-backed index into the in-memory mirror (once per owner) and
// migrates any legacy localStorage rows into it. Safe to call repeatedly; a
// no-op outside Tauri.
export async function ensureToolArtifactStore(ownerId) {
  if (!isTauriHost()) return
  if (rustCache && rustCache.ownerId === (ownerId || null)) return
  if (ensurePromise) return ensurePromise
  ensurePromise = (async () => {
    let items = []
    try {
      items = parseRustIndex(await invoke('artifact_index_read'))
    } catch {
      // Unreadable index: start empty rather than blocking the panel.
    }
    // One-time migration of the legacy localStorage store for this owner.
    let migrated = []
    try {
      migrated = JSON.parse(window.localStorage?.getItem(storageKey(ownerId)) || '[]')
      if (!Array.isArray(migrated)) migrated = []
    } catch {
      migrated = []
    }
    rustCache = { ownerId: ownerId || null, items: mergeArtifactLists(migrated, items) }
    if (migrated.length > 0) {
      try {
        window.localStorage?.removeItem(storageKey(ownerId))
      } catch {
        // Losing the cleanup only means a redundant re-merge next launch.
      }
      persistRustCache()
    }
    const queued = pendingRecords
    pendingRecords = []
    for (const { ownerId: queuedOwner, entries } of queued) {
      recordToolArtifacts(queuedOwner, entries)
    }
    window.dispatchEvent(new CustomEvent('imai:conversations-updated'))
  })().finally(() => {
    ensurePromise = null
  })
  return ensurePromise
}

// Merges two normalized lists by path, later list winning field-wise but
// declared metadata never degrading (same rule as mergeToolArtifactRecords).
function mergeArtifactLists(base, overlay) {
  const byPath = new Map()
  for (const raw of [...base, ...overlay]) {
    const item = normalizeToolArtifact(raw)
    if (!item) continue
    const previous = byPath.get(item.path)
    byPath.delete(item.path)
    byPath.set(item.path, mergeToolArtifactRecords(previous, item))
  }
  return Array.from(byPath.values()).slice(-MAX_STORED_ARTIFACTS)
}

export function artifactFileName(path) {
  const value = String(path || '')
  return value.split('/').pop() || value
}

export function artifactFileKind(path) {
  const name = artifactFileName(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'file'
  return ARTIFACT_KIND_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] || 'file'
}

export function artifactIcon(kind) {
  return ARTIFACT_ICON_BY_KIND[kind] || ARTIFACT_ICON_BY_KIND.file
}

// How the preview modal renders an artifact. Modes:
//   image/video/audio — native media element via the asset protocol
//   pdf/html          — iframe via the asset protocol (html sandboxed)
//   markdown          — text read through Rust, rendered with ReactMarkdown
//   text              — text read through Rust, shown with syntax highlight
//   external          — no in-app preview (Office/archives): hand to the OS
const PREVIEW_MODE_BY_EXTENSION = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', svg: 'image', bmp: 'image',
  mp4: 'video', mov: 'video', webm: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio',
  pdf: 'pdf',
  html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown',
  txt: 'text', json: 'text', yaml: 'text', yml: 'text', tex: 'text', csv: 'text', tsv: 'text',
  js: 'text', mjs: 'text', ts: 'text', tsx: 'text', jsx: 'text', py: 'text', rs: 'text',
  css: 'text', sh: 'text', sql: 'text', xml: 'text', toml: 'text', log: 'text',
}

const INLINE_VIDEO_PATH = /\.(?:mp4|mov|webm|m4v)$/i
const VIDEO_PRODUCTION_TOOLS = new Set([
  'uniopc_montage_produce_video',
  'uniopc_superip_produce_video',
  'uniopc_superip_monologue_produce_video',
  'uniopc_superip_dialogue_produce_video',
  'uniopc_superip_presentation_produce_video',
])

function inlineVideoPath(value) {
  const path = String(value || '').trim().replace(/^MEDIA:/i, '')
  return path.startsWith('/') && INLINE_VIDEO_PATH.test(path) ? path : ''
}

function montageResultVideoPath(preview) {
  try {
    const result = JSON.parse(preview)
    return result?.mediaRef || result?.outputPath || ''
  } catch {
    // Gateway previews are deliberately length-capped, so a valid JSON result
    // may end after `outputPath`. Extract only the quoted local video field;
    // arbitrary prose never earns an inline player.
    return String(preview || '').match(/"(?:mediaRef|outputPath)"\s*:\s*"((?:MEDIA:)?\/[^"\\]+?\.(?:mp4|mov|webm|m4v))"/i)?.[1] || ''
  }
}

// A tool result is the authoritative source for generated media. The assistant
// prose is intentionally not consulted here: it may shorten the filename or
// omit the `MEDIA:` marker altogether. Keep a tiny compatibility fallback for
// timelines persisted before toolArtifacts existed.
export function collectTimelineVideoMedia(timeline, { messageContent = '' } = {}) {
  const seen = new Set()
  const tokens = []
  const add = value => {
    const path = inlineVideoPath(value)
    if (!path || seen.has(path)) return
    seen.add(path)
    tokens.push({ type: 'media', value: path, mediaKind: 'video' })
  }

  for (const step of timeline?.steps || []) {
    for (const artifact of Array.isArray(step?.artifacts) ? step.artifacts : []) {
      if (artifact?.kind === 'video' || INLINE_VIDEO_PATH.test(String(artifact?.path || ''))) add(artifact?.path)
    }
    if (!VIDEO_PRODUCTION_TOOLS.has(step?.name) || !step?.resultPreview) continue
    const legacyPath = inlineVideoPath(montageResultVideoPath(step.resultPreview))
    // An old timeline can be attached to an intermediate assistant thought.
    // Before structured artifacts existed, only recover it when that reply
    // actually names the generated file; new toolArtifacts never need prose.
    if (legacyPath && String(messageContent || '').includes(legacyPath.split('/').pop())) add(legacyPath)
  }
  // A few gateway versions retain the structured video block only in their
  // internal transcript and expose its completed local output path in the
  // assistant text on history replay. This is still a narrow, verifiable
  // production result shape; recover it so a reload cannot strand the video.
  for (const match of String(messageContent || '').matchAll(/\/[^\n`]+?\/state-v8\/(?:uniopc|openclaw)-[^/\s]+(?:\/[^/\s]+)*\/media\/uniopc-(?:montage|superip)\/[^/\s]+?\.(?:mp4|mov|webm|m4v)/gi)) {
    add(match[0])
  }
  return tokens
}

export function artifactPreviewMode(artifact) {
  // Media kinds set by the panel (MEDIA: tokens or declared image/video) win.
  if (artifact?.kind === 'image' || artifact?.kind === 'video') return artifact.kind
  const name = artifactFileName(artifact?.path)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return PREVIEW_MODE_BY_EXTENSION[ext] || 'external'
}

export function listStoredToolArtifacts(ownerId) {
  if (isTauriHost()) {
    if (!rustCache || rustCache.ownerId !== (ownerId || null)) {
      // Mirror not loaded (or another account's): kick the load and report
      // empty; the ensure() completion broadcast re-renders the panel.
      void ensureToolArtifactStore(ownerId)
      return []
    }
    return rustCache.items
  }
  if (typeof window === 'undefined' || !window.localStorage) return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(ownerId)) || '[]')
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item.path === 'string') : []
  } catch {
    return []
  }
}

// Appends newly produced files, newest-last, de-duplicated by path. A repeated
// write to the same path refreshes its timestamp/operation rather than adding a
// second card — the panel is "what exists now", not an edit log.
export function recordToolArtifacts(ownerId, entries) {
  if (typeof window === 'undefined') return []
  const incoming = (Array.isArray(entries) ? entries : [])
    .map(entry => normalizeToolArtifact(entry))
    .filter(Boolean)
  if (incoming.length === 0) return listStoredToolArtifacts(ownerId)

  if (isTauriHost()) {
    if (!rustCache || rustCache.ownerId !== (ownerId || null)) {
      // Mirror still loading: queue and let ensure() replay us in order.
      pendingRecords.push({ ownerId, entries: incoming })
      void ensureToolArtifactStore(ownerId)
      return rustCache?.items || []
    }
    rustCache.items = mergeArtifactLists(rustCache.items, incoming)
    persistRustCache()
    window.dispatchEvent(new CustomEvent('imai:conversations-updated'))
    return rustCache.items
  }

  if (!window.localStorage) return []
  const byPath = new Map()
  for (const item of listStoredToolArtifacts(ownerId)) byPath.set(item.path, item)
  for (const item of incoming) {
    const previous = byPath.get(item.path)
    byPath.delete(item.path)
    byPath.set(item.path, mergeToolArtifactRecords(previous, item))
  }
  const next = Array.from(byPath.values()).slice(-MAX_STORED_ARTIFACTS)
  try {
    window.localStorage.setItem(storageKey(ownerId), JSON.stringify(next))
    window.dispatchEvent(new CustomEvent('imai:conversations-updated'))
  } catch {
    // storage full / unavailable — the in-memory panel still refreshes on open
  }
  return next
}

function normalizeToolArtifact(entry) {
  const path = String(entry?.path || '').trim()
  if (!path) return null
  return {
    path,
    operation: String(entry?.operation || 'unknown'),
    // `declared` = the model presented this file via uniopc_present_artifacts;
    // anything else is a sniffed guess from tool args.
    origin: entry?.origin === 'declared' ? 'declared' : 'sniffed',
    title: String(entry?.title || '').trim(),
    kind: String(entry?.kind || '').trim(),
    toolName: String(entry?.toolName || ''),
    messageId: entry?.messageId != null ? String(entry.messageId) : '',
    conversationId: entry?.conversationId != null ? String(entry.conversationId) : '',
    at: Number.isFinite(entry?.at) ? entry.at : Date.now(),
  }
}

// A declaration is the model's own word and must not be degraded by a later
// sniffed sighting of the same path: keep the declared origin/title/kind while
// still refreshing timestamp and operation.
function mergeToolArtifactRecords(previous, incoming) {
  if (!previous) return incoming
  const merged = { ...previous, ...incoming }
  if (previous.origin === 'declared' && incoming.origin !== 'declared') {
    merged.origin = 'declared'
    if (!incoming.title) merged.title = previous.title || ''
    if (!incoming.kind) merged.kind = previous.kind || ''
  }
  return merged
}

// Declared semantic kinds (uniopc_present_artifacts `kind`) → the panel's
// fileKind vocabulary. Falls back to extension-derived kind when absent.
const PANEL_KIND_BY_DECLARED_KIND = {
  document: 'word',
  slides: 'slides',
  sheet: 'sheet',
  pdf: 'pdf',
  code: 'code',
  web: 'code',
  audio: 'audio',
  archive: 'archive',
  other: 'file',
}

// `deleted` files are recorded (the tool really did touch them) but never shown:
// a card pointing at something that no longer exists is pure noise.
export function toolArtifactsToPanelItems(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter(entry => entry && entry.operation !== 'deleted')
    .map(entry => {
      // A declared image/video is renderable media: give it the media kind so
      // the panel shows a real thumbnail instead of a type glyph.
      const declaredMedia = entry.kind === 'image' || entry.kind === 'video' ? entry.kind : ''
      return {
        path: entry.path,
        kind: declaredMedia || 'file',
        fileKind: PANEL_KIND_BY_DECLARED_KIND[entry.kind] || artifactFileKind(entry.path),
        // A deliverable card must name the actual file, including its suffix.
        // Titles are useful metadata, but showing only one hides whether this
        // is a DOCX, PDF, or another artifact from the user.
        name: artifactFileName(entry.path),
        origin: entry.origin === 'declared' ? 'declared' : 'sniffed',
        messageId: entry.messageId || '',
        operation: entry.operation || 'unknown',
        toolName: entry.toolName || '',
        at: entry.at || 0,
      }
    })
}

// Merges the two sources into the single list the panel renders. Media wins on a
// path collision because it is the only kind we can show a real thumbnail for.
export function mergeArtifactSources(mediaArtifacts, fileArtifacts) {
  const merged = []
  const seen = new Set()
  for (const item of [...(mediaArtifacts || []), ...(fileArtifacts || [])]) {
    if (!item || !item.path || seen.has(item.path)) continue
    seen.add(item.path)
    merged.push(item)
  }
  return merged
}

// One call for the panel: every media file the assistant produced across all
// stored conversations, plus every file a tool wrote.
export function collectAllArtifacts(conversations, toolArtifacts) {
  const allMessages = (Array.isArray(conversations) ? conversations : [])
    .flatMap(item => (Array.isArray(item?.messages) ? item.messages : []))
  return mergeArtifactSources(
    collectConversationArtifacts(allMessages),
    toolArtifactsToPanelItems(toolArtifacts),
  )
}
