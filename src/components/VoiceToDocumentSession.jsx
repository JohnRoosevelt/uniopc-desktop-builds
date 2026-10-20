import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ACTION, SURFACE } from '../lib/theme'
import { createLocalDocument, documentTitleFromMarkdown } from '../lib/localDocuments'
import { TRANSCRIPTION_JOB_METADATA_KEY } from '../lib/voiceTranscription'
import { profileWorkspaceNavigationState, useProfileWorkspace } from '../hooks/useProfileWorkspace'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import VoiceToDocumentPanel from './VoiceToDocumentPanel'

const VoiceToDocumentSessionContext = createContext(null)

function documentPathForLocation(location) {
  const profileMatch = String(location?.pathname || '').match(/^\/profiles\/[^/]+/)
  return profileMatch ? `${profileMatch[0]}/cloud-documents` : '/cloud-documents'
}

export function useVoiceToDocumentSession() {
  const value = useContext(VoiceToDocumentSessionContext)
  if (!value) throw new Error('useVoiceToDocumentSession must be used within VoiceToDocumentSessionProvider')
  return value
}

export function VoiceToDocumentSessionProvider({ children }) {
  const navigate = useNavigate()
  const location = useLocation()
  const activeOpenClaw = useActiveOpenClawProfile()
  const profileWorkspace = useProfileWorkspace()
  const activeProfile = profileWorkspace?.activeProfile || activeOpenClaw?.activeProfile || ''
  const [sessionOpen, setSessionOpen] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const [completedDocument, setCompletedDocument] = useState(null)

  const openVoiceToDocument = useCallback(() => {
    setCompletedDocument(null)
    setMinimized(false)
    setSessionOpen(true)
  }, [])

  const dismissVoiceToDocument = useCallback(() => {
    setSessionOpen(false)
    setMinimized(false)
    setCompletedDocument(null)
  }, [])

  const handleTranscriptComplete = useCallback(async ({ markdown, title, jobId } = {}) => {
    if (!activeProfile) throw new Error('当前没有可用的工作区，无法保存录音转写文档')

    const { createCloudCrdtDocumentFromMarkdown, CLOUD_BLOCKSUITE_BODY_FORMAT } = await import('../lib/cloudBlocksuite')
    const converted = await createCloudCrdtDocumentFromMarkdown(markdown, title)
    const created = await createLocalDocument({
      title: documentTitleFromMarkdown(converted.markdown, title),
      profile: activeProfile,
      content: converted.body,
      bodyFormat: CLOUD_BLOCKSUITE_BODY_FORMAT,
      metadata: {
        markdown_projection: converted.markdown,
        category: 'other',
        ...(jobId ? { [TRANSCRIPTION_JOB_METADATA_KEY]: jobId } : {}),
      },
    })
    if (!created?.id) throw new Error('保存转写文档失败')

    // The document page stays mounted behind this global recording session.
    // Tell that cached list about the new row before the panel closes, so a
    // completed recording never requires a manual refresh to appear.
    window.dispatchEvent(new CustomEvent('uniopc:local-documents-changed', {
      detail: { profile: activeProfile, documentId: created.id },
    }))

    setCompletedDocument({
      id: created.id,
      path: documentPathForLocation(location),
      state: profileWorkspaceNavigationState(profileWorkspace),
    })
    setMinimized(false)
    setSessionOpen(false)
  }, [activeProfile, location, profileWorkspace])

  const openCompletedDocument = useCallback(() => {
    if (!completedDocument?.id) return
    navigate(`${completedDocument.path}?document=${encodeURIComponent(completedDocument.id)}`, {
      state: completedDocument.state,
    })
  }, [completedDocument, navigate])

  const value = useMemo(() => ({ openVoiceToDocument }), [openVoiceToDocument])

  return (
    <VoiceToDocumentSessionContext.Provider value={value}>
      {children}

      {sessionOpen && (
        <div className={`fixed inset-0 flex items-center justify-center ${minimized ? 'pointer-events-none z-40 p-0' : 'z-50 bg-scrim p-4 backdrop-blur-sm'}`}>
          <div className={minimized ? 'pointer-events-auto' : ''}>
            <VoiceToDocumentPanel
              memberNames={[]}
              minimized={minimized}
              onMinimize={() => setMinimized(true)}
              onExpand={() => setMinimized(false)}
              onCancel={dismissVoiceToDocument}
              onComplete={handleTranscriptComplete}
            />
          </div>
        </div>
      )}

      {completedDocument && (
        <div className={`${SURFACE.modal} fixed bottom-5 right-5 z-40 flex items-center gap-3 p-3 shadow-lg`}>
          <button type="button" onClick={openCompletedDocument} className="text-left text-sm font-medium text-primary">
            文档已生成
          </button>
          <button type="button" onClick={() => setCompletedDocument(null)} className={ACTION.secondary}>
            关闭
          </button>
        </div>
      )}
    </VoiceToDocumentSessionContext.Provider>
  )
}
