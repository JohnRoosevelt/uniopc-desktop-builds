import { useEffect, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import 'highlight.js/styles/github.min.css'
import { artifactIcon, artifactPreviewMode } from '../lib/conversationArtifacts'

// Full-screen in-app preview for a produced artifact. Replaces the old
// image/video-only lightbox: markdown, code/text, PDF and HTML render inside
// the app, Office/archives degrade to an explicit "open with the OS" panel
// (an honest fallback beats a broken fake preview).
//
// Two loading paths, chosen per mode in artifactPreviewMode():
//   - asset protocol (convertFileSrc): media/PDF/HTML — streams from disk, but
//     only works inside the configured asset scope (engine media/workspace
//     dirs, where artifacts normally live).
//   - Rust read (artifact_read_text): markdown/code — works for any absolute
//     path, size-capped in Rust.
// HTML previews load in a sandboxed iframe on the asset origin: scripts run
// (charts work) but the document is cross-origin to the app and sandboxed, so
// it can never touch app state. This mirrors WorkBuddy's default-path model.

const REMARK_PLUGINS = [remarkGfm]

// Best-effort text load with the failure message kept for the fallback panel.
function useArtifactText(path, enabled) {
  const [state, setState] = useState({ status: 'loading', text: '' })
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setState({ status: 'loading', text: '' })
    invoke('artifact_read_text', { path })
      .then(text => {
        if (!cancelled) setState({ status: 'ready', text })
      })
      .catch(error => {
        if (!cancelled) setState({ status: 'error', text: String(error || '') })
      })
    return () => {
      cancelled = true
    }
  }, [path, enabled])
  return state
}

function PreviewStatus({ children }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-secondary">
      {children}
    </div>
  )
}

function TextLoadFallback({ artifact, status, onOpenExternal }) {
  if (status === 'loading') return <PreviewStatus><span className="text-sm">读取中…</span></PreviewStatus>
  return (
    <PreviewStatus>
      <span className="text-3xl opacity-50" aria-hidden="true">{artifactIcon(artifact?.fileKind)}</span>
      <span className="text-sm">文件读取失败</span>
      <button
        type="button"
        onClick={onOpenExternal}
        className="rounded-lg border border-subtle px-3 py-1.5 text-sm text-primary transition-colors hover:bg-state-hover"
      >
        用系统应用打开
      </button>
    </PreviewStatus>
  )
}

function MarkdownPreview({ artifact, onOpenExternal }) {
  const { status, text } = useArtifactText(artifact.path, true)
  if (status !== 'ready') {
    return <TextLoadFallback artifact={artifact} status={status} onOpenExternal={onOpenExternal} />
  }
  return (
    <div className="h-full overflow-y-auto bg-surface-raised">
      <div className="conversation-markdown mx-auto w-full max-w-3xl px-6 py-6">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown>
      </div>
    </div>
  )
}

// Syntax highlight is a lazy enhancement: plain <pre> first paint, colors when
// highlight.js/lib/common (its own chunk) finishes loading.
function TextPreview({ artifact, onOpenExternal }) {
  const { status, text } = useArtifactText(artifact.path, true)
  const [html, setHtml] = useState('')
  useEffect(() => {
    setHtml('')
    if (status !== 'ready' || !text) return
    let cancelled = false
    import('highlight.js/lib/common')
      .then(({ default: hljs }) => {
        if (cancelled) return
        const result = hljs.highlightAuto(text)
        setHtml(result.value || '')
      })
      .catch(() => {
        // Highlight unavailable — the plain <pre> below already shows the text.
      })
    return () => {
      cancelled = true
    }
  }, [status, text])
  if (status !== 'ready') {
    return <TextLoadFallback artifact={artifact} status={status} onOpenExternal={onOpenExternal} />
  }
  return (
    <div className="h-full overflow-auto bg-surface-raised">
      {html ? (
        <pre className="hljs min-h-full w-full whitespace-pre-wrap break-words px-6 py-4 text-xs leading-relaxed" style={{ background: 'transparent' }}>
          {/* highlight.js escapes all source text; its output is inert markup */}
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      ) : (
        <pre className="min-h-full w-full whitespace-pre-wrap break-words px-6 py-4 text-xs leading-relaxed text-primary">
          <code>{text}</code>
        </pre>
      )}
    </div>
  )
}

function ExternalFallback({ artifact, onOpenExternal, onReveal }) {
  return (
    <PreviewStatus>
      <span className="text-[44px] opacity-50" aria-hidden="true">{artifactIcon(artifact?.fileKind)}</span>
      <span className="text-sm text-primary">该文件类型暂不支持内置预览</span>
      <span className="text-xs text-tertiary">Office 文档用系统应用打开保真度最好</span>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenExternal}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm text-on-brand transition-opacity hover:opacity-90"
        >
          用系统应用打开
        </button>
        <button
          type="button"
          onClick={onReveal}
          className="rounded-lg border border-subtle px-3 py-1.5 text-sm text-primary transition-colors hover:bg-state-hover"
        >
          在访达中显示
        </button>
      </div>
    </PreviewStatus>
  )
}

function MediaFailure({ mode }) {
  return (
    <PreviewStatus>
      <span className="text-[44px] opacity-50" aria-hidden="true">{mode === 'video' ? '🎬' : mode === 'audio' ? '🎵' : '🖼'}</span>
      <span className="text-sm">文件不可用</span>
    </PreviewStatus>
  )
}

function PreviewBody({ artifact, mode, onOpenExternal, onReveal }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [artifact?.path])
  const src = convertFileSrc(artifact.path)

  if (mode === 'external') {
    return <ExternalFallback artifact={artifact} onOpenExternal={onOpenExternal} onReveal={onReveal} />
  }
  if (mode === 'markdown') return <MarkdownPreview artifact={artifact} onOpenExternal={onOpenExternal} />
  if (mode === 'text') return <TextPreview artifact={artifact} onOpenExternal={onOpenExternal} />
  if (failed) return <MediaFailure mode={mode} />

  if (mode === 'image') {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <img src={src} alt={artifact.name} className="max-h-full max-w-full rounded-lg object-contain" onError={() => setFailed(true)} />
      </div>
    )
  }
  if (mode === 'video') {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <video src={src} controls autoPlay className="max-h-full max-w-full rounded-lg object-contain" onError={() => setFailed(true)} />
      </div>
    )
  }
  if (mode === 'audio') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <span className="text-[44px] opacity-60" aria-hidden="true">🎵</span>
        <audio src={src} controls autoPlay className="w-[min(480px,80%)]" onError={() => setFailed(true)} />
      </div>
    )
  }
  if (mode === 'pdf') {
    // WKWebView/WebView2 render PDF natively inside the frame; needs the file
    // to be inside the asset scope — outside it the OS-open button still works.
    return <iframe src={src} title={artifact.name} className="h-full w-full border-0 bg-white" />
  }
  // mode === 'html' — sandboxed, cross-origin to the app: scripts may run for
  // charts/interactivity but cannot reach app state or the Tauri IPC bridge.
  return <iframe src={src} title={artifact.name} sandbox="allow-scripts" className="h-full w-full border-0 bg-white" />
}

// Modal chrome: name + actions header, Esc / backdrop / ✕ to close. Same
// interaction contract as the old lightbox, now for every artifact type.
export function ArtifactPreviewModal({ artifact, onClose }) {
  const [actionError, setActionError] = useState('')
  useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => setActionError(''), [artifact?.path])
  if (!artifact) return null

  const mode = artifactPreviewMode(artifact)
  const runAction = (command, failureMessage) => () => {
    setActionError('')
    invoke(command, { path: artifact.path }).catch(() => setActionError(failureMessage))
  }
  const openExternal = runAction('artifact_open_path', '打开失败')
  const reveal = runAction('artifact_reveal_in_dir', '定位失败')
  const copyPath = () => {
    setActionError('')
    navigator.clipboard.writeText(artifact.path).catch(() => setActionError('复制失败'))
  }

  const headerButton = 'inline-flex h-8 items-center justify-center rounded-lg px-2 text-sm text-primary/70 transition-colors hover:bg-state-hover hover:text-primary'
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={artifact.name}
      className="pointer-events-auto fixed inset-0 z-[80] flex flex-col bg-scrim-strong backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-4" onClick={event => event.stopPropagation()}>
        <span className="min-w-0 truncate text-sm font-medium text-primary/90" title={artifact.path}>
          {artifact.name}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {actionError && <span className="text-xs text-rose-400">{actionError}</span>}
          <button type="button" onClick={openExternal} className={headerButton} title="用系统应用打开">打开</button>
          <button type="button" onClick={reveal} className={headerButton} title="在访达中显示">📁</button>
          <button type="button" onClick={copyPath} className={headerButton} title="复制路径">⧉</button>
          <button type="button" onClick={onClose} className={`${headerButton} w-8 px-0 text-xl`} title="关闭">✕</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 px-4 pb-4" onClick={event => event.stopPropagation()}>
        <div className="h-full overflow-hidden rounded-lg border border-subtle bg-surface-raised">
          <PreviewBody artifact={artifact} mode={mode} onOpenExternal={openExternal} onReveal={reveal} />
        </div>
      </div>
    </div>
  )
}
