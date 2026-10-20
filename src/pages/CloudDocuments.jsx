import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ACTION, SURFACE, TEXT } from '../lib/theme'
import CloudBlockSuiteEditor from '../components/CloudBlockSuiteEditor'
import TranscriptionAudioPlayer from '../components/TranscriptionAudioPlayer'
import {
  archiveLocalDocument,
  createLocalDocument,
  DOCUMENT_CATEGORY_OPTIONS,
  documentTitleFromMarkdown,
  getLocalDocument,
  listLocalDocuments,
  normalizeDocumentCategory,
  updateLocalDocument,
} from '../lib/localDocuments'
import {
  CLOUD_BLOCKSUITE_BODY_FORMAT,
  createCloudBlankCrdtDocument,
  createCloudCrdtDocumentFromMarkdown,
} from '../lib/cloudBlocksuite'
import { isBlockSuiteCrdtBody } from '../lib/blocksuiteFormat'
import { resolveLocalDocumentEditorContent } from '../lib/localDocumentEditorContent'
import { transcriptionJobIdOfDocument } from '../lib/voiceTranscription'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import { useProfileWorkspace } from '../hooks/useProfileWorkspace'
import { useVoiceToDocumentSession } from '../components/VoiceToDocumentSession'

const EMPTY_DOC = { title: '', content: '', markdownProjection: '', category: 'other', metadata: {} }

function documentMarkdown(document) {
  return String(document?.metadata?.markdown_projection || '')
}

function documentTitle(document) {
  return documentTitleFromMarkdown(documentMarkdown(document), document?.title || '新建文档')
}

function formatDate(value) {
  if (!value) return '刚刚'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

async function draftFromDocument(document, categories) {
  if (!document) return EMPTY_DOC
  const title = documentTitle(document)
  const category = normalizeDocumentCategory(document?.metadata?.category, categories)
  const metadata = document?.metadata && typeof document.metadata === 'object' ? document.metadata : {}
  if (document.content && isBlockSuiteCrdtBody(document.content)) {
    return { title, content: document.content, markdownProjection: documentMarkdown(document), category, metadata }
  }
  const converted = await createCloudCrdtDocumentFromMarkdown(resolveLocalDocumentEditorContent(document), title)
  return {
    title: documentTitleFromMarkdown(converted.markdown, title),
    content: converted.body,
    markdownProjection: converted.markdown,
    category,
    metadata,
  }
}

export default function CloudDocuments() {
  const [searchParams, setSearchParams] = useSearchParams()
  const activeOpenClaw = useActiveOpenClawProfile()
  const profileWorkspace = useProfileWorkspace()
  const activeProfile = profileWorkspace ? profileWorkspace.activeProfile : activeOpenClaw.activeProfile || ''
  const { openVoiceToDocument } = useVoiceToDocumentSession()
  const [documents, setDocuments] = useState([])
  const categories = DOCUMENT_CATEGORY_OPTIONS
  const [selectedCategory, setSelectedCategory] = useState(searchParams.get('category') || '')
  const [selectedDocumentId, setSelectedDocumentId] = useState('')
  const [selectedDocument, setSelectedDocument] = useState(null)
  const [draft, setDraft] = useState(EMPTY_DOC)
  const [viewMode, setViewMode] = useState(searchParams.get('document') || searchParams.get('new') === '1' ? 'detail' : 'list')
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [newDocumentMode, setNewDocumentMode] = useState('blank')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [initializingBlankDraft, setInitializingBlankDraft] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const editorRef = useRef(null)
  const mountedRef = useRef(false)
  const blankDraftInitializedRef = useRef(false)

  const draftTitle = documentTitleFromMarkdown(draft.markdownProjection, draft.title || selectedDocument?.title || '新建文档')
  const dirty = Boolean(selectedDocument
    ? draftTitle !== selectedDocument.title
      || draft.content !== selectedDocument.content
      || draft.markdownProjection !== documentMarkdown(selectedDocument)
      || normalizeDocumentCategory(draft.category, categories) !== normalizeDocumentCategory(selectedDocument?.metadata?.category, categories)
    : draft.content || draft.markdownProjection)

  function replaceSearch(nextValues = {}, options = {}) {
    const next = new URLSearchParams()
    const category = nextValues.category ?? selectedCategory
    const documentId = nextValues.documentId ?? selectedDocumentId
    if (category) next.set('category', category)
    if (documentId) next.set('document', documentId)
    if (nextValues.creating) next.set('new', '1')
    setSearchParams(next, options)
  }

  async function loadDocuments(category = selectedCategory) {
    if (activeOpenClaw.loading || !activeProfile) return
    setLoading(true)
    setError('')
    try {
      const rows = await listLocalDocuments(category, { profile: activeProfile })
      if (!mountedRef.current) return
      setDocuments(rows)
      if (selectedDocumentId && !rows.some(row => row.id === selectedDocumentId)) {
        setSelectedDocumentId('')
        setSelectedDocument(null)
        setDraft(EMPTY_DOC)
        setViewMode('list')
      }
    } catch (err) {
      if (mountedRef.current) setError(String(err?.message || err || '读取本地文档失败'))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    loadDocuments(selectedCategory)
  }, [activeOpenClaw.loading, activeProfile, selectedCategory])

  useEffect(() => {
    const refreshAfterDocumentChange = event => {
      const profile = String(event?.detail?.profile || '').trim()
      if (profile && profile === activeProfile) loadDocuments(selectedCategory)
    }
    window.addEventListener('uniopc:local-documents-changed', refreshAfterDocumentChange)
    return () => window.removeEventListener('uniopc:local-documents-changed', refreshAfterDocumentChange)
  }, [activeOpenClaw.loading, activeProfile, selectedCategory])

  useEffect(() => {
    if (activeOpenClaw.loading || !activeProfile) return undefined
    const category = searchParams.get('category') || ''
    if (category !== selectedCategory) setSelectedCategory(category)
    const documentId = searchParams.get('document') || ''
    const creating = searchParams.get('new') === '1'
    if (documentId && documentId !== selectedDocument?.id) {
      let cancelled = false
      setSelectedDocumentId(documentId)
      setViewMode('detail')
      getLocalDocument(documentId, { profile: activeProfile })
        .then(async document => {
          if (cancelled || !mountedRef.current) return
          const nextDraft = await draftFromDocument(document, categories)
          setSelectedDocument({ ...document, content: nextDraft.content })
          setDraft(nextDraft)
        })
        .catch(err => { if (!cancelled && mountedRef.current) setError(String(err?.message || err || '打开本地文档失败')) })
      return () => { cancelled = true }
    }
    if (!creating) blankDraftInitializedRef.current = false
    if (creating && !documentId && !draft.content && !blankDraftInitializedRef.current) {
      blankDraftInitializedRef.current = true
      startBlankDraft()
    }
    if (!documentId && !creating && viewMode === 'detail') {
      setSelectedDocumentId('')
      setSelectedDocument(null)
      setDraft(EMPTY_DOC)
      setViewMode('list')
    }
  }, [activeOpenClaw.loading, activeProfile, searchParams])

  function openDocument(document) {
    setError('')
    setMessage('')
    setSelectedDocumentId(document.id)
    setSelectedDocument(null)
    setViewMode('detail')
    replaceSearch({ documentId: document.id })
  }

  async function startBlankDraft() {
    setCreateModalOpen(false)
    setError('')
    setMessage('')
    setSelectedDocumentId('')
    setSelectedDocument(null)
    setViewMode('detail')
    setInitializingBlankDraft(true)
    replaceSearch({ documentId: '', creating: true })
    try {
      const next = await createCloudBlankCrdtDocument('')
      if (mountedRef.current) setDraft({ ...EMPTY_DOC, content: next.body, markdownProjection: next.markdown })
    } catch (err) {
      if (mountedRef.current) setError(String(err?.message || err || '创建本地文档失败'))
    } finally {
      if (mountedRef.current) setInitializingBlankDraft(false)
    }
  }

  function openCreateModal() {
    setNewDocumentMode('blank')
    setCreateModalOpen(true)
    setError('')
    setMessage('')
  }

  async function saveDocument(event) {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setError('')
    try {
      const flushed = await editorRef.current?.flush?.()
      const markdownProjection = flushed?.markdown ?? draft.markdownProjection
      const nextDraft = {
        ...draft,
        content: flushed?.value ?? draft.content,
        markdownProjection,
        title: documentTitleFromMarkdown(markdownProjection, draft.title || selectedDocument?.title || '新建文档'),
      }
      const input = {
        profile: activeProfile,
        title: nextDraft.title, folderPath: '/', content: nextDraft.content,
        bodyFormat: CLOUD_BLOCKSUITE_BODY_FORMAT, markdownProjection: nextDraft.markdownProjection,
        category: normalizeDocumentCategory(nextDraft.category, categories),
        metadata: nextDraft.metadata,
        baseHash: selectedDocument?.content_hash || null,
      }
      const saved = selectedDocument
        ? await updateLocalDocument({ id: selectedDocument.id, ...input })
        : await createLocalDocument(input)
      await loadDocuments()
      if (!mountedRef.current) return
      setSelectedDocumentId(saved.id)
      const savedDraft = await draftFromDocument(saved, categories)
      setSelectedDocument({ ...saved, content: savedDraft.content })
      setDraft(savedDraft)
      replaceSearch({ documentId: saved.id }, { replace: true })
      setMessage('文档已保存')
    } catch (err) {
      if (mountedRef.current) setError(String(err?.message || err || '保存本地文档失败'))
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  async function removeDocument() {
    if (!selectedDocument || saving) return
    if (!window.confirm(`确定删除本地文档「${draftTitle}」吗？`)) return
    setSaving(true)
    try {
      await archiveLocalDocument(selectedDocument.id, { profile: activeProfile })
      setMessage('文档已删除')
      setSelectedDocumentId('')
      setSelectedDocument(null)
      setDraft(EMPTY_DOC)
      setViewMode('list')
      replaceSearch({ documentId: '' }, { replace: true })
      await loadDocuments()
    } catch (err) {
      if (mountedRef.current) setError(String(err?.message || err || '删除本地文档失败'))
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  const categoryLabel = value => categories.find(option => option.value === value)?.label || '其他'
  const saveLabel = saving ? '保存中' : dirty ? '未保存' : '已保存'

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {viewMode === 'detail' ? (
        <form onSubmit={saveDocument} className="flex min-h-0 flex-1 flex-col">
          <div className={`border-b ${SURFACE.divider} px-6 py-4`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className={`truncate text-sm ${TEXT.secondary}`}>我的文档 / {selectedDocument ? draftTitle : '新建文档'}</div>
                <label className="mt-3 inline-flex items-center gap-2 text-xs text-tertiary">
                  分类
                  <select value={normalizeDocumentCategory(draft.category, categories)} onChange={event => setDraft(prev => ({ ...prev, category: normalizeDocumentCategory(event.target.value, categories) }))} className="h-9 rounded-lg border border-default bg-surface-sunken px-3 text-sm text-primary">
                    {categories.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
              </div>
              <div className="flex items-center gap-2">
                <TranscriptionAudioPlayer jobId={transcriptionJobIdOfDocument(selectedDocument)} />
                <span className={`${dirty ? SURFACE.chipActive : SURFACE.chip} px-3 py-1 text-xs`}>{saveLabel}</span>
                {selectedDocument && <button type="button" onClick={removeDocument} disabled={saving} className={ACTION.danger}>删除</button>}
                <button type="submit" disabled={!dirty || saving} className={ACTION.primary}>保存</button>
              </div>
            </div>
          </div>
          {(error || message) && <div className={`mx-6 mt-4 rounded-lg border px-4 py-3 text-sm ${error ? 'border-rose-400/20 bg-rose-500/10 text-danger-text' : 'border-emerald-400/20 bg-emerald-500/10 text-success-text'}`}>{error || message}</div>}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {initializingBlankDraft && !draft.content
              ? <div className={`px-2 py-6 text-sm ${TEXT.muted}`}>正在初始化文档编辑器...</div>
              : <CloudBlockSuiteEditor ref={editorRef} value={draft.content} title={draftTitle} editable onChange={(content, meta) => setDraft(prev => ({ ...prev, title: documentTitleFromMarkdown(meta?.markdown, prev.title || '新建文档'), content, markdownProjection: meta?.markdown || '' }))} className="min-h-[620px]" />}
          </div>
        </form>
      ) : (
        <section className="flex min-h-0 flex-1 flex-col">
          <div className={`flex flex-wrap items-center justify-between gap-3 border-b ${SURFACE.divider} px-5 py-3`}>
            <label className="inline-flex items-center gap-2 text-xs text-tertiary">类型
              <select value={selectedCategory} onChange={event => { setSelectedCategory(event.target.value); replaceSearch({ category: event.target.value, documentId: '' }) }} className="h-9 rounded-lg border border-default bg-surface-sunken px-3 text-sm text-primary">
                <option value="">全部类型</option>
                {categories.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <button type="button" onClick={openCreateModal} className={ACTION.primary}>新建文档</button>
          </div>
          {(error || message) && <div className={`mx-6 mt-4 rounded-lg border px-4 py-3 text-sm ${error ? 'border-rose-400/20 bg-rose-500/10 text-danger-text' : 'border-emerald-400/20 bg-emerald-500/10 text-success-text'}`}>{error || message}</div>}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? <div className={`px-6 py-5 text-sm ${TEXT.muted}`}>正在读取本地文档...</div>
              : documents.length === 0 ? <div className="px-6 py-10 text-center"><p className="text-base font-semibold text-primary">还没有文档</p><p className={`mt-2 text-sm ${TEXT.muted}`}>新建第一篇个人文档，或把一段录音转成文档。</p><button type="button" onClick={openCreateModal} className={`${ACTION.primary} mt-5`}>新建文档</button></div>
              : <div>{documents.map(document => <button key={document.id} type="button" onClick={() => openDocument(document)} className={`grid w-full grid-cols-[minmax(0,1fr)_120px_140px_32px] items-center gap-4 border-b ${SURFACE.divider} px-5 py-4 text-left transition-colors hover:bg-state-hover`}><span className="truncate text-sm font-semibold text-primary">{documentTitle(document)}</span><span className={`${SURFACE.chip} w-fit px-2.5 py-1 text-xs`}>{categoryLabel(normalizeDocumentCategory(document?.metadata?.category, categories))}</span><span className={`text-sm ${TEXT.muted}`}>{formatDate(document.updated_at || document.created_at)}</span><span className={`text-right text-lg ${TEXT.muted}`}>›</span></button>)}</div>}
          </div>
        </section>
      )}
      {createModalOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm" onClick={() => setCreateModalOpen(false)}><div className={`${SURFACE.modal} w-full max-w-md space-y-5 p-5`} onClick={event => event.stopPropagation()}><div><h2 className="text-lg font-semibold text-primary">新建文档</h2><p className={`mt-1 text-sm ${TEXT.muted}`}>文档仅归当前 Owner，并保存在本机当前工作区，无需选择项目或配置成员权限。</p></div><div className="grid grid-cols-2 gap-2">{[{ id: 'blank', label: '空白文档', hint: '直接开始写' }, { id: 'voice', label: '录音成文', hint: '说一段，自动成稿' }].map(option => <button key={option.id} type="button" onClick={() => setNewDocumentMode(option.id)} className={`rounded-lg border px-3 py-2.5 text-left ${newDocumentMode === option.id ? 'border-brand/40 bg-state-selected text-accent-text' : 'border-subtle bg-surface-overlay hover:bg-state-hover'}`}><span className="block text-sm font-medium text-primary">{option.label}</span><span className={`block text-xs ${TEXT.muted}`}>{option.hint}</span></button>)}</div><div className="flex justify-end gap-2"><button type="button" onClick={() => setCreateModalOpen(false)} className={ACTION.secondary}>取消</button><button type="button" onClick={() => { if (newDocumentMode === 'voice') { setCreateModalOpen(false); openVoiceToDocument() } else startBlankDraft() }} className={ACTION.primary}>{newDocumentMode === 'voice' ? '去录音' : '创建'}</button></div></div></div>}
    </div>
  )
}
