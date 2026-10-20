import { invoke } from '@tauri-apps/api/core'

export const DOCUMENT_CATEGORY_OPTIONS = [
  { value: 'product', label: '产品' },
  { value: 'technical', label: '技术' },
  { value: 'testing', label: '测试' },
  { value: 'marketing', label: '市场' },
  { value: 'operations', label: '运营' },
  { value: 'meeting', label: '会议' },
  { value: 'customer', label: '客户' },
  { value: 'work_report', label: '工作报告' },
  { value: 'research', label: '调研' },
  { value: 'other', label: '其他' },
]

function documentCategoryValueSet(options = DOCUMENT_CATEGORY_OPTIONS) {
  return new Set((Array.isArray(options) ? options : DOCUMENT_CATEGORY_OPTIONS).map(option => option.value))
}

function requireId(value) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error('missing_document_id')
  return normalized
}

function requireTitle(value) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error('missing_document_title')
  return normalized
}

function cleanMarkdownTitle(value) {
  return String(value || '')
    .replace(/^[#>\-\s]+/, '')
    .replace(/[`*_~[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

export function documentTitleFromMarkdown(markdown, fallback = '新建文档') {
  const text = String(markdown || '')
  const heading = text.match(/^#(?!#)\s+(.+)$/m)
  if (heading) {
    const title = cleanMarkdownTitle(heading[1])
    if (title) return title
  }

  const firstLine = text
    .split(/\r?\n/)
    .map(line => cleanMarkdownTitle(line))
    .find(Boolean)
  return firstLine || cleanMarkdownTitle(fallback) || '新建文档'
}

export function normalizeDocumentCategory(value, options = DOCUMENT_CATEGORY_OPTIONS) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return documentCategoryValueSet(options).has(normalized) ? normalized : 'other'
}

export function documentCategoryLabel(value) {
  const category = normalizeDocumentCategory(value)
  return DOCUMENT_CATEGORY_OPTIONS.find(option => option.value === category)?.label || '其他'
}

function profileInput(profile) {
  const normalized = String(profile || '').trim()
  return normalized ? { profile: normalized } : {}
}

function metadataInput(input = {}) {
  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? { ...input.metadata }
    : {}
  const bodyFormat = String(input.bodyFormat || metadata.body_format || '').trim()
  if (bodyFormat) metadata.body_format = bodyFormat
  return metadata
}

function writeInput(input = {}) {
  return {
    ...profileInput(input.profile),
    title: requireTitle(input.title),
    category: normalizeDocumentCategory(input.category ?? input.metadata?.category),
    blocksuiteBody: String(input.content ?? input.blocksuiteBody ?? ''),
    markdownProjection: String(input.markdownProjection ?? input.metadata?.markdown_projection ?? ''),
    metadata: metadataInput(input),
  }
}

function localDocumentShape(document) {
  if (!document || typeof document !== 'object') return null
  const category = normalizeDocumentCategory(document.category ?? document.metadata?.category)
  const markdownProjection = String(document.markdownProjection ?? document.metadata?.markdown_projection ?? '')
  const metadata = {
    ...(document.metadata && typeof document.metadata === 'object' && !Array.isArray(document.metadata)
      ? document.metadata
      : {}),
    markdown_projection: markdownProjection,
    category,
  }
  const result = {
    ...document,
    category,
    metadata,
    content_hash: String(document.contentHash ?? document.content_hash ?? ''),
    created_at: document.createdAt ?? document.created_at ?? null,
    updated_at: document.updatedAt ?? document.updated_at ?? null,
  }
  if (Object.hasOwn(document, 'blocksuiteBody') || Object.hasOwn(document, 'content')) {
    result.content = String(document.blocksuiteBody ?? document.content ?? '')
  }
  return result
}

export async function listLocalDocuments(category = '', options = {}) {
  const normalizedCategory = String(category || '').trim()
  const response = await invoke('local_documents_list', {
    input: {
      ...profileInput(options.profile),
      ...(normalizedCategory ? { category: normalizeDocumentCategory(normalizedCategory) } : {}),
    },
  })
  return Array.isArray(response?.documents) ? response.documents.map(localDocumentShape) : []
}

export async function getLocalDocument(id, options = {}) {
  const response = await invoke('local_document_get', {
    input: { ...profileInput(options.profile), id: requireId(id) },
  })
  return localDocumentShape(response?.document)
}

export async function createLocalDocument(input = {}) {
  const response = await invoke('local_document_create', { input: writeInput(input) })
  return localDocumentShape(response?.document)
}

export async function updateLocalDocument(input = {}) {
  const response = await invoke('local_document_update', {
    input: {
      id: requireId(input.id),
      ...writeInput(input),
      baseHash: String(input.baseHash || '').trim(),
    },
  })
  return localDocumentShape(response?.document)
}

export async function archiveLocalDocument(id, options = {}) {
  const response = await invoke('local_document_archive', {
    input: { ...profileInput(options.profile), id: requireId(id) },
  })
  return localDocumentShape(response?.document)
}
