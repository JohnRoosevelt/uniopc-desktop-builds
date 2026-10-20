import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveLocalDocumentEditorContent } from './localDocumentEditorContent.js'

test('resolveLocalDocumentEditorContent prefers the markdown projection for an invalid stored body', () => {
  assert.equal(
    resolveLocalDocumentEditorContent({
      content: '{"type":"page","blocks":[]}',
      metadata: { markdown_projection: '# 会议纪要\n\n- 已完成' },
    }),
    '# 会议纪要\n\n- 已完成',
  )
})

test('resolveLocalDocumentEditorContent preserves a valid BlockSuite CRDT body', () => {
  assert.equal(
    resolveLocalDocumentEditorContent({
      content: Buffer.from([1, 2, 3, 4]).toString('base64'),
      metadata: { markdown_projection: '# 不应替换' },
    }),
    Buffer.from([1, 2, 3, 4]).toString('base64'),
  )
})
