import assert from 'node:assert/strict'
import test from 'node:test'

const calls = []

globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke(command, payload) {
      calls.push([command, payload])
      return Promise.resolve({
        document: {
          id: 'doc-1',
          title: 'Brief',
          category: 'other',
          blocksuiteBody: 'body',
          markdownProjection: '',
          contentHash: 'hash-b',
          status: 'active',
          metadata: {},
          version: 2,
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T01:00:00.000Z',
        },
      })
    },
  },
}

const {
  archiveLocalDocument,
  createLocalDocument,
  getLocalDocument,
  listLocalDocuments,
  updateLocalDocument,
} = await import('./localDocuments.js')

test.beforeEach(() => {
  calls.length = 0
})

test('updateLocalDocument carries the concurrency hash to Rust', async () => {
  const document = await updateLocalDocument({
    id: 'doc-1',
    title: 'Brief',
    content: 'body',
    baseHash: 'hash-a',
  })

  assert.deepEqual(calls[0], ['local_document_update', {
    input: {
      id: 'doc-1',
      title: 'Brief',
      category: 'other',
      blocksuiteBody: 'body',
      markdownProjection: '',
      metadata: {},
      baseHash: 'hash-a',
    },
  }])
  assert.equal(document.content, 'body')
  assert.equal(document.content_hash, 'hash-b')
})

test('local document client invokes only the four remaining fixed commands', async () => {
  globalThis.window.__TAURI_INTERNALS__.invoke = async (command, payload) => {
    calls.push([command, payload])
    if (command === 'local_documents_list') return { documents: [] }
    return { document: { id: 'doc-1', title: 'Brief', category: 'other', metadata: {} } }
  }

  await listLocalDocuments('research')
  await getLocalDocument('doc-1')
  await createLocalDocument({ title: ' Brief ', content: 'body', category: 'unknown' })
  await archiveLocalDocument('doc-1')

  assert.deepEqual(calls.map(([command]) => command), [
    'local_documents_list',
    'local_document_get',
    'local_document_create',
    'local_document_archive',
  ])
  assert.deepEqual(calls[0][1], { input: { category: 'research' } })
  assert.deepEqual(calls[1][1], { input: { id: 'doc-1' } })
  assert.deepEqual(calls[2][1], {
    input: {
      title: 'Brief',
      category: 'other',
      blocksuiteBody: 'body',
      markdownProjection: '',
      metadata: {},
    },
  })
  assert.deepEqual(calls[3][1], { input: { id: 'doc-1' } })
})
