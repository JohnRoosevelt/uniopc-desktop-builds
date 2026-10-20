import { isBlockSuiteCrdtBody } from './blocksuiteFormat.js'

export function resolveLocalDocumentEditorContent(document = {}) {
  const content = String(document?.content || '')
  if (isBlockSuiteCrdtBody(content)) return content

  const markdownProjection = String(
    document?.markdownProjection
      ?? document?.metadata?.markdown_projection
      ?? '',
  )
  return markdownProjection || content
}
