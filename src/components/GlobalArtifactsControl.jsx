import { useCallback, useEffect, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import {
  artifactIcon,
  collectAllArtifacts,
  ensureToolArtifactStore,
  listStoredToolArtifacts,
} from '../lib/conversationArtifacts'
import { listStoredConversations } from '../lib/conversationStore'
import { useAuth } from '../hooks/useAuth'
import { ArtifactPreviewModal } from './ArtifactPreview'

// A global 产物 (artifacts) hub. Instead of hiding generated files inside
// whichever conversation produced them (hard to find), it aggregates every
// artifact across ALL of the owner's stored conversations into one place.
//
// Two sources, because neither alone is enough:
//   - `MEDIA:` tokens in assistant text — generated images/videos only.
//   - tool events — every file a tool wrote (.pptx, .docx, .pdf, …), extracted
//     from the tool call in Rust (`services/tool_artifacts.rs`).
// Both come from local storage, so the panel works app-wide without the
// Conversations page being mounted.
//
// Accio-style, this is a DOCKED side panel (not an overlay drawer): a toggle in
// the titlebar (GlobalArtifactsToggle) flips shared state (useGlobalArtifacts),
// and the panel (GlobalArtifactsPanel) lives inline in the layout row so opening
// it shrinks the main content instead of floating over it with a backdrop.
function collectGlobalArtifacts(ownerId) {
  // listStoredConversations is sorted newest-first; flattening in that order and
  // deduping by path keeps the most recently produced files at the front.
  return collectAllArtifacts(listStoredConversations(ownerId), listStoredToolArtifacts(ownerId))
}

const OPERATION_LABEL = {
  created: '新增',
  modified: '修改',
}

// Panel type filter: chips over the artifact grid. Categories are coarse on
// purpose — this is "narrow 200 cards down", not a file manager.
const ARTIFACT_FILTERS = [
  { id: 'all', label: '全部', match: () => true },
  {
    id: 'media',
    label: '媒体',
    match: item => item.kind === 'image' || item.kind === 'video' || item.fileKind === 'audio',
  },
  {
    id: 'docs',
    label: '文档',
    match: item =>
      item.kind === 'file'
      && ['word', 'slides', 'sheet', 'pdf', 'markdown', 'text'].includes(item.fileKind),
  },
  { id: 'code', label: '代码', match: item => item.kind === 'file' && item.fileKind === 'code' },
  {
    id: 'other',
    label: '其他',
    match: item => item.kind === 'file' && ['archive', 'file'].includes(item.fileKind),
  },
]

function isMediaArtifact(artifact) {
  return artifact?.kind === 'image' || artifact?.kind === 'video'
}

function formatArtifactSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// A thumbnail that degrades gracefully: a generated file can be missing on disk
// or live outside the Tauri asset-protocol scope, in which case the browser
// would render a bare broken-image glyph. We catch that and show a labelled
// placeholder so the artifact is never a mystery "?".
function ArtifactThumb({ artifact }) {
  const [failed, setFailed] = useState(false)
  // Non-media files have no renderable preview at all — show the type glyph
  // rather than pretending an <img> could load a .pptx.
  if (!isMediaArtifact(artifact) || failed) {
    const icon = isMediaArtifact(artifact)
      ? (artifact.kind === 'video' ? '🎬' : '🖼')
      : artifactIcon(artifact?.fileKind)
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-surface-sunken text-tertiary">
        <span className="text-2xl opacity-60" aria-hidden="true">{icon}</span>
        {failed && <span className="px-2 text-center text-2xs leading-tight">文件不可用</span>}
      </div>
    )
  }
  const src = convertFileSrc(artifact.path)
  if (artifact.kind === 'video') {
    return (
      <video
        src={src}
        preload="metadata"
        className="h-full w-full object-cover"
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <img
      src={src}
      alt={artifact.name}
      loading="lazy"
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  )
}

// Shared state for the 产物 hub. Held once in Layout and passed to both the
// titlebar toggle and the docked panel so they stay in sync.
export function useGlobalArtifacts() {
  const { user } = useAuth()
  const ownerId = user?.uid || null
  const [open, setOpen] = useState(false)
  const [artifacts, setArtifacts] = useState([])
  const [preview, setPreview] = useState(null)

  const refresh = useCallback(() => {
    const collected = collectGlobalArtifacts(ownerId)
    setArtifacts(collected)
    // Tool events name a file the moment the call starts, and an `exec` command
    // line can mention a path it only reads. Ask the filesystem which of them
    // are real before they earn a card, and pick up size/mtime while we're
    // there. Media artifacts go through the same check so a deleted generated
    // image stops showing a broken thumbnail.
    const paths = collected.map(item => item.path)
    if (paths.length === 0) return
    invoke('artifact_stat_paths', { paths })
      .then(stats => {
        const byPath = new Map((stats || []).map(stat => [stat.path, stat]))
        setArtifacts(collected
          .filter(item => byPath.get(item.path)?.exists && !byPath.get(item.path)?.isDirectory)
          .map(item => ({
            ...item,
            size: byPath.get(item.path)?.size || 0,
            modifiedAt: byPath.get(item.path)?.modifiedAt || 0,
          })))
      })
      .catch(() => {
        // Stat unavailable (non-Tauri host / command error): show the unfiltered
        // list rather than an empty panel.
      })
  }, [ownerId])

  useEffect(() => {
    // Load the Rust-backed index mirror first (it also migrates any legacy
    // localStorage rows), then render whatever is available.
    ensureToolArtifactStore(ownerId).finally(refresh)
    // Conversations broadcast on every persisted change; keep the global count
    // live by re-reading on our own broadcast plus cross-tab storage events.
    const onUpdate = () => refresh()
    // The per-conversation slot's "查看全部" opens the docked panel from afar.
    const onOpen = () => {
      refresh()
      setOpen(true)
    }
    window.addEventListener('imai:conversations-updated', onUpdate)
    window.addEventListener('storage', onUpdate)
    window.addEventListener('imai:open-artifacts-panel', onOpen)
    return () => {
      window.removeEventListener('imai:conversations-updated', onUpdate)
      window.removeEventListener('storage', onUpdate)
      window.removeEventListener('imai:open-artifacts-panel', onOpen)
    }
  }, [refresh])

  // Re-read on open so the panel always reflects the very latest state even if a
  // broadcast was missed.
  const toggle = useCallback(() => {
    setOpen(prev => {
      const next = !prev
      if (next) refresh()
      return next
    })
  }, [refresh])

  return { open, setOpen, toggle, artifacts, count: artifacts.length, preview, setPreview }
}

// Titlebar toggle: an icon-only right-panel expand glyph (Accio-style) that
// flips the docked panel open/closed. The live count lives in the panel header,
// so the titlebar stays a clean icon; it's still surfaced in the tooltip.
export function GlobalArtifactsToggle({ hub, rightClassName = 'right-[96px]' }) {
  const { open, toggle, count } = hub
  // Match the left sidebar toggle (TitlebarIconButton): transparent, hover-only,
  // no active fill. Open state only nudges the icon to the primary text color.
  const baseClassName = `pointer-events-auto absolute ${rightClassName} top-[8px] z-10 inline-flex h-5 w-5 items-center justify-center rounded-md bg-transparent transition-colors hover:bg-state-hover hover:text-primary`

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={open}
      title={count > 0 ? `产物（全局）· ${count}` : '产物（全局）'}
      aria-label="产物"
      className={`${baseClassName} ${
        open ? 'text-primary' : 'text-tertiary'
      }`}
    >
      {/* Right-panel expand icon — mirror of the left sidebar toggle glyph. */}
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4.25" y="4.75" width="15.5" height="14.5" rx="2.25" />
        <path strokeLinecap="round" d="M14.75 5v14" />
      </svg>
    </button>
  )
}

// One artifact card. Every type opens the in-app preview modal; the modal owns
// the "hand to the OS" fallback for formats it cannot render.
function ArtifactCard({ artifact, onPreview }) {
  const [actionError, setActionError] = useState('')
  const operationLabel = OPERATION_LABEL[artifact.operation] || ''
  const sizeLabel = formatArtifactSize(artifact.size)

  const runAction = (command, failureMessage) => event => {
    event.stopPropagation()
    setActionError('')
    invoke(command, { path: artifact.path }).catch(() => setActionError(failureMessage))
  }

  const copyPath = event => {
    event.stopPropagation()
    setActionError('')
    navigator.clipboard.writeText(artifact.path).catch(() => setActionError('复制失败'))
  }

  return (
    <div
      className="group flex flex-col overflow-hidden rounded-lg border border-subtle bg-surface-raised text-left transition-colors hover:border-violet-300/40"
    >
      <button
        type="button"
        onClick={() => onPreview(artifact)}
        title={`${artifact.name}（点击预览）`}
        className="flex aspect-square items-center justify-center overflow-hidden bg-surface-sunken"
      >
        <ArtifactThumb artifact={artifact} />
      </button>
      <div className="flex flex-col gap-0.5 px-2 py-1.5">
        <div className="truncate text-2xs text-secondary group-hover:text-primary" title={artifact.name}>
          {artifact.name}
        </div>
        <div className="flex items-center gap-1 text-2xs text-tertiary">
          {artifact.origin === 'declared' && (
            <span className="text-brand" title="AI 主动申报的交付物">✦</span>
          )}
          {operationLabel && <span>{operationLabel}</span>}
          {sizeLabel && <span>{sizeLabel}</span>}
          <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={runAction('artifact_reveal_in_dir', '定位失败')}
              title="在访达中显示"
              aria-label="在访达中显示"
              className="rounded px-1 hover:bg-state-hover hover:text-primary"
            >
              📁
            </button>
            <button
              type="button"
              onClick={copyPath}
              title="复制路径"
              aria-label="复制路径"
              className="rounded px-1 hover:bg-state-hover hover:text-primary"
            >
              ⧉
            </button>
          </span>
        </div>
        {actionError && <div className="text-2xs text-rose-400">{actionError}</div>}
      </div>
    </div>
  )
}

// Docked side panel: sits inside the main content frame (see Layout.jsx) and is
// split from the content by a single vertical divider line — no gap, no separate
// card. Opening it shrinks the content column rather than overlaying it. Closes
// from the ✕ in its header; there is no backdrop catcher.
export function GlobalArtifactsPanel({ hub }) {
  const { open, setOpen, artifacts, count, preview, setPreview } = hub
  const [filter, setFilter] = useState('all')
  const activeFilter = ARTIFACT_FILTERS.find(item => item.id === filter) || ARTIFACT_FILTERS[0]
  const visible = artifacts.filter(activeFilter.match)

  return (
    <>
      {open && (
        <aside className="hidden w-[340px] shrink-0 flex-col border-l border-subtle bg-surface-raised md:flex">
          <div className="flex h-14 shrink-0 items-center justify-between px-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-primary">
              <span aria-hidden="true">🗂</span>
              产物
              <span className="text-xs font-normal text-tertiary">{count}</span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="关闭产物"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-lg text-secondary transition-colors hover:bg-state-hover hover:text-primary"
              title="收起产物"
            >
              ✕
            </button>
          </div>
          {count > 0 && (
            <div className="flex shrink-0 flex-wrap gap-1 px-4 pb-2">
              {ARTIFACT_FILTERS.map(item => {
                const chipCount = item.id === 'all' ? count : artifacts.filter(item.match).length
                if (item.id !== 'all' && chipCount === 0) return null
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setFilter(item.id)}
                    aria-pressed={filter === item.id}
                    className={`rounded-full px-2.5 py-0.5 text-2xs transition-colors ${
                      filter === item.id
                        ? 'bg-brand/15 text-brand'
                        : 'text-tertiary hover:bg-state-hover hover:text-primary'
                    }`}
                  >
                    {item.label} {chipCount}
                  </button>
                )
              })}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {count === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-tertiary">
                <span className="text-2xl opacity-40" aria-hidden="true">🗂</span>
                <span className="text-xs">还没有生成任何文件</span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {visible.map(artifact => (
                <ArtifactCard key={artifact.path} artifact={artifact} onPreview={setPreview} />
              ))}
            </div>
          </div>
        </aside>
      )}

      {preview && <ArtifactPreviewModal artifact={preview} onClose={() => setPreview(null)} />}
    </>
  )
}
