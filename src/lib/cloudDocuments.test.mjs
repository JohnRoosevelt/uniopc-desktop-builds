import assert from 'node:assert/strict'
import test from 'node:test'
import { listCloudDocuments } from './cloudDocuments.js'
import {
  documentTitleFromMarkdown,
  normalizeDocumentCategory,
} from './localDocuments.js'

function fakeClient(response = { data: [], error: null }) {
  const calls = []
  const chain = {
    select(columns = '*') { calls.push(['select', columns]); return chain },
    eq(column, value) { calls.push(['eq', column, value]); return chain },
    order(column, options) { calls.push(['order', column, options]); return Promise.resolve(response) },
  }
  return { calls, client: { from() { return chain } } }
}

test('temporary conversation mention loading remains owner scoped until Task 5', async () => {
  const fake = fakeClient({ data: [{ id: 'doc-1' }], error: null })
  assert.deepEqual(await listCloudDocuments(fake.client, 'owner-1', 'technical'), [{ id: 'doc-1' }])
  assert.deepEqual(fake.calls, [
    ['select', '*'], ['eq', 'status', 'active'], ['eq', 'metadata->>category', 'technical'], ['order', 'updated_at', { ascending: false }],
  ])
})

test('document title and category normalization live with local documents', () => {
  assert.equal(documentTitleFromMarkdown('# 复盘\n内容'), '复盘')
  assert.equal(normalizeDocumentCategory('unknown'), 'other')
})
