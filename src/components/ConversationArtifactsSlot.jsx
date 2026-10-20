import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  artifactFileKind,
  artifactIcon,
  listStoredToolArtifacts,
  toolArtifactsToPanelItems,
} from '../lib/conversationArtifacts'
import { listConversationSessionFiles } from '../lib/conversations/client'
import { ArtifactPreviewModal } from './ArtifactPreview'

// WorkBuddy-style per-conversation artifact strip: the current conversation's
// top deliverables inline, with "查看全部" jumping to the global docked panel.
//
// Two merged sources, because neither alone covers everything:
//   - the local artifact index filtered to this conversation — declared
//     (present_artifacts) and sniffed entries, including files written outside
//     the agent workspace;
//   - the engine's `sessions.files.list` — authoritative for in-workspace
//     writes replayed from the transcript, and the only source that survives a
//     cleared local index.
// Local entries win a path collision (they carry declared titles/kinds).
const MAX_SLOT_ITEMS = 6

function engineFilesToPanelItems(files) {
  return files
    .filter(file => file.kind === 'modified')
    .map(file => ({
      path: file.path,
      kind: 'file',
      fileKind: artifactFileKind(file.path),
      name: file.name,
      origin: 'engine',
      messageId: '',
      operation: 'modified',
      toolName: '',
      at: file.updatedAtMs || 0,
    }))
}

export function openGlobalArtifactsPanel() {
  window.dispatchEvent(new CustomEvent('imai:open-artifacts-panel'))
}

export function ConversationArtifactsSlot({ ownerId, conversationId, sessionKey, profile, gatewayReady = false }) {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [preview, setPreview] = useState(null)

  const refresh = useCallback(() => {
    if (!conversationId) {
      setItems([])
      setTotal(0)
      return
    }
    const localItems = toolArtifactsToPanelItems(
      listStoredToolArtifacts(ownerId).filter(entry => entry.conversationId === String(conversationId)),
    )
    const apply = merged => {
      // Ask the filesystem before a card earns a spot: tool events name files
      // before they exist, and stale entries outlive deletions.
      const paths = merged.map(item => item.path)
      if (paths.length === 0) {
        setItems([])
        setTotal(0)
        return
      }
      invoke('artifact_stat_paths', { paths })
        .then(stats => {
          const byPath = new Map((stats || []).map(stat => [stat.path, stat]))
          const alive = merged
            .filter(item => byPath.get(item.path)?.exists && !byPath.get(item.path)?.isDirectory)
            .map(item => ({ ...item, size: byPath.get(item.path)?.size || 0 }))
          setTotal(alive.length)
          setItems(alive.slice(0, MAX_SLOT_ITEMS))
        })
        .catch(() => {
          setTotal(merged.length)
          setItems(merged.slice(0, MAX_SLOT_ITEMS))
        })
    }
    // File enumeration uses Gateway RPC with automatic recovery. During boot
    // it would compete with login warmup; the local index already works offline.
    if (!gatewayReady) {
      apply(localItems)
      return
    }
    listConversationSessionFiles(sessionKey, profile || null).then(files => {
      const byPath = new Map()
      for (const item of [...engineFilesToPanelItems(files), ...localItems]) {
        byPath.set(item.path, item) // local overwrites engine on collision
      }
      apply(Array.from(byPath.values()).sort((a, b) => (b.at || 0) - (a.at || 0)))
    })
  }, [ownerId, conversationId, sessionKey, profile, gatewayReady])

  useEffect(() => {
    refresh()
    const onUpdate = () => refresh()
    window.addEventListener('imai:conversations-updated', onUpdate)
    return () => window.removeEventListener('imai:conversations-updated', onUpdate)
  }, [refresh])

  if (items.length === 0) return null

  return (
    <div className="border-t border-subtle px-4 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-secondary">本会话产物</span>
        <button
          type="button"
          onClick={openGlobalArtifactsPanel}
          className="text-xs text-tertiary transition-colors hover:text-primary"
        >
          查看全部 ({total}) →
        </button>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {items.map(item => (
          <button
            key={item.path}
            type="button"
            onClick={() => setPreview(item)}
            title={`${item.name}（点击预览）`}
            className="flex max-w-[220px] shrink-0 items-center gap-2 rounded-lg border border-subtle bg-surface-raised px-2.5 py-1.5 text-left transition-colors hover:border-violet-300/40"
          >
            <span className="text-base" aria-hidden="true">{artifactIcon(item.fileKind)}</span>
            <span className="truncate text-xs text-primary">{item.name}</span>
          </button>
        ))}
      </div>
      {preview && <ArtifactPreviewModal artifact={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}
