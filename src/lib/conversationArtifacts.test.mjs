import test from 'node:test'
import assert from 'node:assert/strict'

import {
  artifactFileKind,
  artifactFileName,
  artifactIcon,
  artifactPreviewMode,
  collectAllArtifacts,
  collectTimelineVideoMedia,
  listStoredToolArtifacts,
  mergeArtifactSources,
  recordToolArtifacts,
  toolArtifactsToPanelItems,
} from './conversationArtifacts.js'

function withLocalStorage(run) {
  const store = new Map()
  const previousWindow = globalThis.window
  globalThis.window = {
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
    dispatchEvent: () => true,
    CustomEvent: class {
      constructor(type) {
        this.type = type
      }
    },
  }
  globalThis.CustomEvent = globalThis.window.CustomEvent
  try {
    return run(store)
  } finally {
    globalThis.window = previousWindow
  }
}

test('artifactFileKind maps office/doc extensions, unknown falls back to file', () => {
  assert.equal(artifactFileKind('/tmp/deck.pptx'), 'slides')
  assert.equal(artifactFileKind('/tmp/report.DOCX'), 'word')
  assert.equal(artifactFileKind('/tmp/data.csv'), 'sheet')
  assert.equal(artifactFileKind('/tmp/notes.md'), 'markdown')
  assert.equal(artifactFileKind('/tmp/archive.zip'), 'archive')
  assert.equal(artifactFileKind('/tmp/binary'), 'file')
  assert.equal(artifactFileKind('/tmp/.hidden'), 'file')
  assert.equal(artifactIcon('slides'), '📊')
  assert.equal(artifactIcon('nope'), '📎')
})

test('artifactFileName keeps names containing spaces', () => {
  assert.equal(artifactFileName('/Users/x/My Files/人vsAI协作.pptx'), '人vsAI协作.pptx')
})

test('recordToolArtifacts dedupes by path and keeps newest metadata', () => {
  withLocalStorage(() => {
    recordToolArtifacts('owner-1', [
      { path: '/tmp/a.pptx', operation: 'created', toolName: 'exec', messageId: '1', at: 10 },
      { path: '/tmp/b.md', operation: 'created', toolName: 'write', messageId: '1', at: 11 },
    ])
    recordToolArtifacts('owner-1', [
      { path: '/tmp/a.pptx', operation: 'modified', toolName: 'edit', messageId: '2', at: 20 },
    ])
    const stored = listStoredToolArtifacts('owner-1')
    assert.equal(stored.length, 2)
    // the re-written file moves to the end (newest) with refreshed metadata
    assert.deepEqual(stored.map(item => item.path), ['/tmp/b.md', '/tmp/a.pptx'])
    assert.equal(stored[1].operation, 'modified')
    assert.equal(stored[1].messageId, '2')
  })
})

test('recordToolArtifacts ignores blank paths and non-array input', () => {
  withLocalStorage(() => {
    assert.deepEqual(recordToolArtifacts('owner-2', [{ path: '   ' }, null]), [])
    assert.deepEqual(recordToolArtifacts('owner-2', null), [])
    assert.deepEqual(listStoredToolArtifacts('owner-2'), [])
  })
})

test('artifact stores are isolated per owner', () => {
  withLocalStorage(() => {
    recordToolArtifacts('owner-a', [{ path: '/tmp/a.md' }])
    recordToolArtifacts('owner-b', [{ path: '/tmp/b.md' }])
    assert.deepEqual(listStoredToolArtifacts('owner-a').map(i => i.path), ['/tmp/a.md'])
    assert.deepEqual(listStoredToolArtifacts('owner-b').map(i => i.path), ['/tmp/b.md'])
  })
})

test('toolArtifactsToPanelItems drops deleted files and tags kind', () => {
  const items = toolArtifactsToPanelItems([
    { path: '/tmp/keep.pptx', operation: 'created', toolName: 'exec' },
    { path: '/tmp/gone.md', operation: 'deleted', toolName: 'apply_patch' },
  ])
  assert.deepEqual(items, [{
    path: '/tmp/keep.pptx',
    kind: 'file',
    fileKind: 'slides',
    name: 'keep.pptx',
    origin: 'sniffed',
    messageId: '',
    operation: 'created',
    toolName: 'exec',
    at: 0,
  }])
})

test('declared artifacts keep their title/kind and survive later sniffed sightings', () => {
  withLocalStorage(() => {
    recordToolArtifacts('owner-d', [{
      path: '/tmp/weekly.docx',
      operation: 'created',
      origin: 'declared',
      title: '周报',
      kind: 'document',
      at: 10,
    }])
    // The same path later shows up as a plain sniffed write — the declaration must win.
    recordToolArtifacts('owner-d', [{ path: '/tmp/weekly.docx', operation: 'modified', at: 20 }])
    const stored = listStoredToolArtifacts('owner-d')
    assert.equal(stored.length, 1)
    assert.equal(stored[0].origin, 'declared')
    assert.equal(stored[0].title, '周报')
    assert.equal(stored[0].kind, 'document')
    assert.equal(stored[0].operation, 'modified')
    assert.equal(stored[0].at, 20)
  })
})

test('artifactPreviewMode routes by media kind first, then extension, else external', () => {
  assert.equal(artifactPreviewMode({ kind: 'image', path: '/tmp/a.weird' }), 'image')
  assert.equal(artifactPreviewMode({ kind: 'video', path: '/tmp/b.weird' }), 'video')
  assert.equal(artifactPreviewMode({ kind: 'file', path: '/tmp/report.md' }), 'markdown')
  assert.equal(artifactPreviewMode({ kind: 'file', path: '/tmp/main.rs' }), 'text')
  assert.equal(artifactPreviewMode({ kind: 'file', path: '/tmp/paper.pdf' }), 'pdf')
  assert.equal(artifactPreviewMode({ kind: 'file', path: '/tmp/site.html' }), 'html')
  assert.equal(artifactPreviewMode({ kind: 'file', path: '/tmp/voice.mp3' }), 'audio')
  assert.equal(artifactPreviewMode({ kind: 'file', path: '/tmp/deck.pptx' }), 'external')
  assert.equal(artifactPreviewMode({ kind: 'file', path: '/tmp/noext' }), 'external')
})

test('panel items use declared title, map declared kind, and lift declared media', () => {
  const items = toolArtifactsToPanelItems([
    { path: '/tmp/weekly.docx', operation: 'created', origin: 'declared', title: '周报', kind: 'document' },
    { path: '/tmp/hero.png', operation: 'created', origin: 'declared', kind: 'image' },
  ])
    assert.equal(items[0].name, 'weekly.docx')
  assert.equal(items[0].fileKind, 'word')
  assert.equal(items[0].origin, 'declared')
  // Declared image renders as real media (thumbnail + lightbox), not a glyph card.
  assert.equal(items[1].kind, 'image')
  assert.equal(items[1].name, 'hero.png')
})

test('mergeArtifactSources dedupes across sources, media wins', () => {
  const merged = mergeArtifactSources(
    [{ path: '/tmp/poster.png', kind: 'image', name: 'poster.png' }],
    [
      { path: '/tmp/poster.png', kind: 'file', name: 'poster.png' },
      { path: '/tmp/deck.pptx', kind: 'file', name: 'deck.pptx' },
    ],
  )
  assert.deepEqual(merged.map(item => [item.path, item.kind]), [
    ['/tmp/poster.png', 'image'],
    ['/tmp/deck.pptx', 'file'],
  ])
})

test('collectAllArtifacts joins conversation media with tool-written files', () => {
  const conversations = [{
    messages: [
      { id: 1, role: 'user', content: '做个 ppt' },
      { id: 2, role: 'assistant', content: '封面图 MEDIA:/tmp/cover.png' },
    ],
  }]
  const merged = collectAllArtifacts(conversations, [
    { path: '/tmp/deck.pptx', operation: 'created', toolName: 'exec' },
  ])
  assert.deepEqual(merged.map(item => item.path), ['/tmp/cover.png', '/tmp/deck.pptx'])
  assert.equal(merged[1].fileKind, 'slides')
})

test('collectAllArtifacts tolerates empty input', () => {
  assert.deepEqual(collectAllArtifacts(null, null), [])
  assert.deepEqual(collectAllArtifacts([], []), [])
})

test('timeline video output uses structured tool artifacts, with a legacy montage-result fallback', () => {
  const fromArtifacts = collectTimelineVideoMedia({
    steps: [{
      name: 'uniopc_montage_produce_video',
      artifacts: [{ path: '/tmp/render.mp4', kind: 'video' }],
      resultPreview: JSON.stringify({ outputPath: '/tmp/render.mp4' }),
    }],
  })
  assert.deepEqual(fromArtifacts, [{ type: 'media', value: '/tmp/render.mp4', mediaKind: 'video' }])

  const legacy = collectTimelineVideoMedia({
    steps: [{
      name: 'uniopc_montage_produce_video',
      resultPreview: JSON.stringify({ mediaRef: 'MEDIA:/tmp/legacy.mov' }),
    }],
  }, { messageContent: '已完成 legacy.mov' })
  assert.deepEqual(legacy, [{ type: 'media', value: '/tmp/legacy.mov', mediaKind: 'video' }])
  const superip = collectTimelineVideoMedia({
    steps: [{
      name: 'uniopc_superip_produce_video',
      resultPreview: JSON.stringify({ mediaRef: 'MEDIA:/tmp/superip.mp4' }),
    }],
  }, { messageContent: '已完成 superip.mp4' })
  assert.deepEqual(superip, [{ type: 'media', value: '/tmp/superip.mp4', mediaKind: 'video' }])
  const truncated = collectTimelineVideoMedia({
    steps: [{
      name: 'uniopc_montage_produce_video',
      resultPreview: '{\n  "status": "completed",\n  "outputPath": "/tmp/truncated.mp4",\n  "captionsPath": "/tmp/captions',
    }],
  }, { messageContent: '请查看 truncated.mp4' })
  assert.deepEqual(truncated, [{ type: 'media', value: '/tmp/truncated.mp4', mediaKind: 'video' }])
  assert.deepEqual(collectTimelineVideoMedia({
    steps: [{ name: 'uniopc_montage_produce_video', resultPreview: JSON.stringify({ outputPath: '/tmp/not-mentioned.mp4' }) }],
  }), [])
  assert.deepEqual(collectTimelineVideoMedia({ steps: [{ name: 'other', resultPreview: '{bad json' }] }), [])
})
