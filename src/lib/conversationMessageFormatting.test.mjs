import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectConversationArtifacts,
  splitConversationMediaSegments,
  tokenizeConversationMessageContent,
} from './conversationMessageFormatting.js'

test('tokenizeConversationMessageContent highlights slash plugin commands', () => {
  assert.deepEqual(
    tokenizeConversationMessageContent('/plugin:uniopc-cloud-workspace write docs').map(token => [token.type, token.kind || '', token.value]),
    [
      ['capability', 'plugin', '/plugin:uniopc-cloud-workspace'],
      ['text', '', ' write docs'],
    ],
  )
})

test('tokenizeConversationMessageContent highlights plugin names inside code spans', () => {
  assert.deepEqual(
    tokenizeConversationMessageContent('using `uniopc-cloud-workspace`, but `introduce Elon` failed').map(token => [token.type, token.kind || '', token.value]),
    [
      ['text', '', 'using '],
      ['capability', 'plugin', 'uniopc-cloud-workspace'],
      ['text', '', ', but '],
      ['code', '', 'introduce Elon'],
      ['text', '', ' failed'],
    ],
  )
})

test('tokenizeConversationMessageContent highlights tool-level plugin commands', () => {
  assert.deepEqual(
    tokenizeConversationMessageContent('/plugin:uniopc-cloud-workspace.imai_cloud_document_create').map(token => [token.type, token.kind || '', token.value]),
    [
      ['capability', 'plugin', '/plugin:uniopc-cloud-workspace.imai_cloud_document_create'],
    ],
  )
})

test('tokenizeConversationMessageContent keeps at-sign capability mentions plain', () => {
  assert.deepEqual(
    tokenizeConversationMessageContent('@plugin:uniopc-cloud-workspace @mcp:telegram @skill:browser').map(token => [token.type, token.kind || '', token.value]),
    [
      ['text', '', '@plugin:uniopc-cloud-workspace @mcp:telegram @skill:browser'],
    ],
  )
})

test('tokenizeConversationMessageContent highlights project and document mentions', () => {
  assert.deepEqual(
    tokenizeConversationMessageContent('@project:project-1 结合 @doc:doc-2').map(token => [token.type, token.kind || '', token.value]),
    [
      ['capability', 'project', '@project:project-1'],
      ['text', '', ' 结合 '],
      ['capability', 'doc', '@doc:doc-2'],
    ],
  )
})

test('tokenizeConversationMessageContent displays document names instead of stored ids', () => {
  const tokens = tokenizeConversationMessageContent(
    '请阅读 @doc:19e98e40-f936-47a7-8209-72e6fa34e96e 和 @doc:《农村包围城市：AI 十八路打法》',
    { documentLabels: { '19e98e40-f936-47a7-8209-72e6fa34e96e': '03-工作哲学.md' } },
  )

  assert.deepEqual(
    tokens.filter(token => token.type === 'capability').map(token => [token.kind, token.value, token.label]),
    [
      ['doc', '@doc:19e98e40-f936-47a7-8209-72e6fa34e96e', '@doc:03-工作哲学.md'],
      ['doc', '@doc:《农村包围城市：AI 十八路打法》', '@doc:农村包围城市：AI 十八路打法'],
    ],
  )
})

test('tokenizeConversationMessageContent keeps project slash text plain', () => {
  assert.deepEqual(
    tokenizeConversationMessageContent('/project:project-1').map(token => [token.type, token.kind || '', token.value]),
    [
      ['text', '', '/project:project-1'],
    ],
  )
})

test('splitConversationMediaSegments separates media from markdown text', () => {
  assert.deepEqual(
    splitConversationMediaSegments('结果图：\nMEDIA:/tmp/out.png\n请查收 **报告**'),
    [
      { type: 'text', value: '结果图：\n' },
      { type: 'media', value: '/tmp/out.png', mediaKind: 'image' },
      { type: 'text', value: '\n请查收 **报告**' },
    ],
  )
})

test('splitConversationMediaSegments detects video media', () => {
  assert.deepEqual(
    splitConversationMediaSegments('MEDIA:/tmp/demo.mp4'),
    [
      { type: 'media', value: '/tmp/demo.mp4', mediaKind: 'video' },
    ],
  )
})

test('splitConversationMediaSegments keeps plain text as one segment', () => {
  assert.deepEqual(
    splitConversationMediaSegments('# 标题\n\n正文'),
    [
      { type: 'text', value: '# 标题\n\n正文' },
    ],
  )
})

test('collectConversationArtifacts gathers assistant media in first-seen order, deduped', () => {
  const messages = [
    { id: 1, role: 'user', content: 'MEDIA:/tmp/ignored-user.png make a poster' },
    { id: 2, role: 'assistant', content: '成品在此 MEDIA:/tmp/poster.png 和 MEDIA:/tmp/clip.mp4' },
    { id: 3, role: 'assistant', content: '再看这张 MEDIA:/tmp/poster.png（重复）与 MEDIA:/tmp/v2.jpg' },
  ]
  assert.deepEqual(
    collectConversationArtifacts(messages),
    [
      { path: '/tmp/poster.png', kind: 'image', name: 'poster.png', messageId: '2' },
      { path: '/tmp/clip.mp4', kind: 'video', name: 'clip.mp4', messageId: '2' },
      { path: '/tmp/v2.jpg', kind: 'image', name: 'v2.jpg', messageId: '3' },
    ],
  )
})

test('collectConversationArtifacts tolerates empty / non-array input', () => {
  assert.deepEqual(collectConversationArtifacts(null), [])
  assert.deepEqual(collectConversationArtifacts([]), [])
  assert.deepEqual(collectConversationArtifacts([{ role: 'assistant', content: '纯文本无产物' }]), [])
})

test('media tokens tolerate spaces in the path (macOS Application Support)', () => {
  const p = '/Users/lan/Library/Application Support/Uniopc/state/x/media/tool-image-generation/image-1---25d10882.jpg'
  const tokens = tokenizeConversationMessageContent(`生成完成：MEDIA:${p}\n视觉设定`)
  const media = tokens.find(t => t.type === 'media')
  assert.equal(media?.value, p)
  assert.equal(media?.mediaKind, 'image')
  // artifacts collector must surface it too
  const arts = collectConversationArtifacts([{ id: 9, role: 'assistant', content: `图 MEDIA:${p}` }])
  assert.deepEqual(arts, [{ path: p, kind: 'image', name: 'image-1---25d10882.jpg', messageId: '9' }])
  // media-only segment splitter (used by the markdown renderer) also splits it
  const segs = splitConversationMediaSegments(`前 MEDIA:${p} 后`)
  assert.equal(segs.some(s => s.type === 'media' && s.value === p), true)
})
