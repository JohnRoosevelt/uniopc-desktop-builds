import test from 'node:test'
import assert from 'node:assert/strict'

import {
  __resetOutboxRevivalForTests,
  clearConversationOutbox,
  confirmConversationOutbox,
  enqueueConversationOutbox,
  listConversationOutbox,
  MAX_ENTRIES_PER_CONVERSATION,
  nextQueuedOutboxEntry,
  outboxEntriesFor,
  OUTBOX_STATUS,
  removeConversationOutbox,
  updateConversationOutbox,
  shouldQueueConversationSubmission,
} from './conversationOutbox.js'

test('ready idle messages send directly while blocked messages enter the outbox', () => {
  assert.equal(shouldQueueConversationSubmission({ hasEmployee: true, conversationModelReady: true, turnInFlight: false }), false)
  assert.equal(shouldQueueConversationSubmission({ hasEmployee: true, conversationModelReady: false, turnInFlight: false }), true)
  assert.equal(shouldQueueConversationSubmission({ hasEmployee: true, conversationModelReady: true, turnInFlight: true }), true)
  assert.equal(shouldQueueConversationSubmission({ hasEmployee: true, fromQueue: true, conversationModelReady: false }), false)
})
import * as outbox from './conversationOutbox.js'

function installStorage() {
  __resetOutboxRevivalForTests()
  const store = new Map()
  global.window = {
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
      removeItem: key => store.delete(key),
    },
  }
  if (!global.crypto) global.crypto = { randomUUID: () => `id-${store.size}-${Math.random()}` }
  return store
}

const chatContext = {
  conversationId: 'c1', profile: 'profile-a', employeeId: 'emp',
  sessionKey: 'agent:emp:main', ready: true, routeReady: true,
}

test('startup accepts a durable message immediately but cannot claim it before readiness', () => {
  installStorage()
  const { entry } = enqueueConversationOutbox('owner', { ...chatContext, text: '开始工作', approvalMode: 'default' })
  assert.equal(typeof outbox.claimQueuedConversationOutbox, 'function')
  assert.equal(outbox.claimQueuedConversationOutbox('owner', { ...chatContext, ready: false }), null)
  assert.equal(listConversationOutbox('owner')[0].text, '开始工作')
  const claimed = outbox.claimQueuedConversationOutbox('owner', chatContext)
  assert.equal(claimed.id, entry.id)
  assert.equal(claimed.status, OUTBOX_STATUS.sending)
  assert.equal(claimed.approvalMode, 'default')
  assert.ok(claimed.idempotencyKey)
  assert.equal(outbox.claimQueuedConversationOutbox('owner', chatContext), null, 'two consumers cannot send the same entry')
  delete global.window
})

test('claim never reroutes messages across owner, profile, employee, session or an unsettled route', () => {
  installStorage()
  enqueueConversationOutbox('owner', { ...chatContext, text: '只发到原会话' })
  assert.equal(typeof outbox.claimQueuedConversationOutbox, 'function')
  assert.equal(outbox.claimQueuedConversationOutbox('another-owner', chatContext), null)
  for (const patch of [{ profile: 'profile-b' }, { employeeId: 'other' }, { sessionKey: 'agent:emp:other' }, { routeReady: false }, { ready: false }]) {
    assert.equal(outbox.claimQueuedConversationOutbox('owner', { ...chatContext, ...patch }), null)
  }
  assert.equal(listConversationOutbox('owner')[0].status, OUTBOX_STATUS.queued)
  delete global.window
})

test('restart retains the original idempotency key and waits for canonical confirmation', () => {
  installStorage()
  enqueueConversationOutbox('owner', { ...chatContext, text: '一次', approvalMode: 'full' })
  assert.equal(typeof outbox.claimQueuedConversationOutbox, 'function')
  const claimed = outbox.claimQueuedConversationOutbox('owner', chatContext)
  __resetOutboxRevivalForTests()
  const restored = listConversationOutbox('owner')[0]
  assert.equal(listConversationOutbox('owner')[0].status, OUTBOX_STATUS.confirming, 'revival must persist as confirmation, not replay a possibly accepted send')
  assert.equal(restored.idempotencyKey, claimed.idempotencyKey)
  assert.equal(restored.approvalMode, 'full')
  removeConversationOutbox('owner', restored.id)
  assert.equal(outbox.claimQueuedConversationOutbox('owner', chatContext), null)
  delete global.window
})

test('a message whose attachment could not be saved is never silently sent as text only', () => {
  installStorage()
  enqueueConversationOutbox('owner', { ...chatContext, text: '分析这张图', attachments: [{ dataUrl: 'A'.repeat(2_000_000) }] })
  __resetOutboxRevivalForTests()
  assert.equal(typeof outbox.claimQueuedConversationOutbox, 'function')
  assert.equal(outbox.claimQueuedConversationOutbox('owner', chatContext), null)
  assert.equal(listConversationOutbox('owner')[0].attachmentsDropped, true)
  delete global.window
})

test('unwritable storage refuses acceptance rather than claiming a volatile message is saved', () => {
  installStorage()
  window.localStorage.setItem = () => { throw new Error('quota') }
  const result = enqueueConversationOutbox('owner', { ...chatContext, text: '不能丢失' })
  assert.equal(result.entry, null)
  assert.match(result.error, /保存/)
  assert.equal(listConversationOutbox('owner').length, 0)
  delete global.window
})

test('aggregate attachment pressure falls back to durable text while keeping live images', () => {
  const store = installStorage()
  window.localStorage.setItem = (key, value) => {
    if (value.length > 2000) throw new Error('quota')
    store.set(key, value)
  }
  const result = enqueueConversationOutbox('owner', { ...chatContext, text: '保留文本', attachments: [{ dataUrl: 'A'.repeat(3000) }] })
  assert.ok(result.entry)
  assert.equal(listConversationOutbox('owner')[0].attachments[0].dataUrl.length, 3000)
  __resetOutboxRevivalForTests()
  assert.equal(listConversationOutbox('owner')[0].text, '保留文本')
  assert.equal(listConversationOutbox('owner')[0].attachmentsDropped, true)
  delete global.window
})

test('failed durable cancellation reports failure and keeps the message visible', () => {
  installStorage()
  const { entry } = enqueueConversationOutbox('owner', { ...chatContext, text: '不要假装取消了' })
  window.localStorage.setItem = () => { throw new Error('storage unavailable') }
  assert.throws(() => removeConversationOutbox('owner', entry.id), /保存/)
  assert.equal(listConversationOutbox('owner')[0].id, entry.id)
  delete global.window
})

test('a different Profile with the same employee/session cannot block or fill the active queue', () => {
  installStorage()
  for (let i = 0; i < MAX_ENTRIES_PER_CONVERSATION; i++) {
    enqueueConversationOutbox('owner', { ...chatContext, profile: 'old-profile', text: 'old' })
  }
  const { entry } = enqueueConversationOutbox('owner', { ...chatContext, text: 'new' })
  assert.ok(entry)
  assert.equal(outbox.claimQueuedConversationOutbox('owner', chatContext)?.text, 'new')
  assert.equal(outboxEntriesFor(listConversationOutbox('owner'), 'c1', 'profile-a').length, 1)
  delete global.window
})

test('a queued message survives a reload', () => {
  installStorage()

  enqueueConversationOutbox('owner', {
    conversationId: 'c1',
    sessionKey: 'agent:emp:main',
    text: '等你忙完看下这个',
  })
  const restored = listConversationOutbox('owner')
  assert.equal(restored.length, 1)
  assert.equal(restored[0].text, '等你忙完看下这个')
  assert.equal(restored[0].status, OUTBOX_STATUS.queued)
  delete global.window
})

test('an entry left mid-send waits for confirmation, not an automatic replay', () => {
  installStorage()
  const { entry } = enqueueConversationOutbox('owner', { conversationId: 'c1', text: 'hi' })
  updateConversationOutbox('owner', entry.id, { status: OUTBOX_STATUS.sending })

  // Within the session the flag must stick, or the drain loop would start a
  // second send for the same entry.
  assert.equal(listConversationOutbox('owner')[0].status, OUTBOX_STATUS.sending)

  // After a restart it must not be replayed while delivery is still unknown.
  __resetOutboxRevivalForTests()
  assert.equal(listConversationOutbox('owner')[0].status, OUTBOX_STATUS.confirming)
  delete global.window
})

test('oversized attachments are dropped from disk and flagged', () => {
  installStorage()
  const huge = [{ id: 'a', dataUrl: `data:image/png;base64,${'A'.repeat(2_000_000)}` }]

  enqueueConversationOutbox('owner', { conversationId: 'c1', text: '看图', attachments: huge })
  __resetOutboxRevivalForTests()

  const [restored] = listConversationOutbox('owner')
  assert.equal(restored.attachments.length, 0)
  assert.equal(restored.attachmentsDropped, true)
  assert.equal(restored.text, '看图')
  delete global.window
})

test('a large image can still be sent in the current session while only its text is persisted', () => {
  installStorage()
  const dataUrl = `data:image/png;base64,${'A'.repeat(2_000_000)}`
  enqueueConversationOutbox('owner', { ...chatContext, text: '分析大图', attachments: [{ dataUrl }] })
  const claimed = outbox.claimQueuedConversationOutbox('owner', chatContext)
  assert.equal(claimed?.attachments[0]?.dataUrl, dataUrl)
  assert.equal(claimed.attachmentsDropped, false)
  delete global.window
})

test('small attachments are kept', () => {
  installStorage()
  const small = [{ id: 'a', path: '/media/inbound/x.png', dataUrl: 'asset://x' }]

  enqueueConversationOutbox('owner', { conversationId: 'c1', text: '看图', attachments: small })

  const [restored] = listConversationOutbox('owner')
  assert.equal(restored.attachments.length, 1)
  assert.equal(restored.attachmentsDropped, false)
  delete global.window
})

test('drain order is oldest first and pauses while one is in flight', () => {
  installStorage()
  enqueueConversationOutbox('owner', { conversationId: 'c1', text: 'first', createdAt: 1_000 })
  enqueueConversationOutbox('owner', { conversationId: 'c1', text: 'second', createdAt: 2_000 })

  let entries = listConversationOutbox('owner')
  const head = nextQueuedOutboxEntry(entries, 'c1')
  assert.equal(head.text, 'first')

  entries = updateConversationOutbox('owner', head.id, { status: OUTBOX_STATUS.sending })
  assert.equal(nextQueuedOutboxEntry(entries, 'c1'), null, 'must not send two at once')

  entries = removeConversationOutbox('owner', head.id)
  assert.equal(nextQueuedOutboxEntry(entries, 'c1').text, 'second')
  delete global.window
})

test('canonical user history retires only the matching outbox message', () => {
  installStorage()
  enqueueConversationOutbox('owner', { ...chatContext, idempotencyKey: 'turn-one', text: 'first' })
  enqueueConversationOutbox('owner', { ...chatContext, idempotencyKey: 'turn-two', text: 'second' })

  const entries = confirmConversationOutbox('owner', {
    profile: chatContext.profile,
    sessionKey: chatContext.sessionKey,
    messages: [{ role: 'user', idempotencyKey: 'turn-one:user' }],
  })

  assert.deepEqual(entries.map(entry => entry.idempotencyKey), ['turn-two'])
  delete global.window
})

test('a failed entry waits for an explicit retry instead of blocking the queue', () => {
  installStorage()
  const { entry: broken } = enqueueConversationOutbox('owner', { conversationId: 'c1', text: 'bad', createdAt: 1_000 })
  enqueueConversationOutbox('owner', { conversationId: 'c1', text: 'good', createdAt: 2_000 })

  const entries = updateConversationOutbox('owner', broken.id, {
    status: OUTBOX_STATUS.failed,
    lastError: '引擎未运行',
  })

  assert.equal(nextQueuedOutboxEntry(entries, 'c1').text, 'good')
  assert.equal(entries.find(item => item.id === broken.id).lastError, '引擎未运行')
  delete global.window
})

test('entries stay scoped to their own conversation', () => {
  installStorage()
  enqueueConversationOutbox('owner', { conversationId: 'c1', text: 'a' })
  enqueueConversationOutbox('owner', { conversationId: 'c2', text: 'b' })

  const entries = listConversationOutbox('owner')
  assert.equal(outboxEntriesFor(entries, 'c1').length, 1)
  assert.equal(nextQueuedOutboxEntry(entries, 'c2').text, 'b')

  clearConversationOutbox('owner', 'c1')
  assert.deepEqual(listConversationOutbox('owner').map(item => item.text), ['b'])
  delete global.window
})

test('a conversation cannot queue past its cap', () => {
  installStorage()
  for (let index = 0; index < MAX_ENTRIES_PER_CONVERSATION; index += 1) {
    const { entry } = enqueueConversationOutbox('owner', { conversationId: 'c1', text: `m${index}` })
    assert.notEqual(entry, null)
  }

  const { entry } = enqueueConversationOutbox('owner', { conversationId: 'c1', text: 'overflow' })
  assert.equal(entry, null)
  assert.equal(listConversationOutbox('owner').length, MAX_ENTRIES_PER_CONVERSATION)
  delete global.window
})

test('saved queue labels explain the actual blocker without claiming engine readiness or automatic retry', () => {
  assert.equal(typeof outbox.conversationOutboxStatusLabel, 'function')
  const label = outbox.conversationOutboxStatusLabel
  assert.equal(label({ status: 'queued' }, { gatewayReady: false }), '已保存 · 本地助手准备完成后发送')
  assert.equal(label({ status: 'queued' }, { gatewayReady: true, conversationModelReady: false }), '已保存 · 等待对话配置就绪')
  assert.equal(label({ status: 'queued' }, { gatewayReady: true, conversationModelReady: true, turnInFlight: true }), '已保存 · 等待当前回复结束')
  assert.equal(label({ status: 'queued' }, { gatewayReady: true, conversationModelReady: true }), '已保存 · 按顺序发送')
  assert.equal(label({ status: 'failed' }, { gatewayReady: false }), '发送失败 · 请重试或编辑')
  assert.equal(label({ status: 'confirming' }, { gatewayReady: false }), '正在确认是否已发送 · 请等待或手动重试')
  assert.equal(label({ status: 'sending' }, { gatewayReady: false }), '正在发送')
})
