import { MarkdownAdapter } from '@blocksuite/blocks/_common/adapters/markdown'
import { effects as registerBlocksuiteBlockEffects } from '@blocksuite/blocks/effects'
import { AffineEditorContainer, PageEditor, createEmptyDoc } from '@blocksuite/presets'
import { effects as registerBlocksuitePresetEffects } from '@blocksuite/presets/effects'
import { Job } from '@blocksuite/store'
import { Doc, applyUpdate, encodeStateAsUpdate } from 'yjs'
import { parseBlockSuiteBody, stringifyBlockSuiteCrdtBody } from './blocksuiteFormat'

const LOAD_ORIGIN = 'imai-cloud-load'
const EFFECTS_REGISTERED_KEY = '__imaiCloudBlocksuitePresetEffectsRegistered'

export const CLOUD_BLOCKSUITE_BODY_FORMAT = 'blocksuite_crdt'

export function registerCloudBlocksuiteElements() {
  if (globalThis[EFFECTS_REGISTERED_KEY]) return

  const define = customElements.define.bind(customElements)
  customElements.define = (name, constructor, options) => {
    if (customElements.get(name)) return
    define(name, constructor, options)
  }
  try {
    registerBlocksuiteBlockEffects()
    registerBlocksuitePresetEffects()
    globalThis[EFFECTS_REGISTERED_KEY] = true
  } finally {
    customElements.define = define
  }
}

export function encodeCloudDocCrdt(doc) {
  return stringifyBlockSuiteCrdtBody(encodeStateAsUpdate(doc.spaceDoc))
}

/**
 * 编码结果能不能原样解回来。
 *
 * 2026-07-26 事故:一篇 70KB 的转写文档被一次保存覆盖成 2KB 无法解码的字节,
 * 打开时报 `typeRefs[decoder.readTypeRef()] is not a function`,靠版本表才捞回来。
 * 当时 flushCurrentDoc 编完就直接交出去,没有任何校验 —— 坏编码于是静默替换了
 * 好内容。写库前过一遍这个函数,坏的宁可不保存。
 */
export function cloudDocCrdtBodyDecodes(body) {
  try {
    const { bytes } = parseBlockSuiteBody(body)
    applyUpdate(new Doc(), bytes)
    return true
  } catch {
    return false
  }
}

export async function createCloudBlankDoc(title = 'Untitled') {
  const doc = createEmptyDoc().init()
  doc.collection.meta.setDocMeta(doc.id, { title })
  return doc
}

export async function createCloudDocFromCrdt(value, fallbackTitle = 'Untitled') {
  const parsed = parseBlockSuiteBody(value)
  const { doc } = createEmptyDoc()
  doc.collection.meta.setDocMeta(doc.id, { title: fallbackTitle })
  applyUpdate(doc.spaceDoc, parsed.bytes, LOAD_ORIGIN)
  doc.load()
  return doc
}

export function createCloudPageEditor(doc) {
  registerCloudBlocksuiteElements()
  const editor = document.createElement('affine-editor-container')
  editor.doc = doc
  editor.mode = 'page'
  editor.autofocus = true
  editor.dataset.bodyFormat = CLOUD_BLOCKSUITE_BODY_FORMAT
  return editor
}

export function setCloudDocReadonly(doc, readonly) {
  doc.awarenessStore.setReadonly(doc.blockCollection, Boolean(readonly))
}

export function subscribeCloudDocUpdates(doc, callback) {
  const handler = (_update, origin) => {
    if (origin === LOAD_ORIGIN) return
    callback()
  }
  doc.spaceDoc.on('update', handler)
  return () => {
    doc.spaceDoc.off('update', handler)
  }
}

export async function exportCloudDocMarkdown(doc) {
  const job = new Job({ collection: doc.collection })
  const snapshot = job.docToSnapshot(doc)
  if (!snapshot) return ''
  const markdown = new MarkdownAdapter(job)
  const result = await markdown.fromDocSnapshot({
    snapshot,
    assets: job.assetsManager,
  })
  return result.file || ''
}

export async function createCloudCrdtDocumentFromMarkdown(markdown, title = 'Untitled') {
  const seedDoc = await createCloudBlankDoc(title)
  const job = new Job({ collection: seedDoc.collection })
  const adapter = new MarkdownAdapter(job)
  const doc = await adapter.toDoc({
    file: String(markdown || `# ${title}\n\n`),
    assets: job.assetsManager,
  })
  if (!doc) throw new Error('invalid_blocksuite_crdt_body')
  doc.collection.meta.setDocMeta(doc.id, { title })
  // MarkdownAdapter 转出来的文档,页面标题块会被填成 "Untitled" —— 编辑器顶部
  // 那行大标题读的是这个块,不是上面的 meta。不同步过去的话,任何由 markdown
  // 转出的文档打开都顶着一个 Untitled。
  const rootTitle = doc.root?.title
  if (rootTitle && typeof rootTitle.replace === 'function' && rootTitle.toString() !== title) {
    rootTitle.replace(0, rootTitle.length, title)
  }
  return {
    body: encodeCloudDocCrdt(doc),
    markdown: await exportCloudDocMarkdown(doc),
  }
}

export async function createCloudBlankCrdtDocument(title = 'Untitled') {
  const doc = await createCloudBlankDoc(title)
  return {
    body: encodeCloudDocCrdt(doc),
    markdown: await exportCloudDocMarkdown(doc),
  }
}
