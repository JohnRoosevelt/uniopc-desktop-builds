import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isPendingMessageStale,
  listStoredConversations,
  mergeConversationOptimisticMessages,
  reconcileConversationSessionMessage,
  mergeConversationHistoryMessages,
  saveStoredConversations,
  subscribeConversationStorageError,
} from './conversationStore.js'

test('mergeConversationOptimisticMessages keeps a sent user turn visible while stale history is reloaded', () => {
  const history = [{
    id: 'earlier-assistant',
    role: 'assistant',
    content: '之前的回答',
    createdAt: 1_000,
  }]
  const optimistic = [{
    id: 'user-turn-1',
    role: 'user',
    content: '这条问题必须立即可见',
    createdAt: 2_000,
    status: 'sent',
    idempotencyKey: 'turn-1',
  }]

  const merged = mergeConversationOptimisticMessages(history, optimistic)

  assert.deepEqual(merged.map(message => message.id), ['earlier-assistant', 'user-turn-1'])
  assert.equal(merged[1].content, '这条问题必须立即可见')
})

test('mergeConversationOptimisticMessages retires a local user turn once history has its matching idempotency key', () => {
  const history = [{
    id: 'gateway-user-1',
    role: 'user',
    content: '已被引擎确认的问题',
    createdAt: 2_100,
    idempotencyKey: 'turn-1:user',
  }]
  const optimistic = [{
    id: 'user-turn-1',
    role: 'user',
    content: '已被引擎确认的问题',
    createdAt: 2_000,
    status: 'sent',
    idempotencyKey: 'turn-1',
  }]

  const merged = mergeConversationOptimisticMessages(history, optimistic)

  // Keep the local React key while replacing its data with the canonical row;
  // this proves the optimistic duplicate was retired without a visual remount.
  assert.deepEqual(merged.map(message => message.id), ['user-turn-1'])
  assert.equal(merged[0].status, 'sent')
})

function installLocalStorage({ failWrites = () => false } = {}) {
  const store = new Map()
  const writes = []
  global.window = {
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => {
        if (failWrites(key, value)) {
          const error = new Error('QuotaExceededError')
          error.name = 'QuotaExceededError'
          throw error
        }
        writes.push(key)
        store.set(key, value)
      },
      removeItem: key => store.delete(key),
    },
    dispatchEvent: () => true,
    CustomEvent: class {
      constructor(type) {
        this.type = type
      }
    },
  }
  global.CustomEvent = global.window.CustomEvent
  return { store, writes }
}

function conversation(id, updatedAt, text) {
  return {
    id,
    updatedAt,
    createdAt: updatedAt,
    title: id,
    messages: [{ id: `${id}-m`, role: 'user', content: text, createdAt: updatedAt }],
  }
}

test('mergeConversationHistoryMessages keeps an in-flight user turn pending after remount', () => {
  const current = [
    {
      id: 'local-user',
      role: 'user',
      content: 'hey',
      createdAt: 1_000,
      status: 'sending',
    },
  ]
  const history = [
    {
      id: 'gateway-user',
      role: 'user',
      content: 'hey',
      createdAt: 1_200,
    },
  ]

  const merged = mergeConversationHistoryMessages(current, history, 30_000)

  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, 'local-user')
  assert.equal(merged[0].status, 'sending')
})

test('mergeConversationHistoryMessages marks pending user turn sent when assistant appears', () => {
  const current = [
    {
      id: 'local-user',
      role: 'user',
      content: 'hey',
      createdAt: 1_000,
      status: 'sending',
    },
  ]
  const history = [
    {
      id: 'gateway-user',
      role: 'user',
      content: 'hey',
      createdAt: 1_200,
    },
    {
      id: 'assistant',
      role: 'assistant',
      content: 'hello',
      createdAt: 2_000,
    },
  ]

  const merged = mergeConversationHistoryMessages(current, history, 30_000)

  assert.equal(merged.length, 2)
  assert.equal(merged[0].id, 'local-user')
  assert.equal(merged[0].status, 'sent')
  assert.equal(merged[1].role, 'assistant')
})

test('reconcileConversationSessionMessage confirms an optimistic user turn before an assistant reply', () => {
  const turnId = 'dba104d0-3515-4fa2-9215-32d4f6b219d1'
  const messages = [{
    id: `user-${turnId}`,
    role: 'user',
    content: '请介绍下你自己',
    createdAt: 1_785_814_339_900,
    status: 'sending',
    idempotencyKey: turnId,
  }]

  const merged = reconcileConversationSessionMessage(messages, {
    id: 'gateway-user-1',
    role: 'user',
    content: '请介绍下你自己',
    createdAt: 1_785_814_340_000,
    idempotencyKey: `${turnId}:user`,
  })

  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, `user-${turnId}`)
  assert.equal(merged[0].status, 'sent')
  assert.equal(merged[0].idempotencyKey, `${turnId}:user`)
})

test('reconcileConversationSessionMessage keeps optimistic text when its confirmation has no text', () => {
  const turnId = 'dba104d0-3515-4fa2-9215-32d4f6b219d1'
  const messages = [{
    id: `user-${turnId}`,
    role: 'user',
    content: 'hey',
    createdAt: 1_785_814_339_900,
    status: 'sending',
    idempotencyKey: turnId,
  }]

  const merged = reconcileConversationSessionMessage(messages, {
    id: 'gateway-user-1',
    role: 'user',
    content: '',
    createdAt: 1_785_814_340_000,
    idempotencyKey: `${turnId}:user`,
  })

  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, `user-${turnId}`)
  assert.equal(merged[0].content, 'hey')
  assert.equal(merged[0].status, 'sent')
  assert.equal(merged[0].idempotencyKey, `${turnId}:user`)
})

test('mergeConversationHistoryMessages preserves sent optimistic user turns missing from stale history', () => {
  const current = [
    {
      id: 'local-user-1',
      role: 'user',
      content: 'first',
      createdAt: 1_000,
      status: 'sent',
    },
    {
      id: 'local-user-2',
      role: 'user',
      content: 'second',
      createdAt: 3_000,
      status: 'sent',
    },
  ]
  const history = [
    {
      id: 'gateway-user-1',
      role: 'user',
      content: 'first',
      createdAt: 1_100,
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'reply',
      createdAt: 2_000,
    },
  ]

  const merged = mergeConversationHistoryMessages(current, history, 4_000)

  assert.deepEqual(merged.map(message => message.id), [
    'local-user-1',
    'assistant-1',
    'local-user-2',
  ])
  assert.equal(merged[2].status, 'sent')
})

test('mergeConversationHistoryMessages drops cached bootstrap pending messages', () => {
  const current = [
    {
      id: 'local-bootstrap',
      role: 'user',
      content: '[Bootstrap pending]\nPlease read BOOTSTRAP.md from the workspace and follow it before replying normally.\nDo not use a generic first greeting or reply normally until after you have handled BOOTSTRAP.md.',
      createdAt: 1_000,
    },
  ]
  const history = [
    {
      id: 'cached-bootstrap',
      role: 'user',
      content: '[Bootstrap pending]\nPlease read BOOTSTRAP.md from the workspace and follow it before replying normally.\nDo not use a generic first greeting or reply normally until after you have handled BOOTSTRAP.md.',
      createdAt: 1_100,
    },
    {
      id: 'assistant-ok',
      role: 'assistant',
      content: '在，Elon 在线。',
      createdAt: 2_000,
    },
  ]

  const merged = mergeConversationHistoryMessages(current, history, 30_000)

  assert.deepEqual(merged.map(message => message.id), ['assistant-ok'])
})

test('mergeConversationHistoryMessages strips every repeated stream failure marker', () => {
  const marker = '[assistant turn failed before producing content]'
  const current = [{
    id: 'cached-assistant',
    role: 'assistant',
    content: `${marker}\n${marker}\n引擎已经正常回复。`,
    createdAt: 1_000,
  }]

  const merged = mergeConversationHistoryMessages(current, [{
    id: 'newer-user',
    role: 'user',
    content: '下一条消息',
    createdAt: 2_000,
  }], 30_000, { historyTruncated: true })

  assert.equal(merged.length, 2)
  assert.equal(merged[0].content, '引擎已经正常回复。')
})

test('dedupeConversationMessages drops bootstrap pending messages', async () => {
  const { dedupeConversationMessages } = await import('./conversationStore.js')
  const messages = dedupeConversationMessages([
    {
      id: 'bootstrap-pending',
      role: 'user',
      content: '[Bootstrap pending]\nPlease read BOOTSTRAP.md from the workspace and follow it before replying normally.\nDo not use a generic first greeting or reply normally until after you have handled BOOTSTRAP.md.',
      createdAt: 1_000,
    },
    {
      id: 'assistant-ok',
      role: 'assistant',
      content: '在，Elon 在线。',
      createdAt: 2_000,
    },
  ])

  assert.deepEqual(messages.map(message => message.id), ['assistant-ok'])
})

test('pending messages become stale after the backend polling window', () => {
  assert.equal(
    isPendingMessageStale({
      id: 'local-user',
      role: 'user',
      content: 'hey',
      createdAt: 1_000,
      status: 'sending',
    }, 130_000),
    true,
  )
})

test('listStoredConversations expires stale streaming assistant messages', () => {
  const store = new Map()
  global.window = {
    localStorage: {
      getItem: key => store.get(key) || null,
      setItem: (key, value) => store.set(key, value),
    },
  }
  store.set('imai.conversations.v1:owner', JSON.stringify([
    {
      id: 'thread',
      title: 'Elon',
      messages: [
        {
          id: 'assistant-streaming',
          runId: 'run-stale',
          role: 'assistant',
          content: 'partial reply',
          createdAt: Date.now() - 180_000,
          status: 'streaming',
        },
      ],
    },
  ]))

  const conversations = listStoredConversations('owner')

  assert.equal(conversations[0].messages[0].status, 'failed')
  delete global.window
})

test('listStoredConversations filters historical gateway noise messages', () => {
  const store = new Map()
  global.window = {
    localStorage: {
      getItem: key => store.get(key) || null,
      setItem: (key, value) => store.set(key, value),
    },
  }
  store.set('imai.conversations.v1:owner', JSON.stringify([
    {
      id: 'thread',
      title: '雷军',
      messages: [
        {
          id: 'user-failed',
          role: 'user',
          content: '@mcp:tikhub-xiaohongshu 搜索',
          createdAt: 1_000,
          status: 'failed',
        },
        {
          id: 'assistant-stop',
          role: 'assistant',
          content: '本轮对话已停止。',
          createdAt: 2_000,
          status: 'failed',
        },
        {
          id: 'assistant-empty-final',
          role: 'assistant',
          content: 'Uniopc 引擎 finished with no text.',
          createdAt: 3_000,
          status: 'sent',
        },
        {
          id: 'assistant-timeout',
          role: 'assistant',
          content: '发送 Uniopc 引擎 对话失败: Uniopc 引擎 运行仍未结束，请稍后刷新会话历史。',
          createdAt: 3_500,
          status: 'failed',
        },
        {
          id: 'bootstrap-pending',
          role: 'user',
          content: '[Bootstrap pending]\nPlease read BOOTSTRAP.md from the workspace and follow it before replying normally.\nDo not use a generic first greeting or reply normally until after you have handled BOOTSTRAP.md.',
          createdAt: 3_700,
          status: 'sent',
        },
        {
          id: 'heartbeat-poll',
          role: 'user',
          content: '[Uniopc 引擎 heartbeat poll]',
          createdAt: 3_800,
          status: 'sent',
        },
        {
          id: 'assistant-ok',
          role: 'assistant',
          content: '已整理完成',
          createdAt: 4_000,
          status: 'sent',
        },
      ],
    },
  ]))

  const conversations = listStoredConversations('owner')

  assert.deepEqual(
    conversations[0].messages.map(message => message.id),
    ['assistant-ok'],
  )
  delete global.window
})

test('mergeConversationHistoryMessages keeps optimistic attachments when history has none', () => {
  const pending = {
    id: 'user-turn-1',
    role: 'user',
    content: '看下这张图',
    createdAt: 1_000,
    status: 'sending',
    attachments: [{ id: 'a', dataUrl: 'data:image/png;base64,aGk=' }],
  }
  const history = [
    { id: 'gateway-user-1', role: 'user', content: '看下这张图', createdAt: 1_000 },
    { id: 'gateway-assistant-1', role: 'assistant', content: '看到了', createdAt: 1_100 },
  ]

  const merged = mergeConversationHistoryMessages([pending], history, 1_200)
  const userMessage = merged.find(message => message.role === 'user')
  assert.equal(userMessage.status, 'sent')
  assert.deepEqual(userMessage.attachments, pending.attachments)
})

test('mergeConversationHistoryMessages prefers engine media paths over the local preview', () => {
  const pending = {
    id: 'user-turn-1',
    role: 'user',
    content: '看下这张图',
    createdAt: 1_000,
    status: 'sending',
    attachments: [{ id: 'local', dataUrl: 'data:image/png;base64,aGk=' }],
  }
  const history = [
    {
      id: 'gateway-user-1',
      role: 'user',
      content: '看下这张图',
      createdAt: 1_000,
      attachments: [{ id: 'media-x', path: '/media/inbound/x.png', dataUrl: 'asset://x' }],
    },
    { id: 'gateway-assistant-1', role: 'assistant', content: '看到了', createdAt: 1_100 },
  ]

  const merged = mergeConversationHistoryMessages([pending], history, 1_200)
  const userMessage = merged.find(message => message.role === 'user')
  assert.deepEqual(userMessage.attachments.map(item => item.path), ['/media/inbound/x.png'])
})

test('mergeConversationHistoryMessages keeps a caption-less image turn alive', () => {
  const pending = {
    id: 'user-turn-1',
    role: 'user',
    content: '',
    createdAt: 1_000,
    status: 'sending',
    attachments: [{ id: 'a', dataUrl: 'data:image/png;base64,aGk=' }],
  }

  const merged = mergeConversationHistoryMessages([pending], [], 1_050)
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0].attachments, pending.attachments)
})

test('listStoredConversations persists engine media but never base64 previews', () => {
  const store = new Map()
  global.window = {
    localStorage: {
      getItem: key => store.get(key) || null,
      setItem: (key, value) => store.set(key, value),
    },
  }
  store.set('imai.conversations.v1:owner', JSON.stringify([
    {
      id: 'c1',
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: '看下这张图',
          createdAt: 1_000,
          attachments: [
            { id: 'media-x', name: 'x.png', mimeType: 'image/png', path: '/media/inbound/x.png', dataUrl: 'asset://x' },
            { id: 'local', name: 'y.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,aGk=' },
          ],
        },
      ],
    },
  ]))

  const [conversation] = listStoredConversations('owner')
  assert.deepEqual(conversation.messages[0].attachments.map(item => item.path), ['/media/inbound/x.png'])
  delete global.window
})

test('conversations are stored as an index plus one key per transcript', () => {
  const { store } = installLocalStorage()

  saveStoredConversations('owner', [conversation('c1', 2_000, 'hello')])

  assert.equal(store.has('imai.conversation-index.v1:owner'), true)
  assert.equal(store.has('imai.conversation-messages.v1:owner:c1'), true)
  // The index must stay small — messages never belong in it.
  assert.equal(JSON.parse(store.get('imai.conversation-index.v1:owner'))[0].messages, undefined)

  const [restored] = listStoredConversations('owner')
  assert.equal(restored.id, 'c1')
  assert.equal(restored.messages[0].content, 'hello')
  delete global.window
})

test('an unchanged transcript is not rewritten on every save', () => {
  const { writes } = installLocalStorage()
  const stable = conversation('c1', 2_000, 'hello')
  const busy = conversation('c2', 3_000, 'first')

  saveStoredConversations('owner', [stable, busy])
  const before = writes.filter(key => key.includes('messages.v1:owner:c1')).length

  saveStoredConversations('owner', [stable, conversation('c2', 4_000, 'second')])
  const after = writes.filter(key => key.includes('messages.v1:owner:c1')).length

  assert.equal(before, 1)
  assert.equal(after, 1, 'an untouched conversation must not be rewritten')
  delete global.window
})

test('the legacy single-blob layout is migrated and then removed', () => {
  const { store } = installLocalStorage()
  store.set('imai.conversations.v1:owner', JSON.stringify([conversation('old', 1_000, 'legacy')]))

  const [beforeMigration] = listStoredConversations('owner')
  assert.equal(beforeMigration.messages[0].content, 'legacy')

  saveStoredConversations('owner', [beforeMigration])

  assert.equal(store.has('imai.conversations.v1:owner'), false)
  assert.equal(listStoredConversations('owner')[0].messages[0].content, 'legacy')
  delete global.window
})

test('a full quota is reported instead of silently losing history', () => {
  const messages = []
  installLocalStorage({ failWrites: key => key.startsWith('imai.conversation-messages.v1') })
  const unsubscribe = subscribeConversationStorageError(message => messages.push(message))

  saveStoredConversations('owner', [conversation('c1', 2_000, 'hello')])

  assert.equal(messages.length, 1)
  assert.match(messages[0], /空间不足|QuotaExceededError/)
  unsubscribe()
  delete global.window
})

test('the same text sent twice stays two messages when keys differ', () => {
  const current = [
    { id: 'local-a', role: 'user', content: '继续', createdAt: 1_000, status: 'sent', idempotencyKey: 'turn-a' },
    { id: 'local-b', role: 'user', content: '继续', createdAt: 3_000, status: 'sent', idempotencyKey: 'turn-b' },
  ]
  const history = [
    { id: 'srv-a', role: 'user', content: '继续', createdAt: 1_100, idempotencyKey: 'turn-a' },
    { id: 'srv-reply-a', role: 'assistant', content: '好的', createdAt: 2_000 },
    { id: 'srv-b', role: 'user', content: '继续', createdAt: 3_100, idempotencyKey: 'turn-b' },
    { id: 'srv-reply-b', role: 'assistant', content: '继续中', createdAt: 4_000 },
  ]

  const merged = mergeConversationHistoryMessages(current, history, 30_000)

  assert.deepEqual(
    merged.map(message => message.id),
    ['local-a', 'srv-reply-a', 'local-b', 'srv-reply-b'],
  )
})

test('a matching key wins over a timestamp far outside the guess window', () => {
  const current = [
    { id: 'local-a', role: 'user', content: '你好', createdAt: 1_000, status: 'sending', idempotencyKey: 'turn-a' },
  ]
  // Server clock is 60s ahead — the content+10s heuristic would call these two
  // different messages and show the turn twice.
  const history = [
    { id: 'srv-a', role: 'user', content: '你好', createdAt: 61_000, idempotencyKey: 'turn-a' },
    { id: 'srv-reply', role: 'assistant', content: '在', createdAt: 62_000 },
  ]

  const merged = mergeConversationHistoryMessages(current, history, 70_000)

  assert.deepEqual(merged.map(message => message.id), ['local-a', 'srv-reply'])
  assert.equal(merged[0].status, 'sent')
})

test('messages without keys still fall back to the content window', () => {
  const current = [{ id: 'local', role: 'user', content: 'hey', createdAt: 1_000, status: 'sending' }]
  const history = [{ id: 'srv', role: 'user', content: 'hey', createdAt: 1_200 }]

  const merged = mergeConversationHistoryMessages(current, history, 30_000)

  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, 'local')
})

test('messages older than a full history window are kept, not dropped', () => {
  const current = [
    { id: 'old-1', role: 'user', content: '第一句', createdAt: 1_000 },
    { id: 'old-2', role: 'assistant', content: '第一答', createdAt: 2_000 },
    { id: 'recent-user', role: 'user', content: '最近', createdAt: 9_000 },
  ]
  // The gateway returned a full page starting at 9_000 — everything before that
  // exists but was not sent.
  const history = [
    { id: 'srv-recent-user', role: 'user', content: '最近', createdAt: 9_000 },
    { id: 'srv-recent-reply', role: 'assistant', content: '最近答', createdAt: 9_500 },
  ]

  const merged = mergeConversationHistoryMessages(current, history, 30_000, { historyTruncated: true })

  assert.deepEqual(
    merged.map(message => message.id),
    ['old-1', 'old-2', 'srv-recent-user', 'srv-recent-reply'],
  )
})

test('a non-truncated history is authoritative and does not resurrect cleared messages', () => {
  const current = [
    { id: 'old-1', role: 'user', content: '第一句', createdAt: 1_000 },
    { id: 'old-2', role: 'assistant', content: '第一答', createdAt: 2_000 },
  ]
  // Session was reset: the engine now only has the newest exchange, and the page
  // is not full, so the older rows are genuinely gone.
  const history = [
    { id: 'srv-user', role: 'user', content: '重新开始', createdAt: 9_000 },
    { id: 'srv-reply', role: 'assistant', content: '好的', createdAt: 9_500 },
  ]

  const merged = mergeConversationHistoryMessages(current, history, 30_000, { historyTruncated: false })

  assert.deepEqual(merged.map(message => message.id), ['srv-user', 'srv-reply'])
})

test('the gateway role-suffixed key matches the key we sent', () => {
  // Observed shape: we send `<turnId>`, the user row comes back as
  // `<turnId>:user`. Treating those as different messages duplicated every
  // single user turn in the transcript.
  const turnId = 'dba104d0-3515-4fa2-9215-32d4f6b219d1'
  const current = [
    { id: `user-${turnId}`, role: 'user', content: 'hey', createdAt: 1785813929821, status: 'sent', idempotencyKey: turnId },
  ]
  const history = [
    { id: '05be89f0', role: 'user', content: 'hey', createdAt: 1785813929901, idempotencyKey: `${turnId}:user` },
    { id: 'bb3037e4', role: 'assistant', content: '嘿，我在。需要做什么？', createdAt: 1785813930774 },
  ]

  const merged = mergeConversationHistoryMessages(current, history, 1785813940000)

  assert.deepEqual(merged.map(message => message.id), [`user-${turnId}`, 'bb3037e4'])
})

test('different turns stay separate even after the role suffix is stripped', () => {
  const current = [
    { id: 'local-a', role: 'user', content: '继续', createdAt: 1_000, status: 'sent', idempotencyKey: 'turn-a' },
    { id: 'local-b', role: 'user', content: '继续', createdAt: 3_000, status: 'sent', idempotencyKey: 'turn-b' },
  ]
  const history = [
    { id: 'srv-a', role: 'user', content: '继续', createdAt: 1_100, idempotencyKey: 'turn-a:user' },
    { id: 'reply-a', role: 'assistant', content: '第一次好的', createdAt: 2_000 },
    { id: 'srv-b', role: 'user', content: '继续', createdAt: 3_100, idempotencyKey: 'turn-b:user' },
    { id: 'reply-b', role: 'assistant', content: '第二次好的', createdAt: 4_000 },
  ]

  const merged = mergeConversationHistoryMessages(current, history, 30_000)

  assert.deepEqual(merged.map(message => message.id), ['local-a', 'reply-a', 'local-b', 'reply-b'])
})
