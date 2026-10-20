import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { createConversationPermissionCoordinator } from '../lib/conversationPermissionCoordinator.js'
import * as outbox from '../lib/conversationOutbox.js'

const source = fs.readFileSync(new URL('./Conversations.jsx', import.meta.url), 'utf8')
const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] })
const traverse = traverseModule.default ?? traverseModule
let sendSource
let editFailedSource
let drainSource
let textareaDisabled
let submitDisabled
traverse(ast, {
  FunctionDeclaration(path) {
    if (path.node.id?.name === 'sendMessage') sendSource = source.slice(path.node.start, path.node.end)
    if (path.node.id?.name === 'editResendFailedMessage') editFailedSource = source.slice(path.node.start, path.node.end)
  },
  CallExpression(path) {
    if (path.node.callee.name !== 'useEffect') return
    const callback = path.node.arguments[0]
    if (!callback) return
    const body = source.slice(callback.start, callback.end)
    if (body.includes('claimQueuedConversationOutbox(')) drainSource = body
  },
  JSXOpeningElement(path) {
    const attributes = path.node.attributes
    const disabled = attributes.find(attr => attr.name?.name === 'disabled')?.value?.expression
    if (path.node.name.name === 'textarea') textareaDisabled = disabled && source.slice(disabled.start, disabled.end)
    const title = attributes.find(attr => attr.name?.name === 'title')?.value?.value
    if (path.node.name.name === 'button' && title === '发送') submitDisabled = disabled && source.slice(disabled.start, disabled.end)
  },
})

test('transcript edit reports a durable removal error and preserves the existing draft', () => {
  composer()
  outbox.enqueueConversationOutbox('owner', { id: 'outbox-original', text: 'old', conversationId: 'c1' })
  window.localStorage.setItem = () => { throw new Error('quota') }
  let error = ''
  let draft = 'new draft'
  const edit = vm.runInNewContext(`(${editFailedSource})`, {
    permissionCoordinatorRef: { current: createConversationPermissionCoordinator() },
    ...outbox, storageOwnerId: 'owner', setOutboxEntries: () => {},
    setError: value => { error = value }, setInput: value => { draft = value },
    inputRef: { current: { focus() {} } },
  })
  assert.doesNotThrow(() => edit({ id: 'user-original', content: 'old' }))
  assert.match(error, /保存/)
  assert.equal(draft, 'new draft')
  delete global.window
})

// Execute the actual submit handler with a real durable outbox. Gateway and
// React setters are boundary doubles; an accidental pre-readiness RPC throws.
function composer({ ready = false } = {}) {
  outbox.__resetOutboxRevivalForTests()
  const data = new Map()
  global.window = { localStorage: {
    getItem: key => data.get(key) || null,
    setItem: (key, value) => data.set(key, value),
  } }
  const state = { input: '现在就开始', error: '', queue: [] }
  const context = vm.createContext({
    crypto: global.crypto,
    input: state.input, imageAttachments: [],
    activeTarget: { id: 'emp' }, activeEmployee: { id: 'emp' },
    activeConversationRouteReady: true, conversationModelReady: ready,
    turnInFlight: false, storageOwnerId: 'owner', conversationOwnerId: 'owner',
    activeProfile: 'profile-a', activeConversationId: 'c1',
    activeConversationSessionKey: 'agent:emp:main', approvalMode: 'full',
    MAX_QUEUED_MESSAGES: 10,
    permissionCoordinatorRef: { current: createConversationPermissionCoordinator() },
    ...outbox,
    setError: value => { state.error = value },
    setOutboxEntries: value => { state.queue = value },
    setInput: value => { state.input = value },
    setImageAttachments: () => {}, closeMentionMenu: () => {},
    setSelectedSessionByEmployee: () => {},
    validateConversationImageAttachments: () => {},
    sendConversationTurn: () => { throw new Error('Gateway must not be called by input acceptance') },
  })
  context.permissionCoordinatorRef.current.observe('profile-a', [{ sessionKey: 'agent:emp:main', permissionMode: 'full' }], 0)
  const send = vm.runInContext(`(${sendSource})`, context)
  return { send, state }
}

test('Enter during local engine startup saves the message and clears the composer without a Gateway call', async () => {
  const { send, state } = composer()
  await send(null)
  assert.equal(state.input, '')
  assert.equal(state.error, '')
  const [entry] = outbox.listConversationOutbox('owner')
  assert.equal(entry.text, '现在就开始')
  assert.equal(entry.profile, 'profile-a')
  assert.equal(entry.sessionKey, 'agent:emp:main')
  assert.equal(entry.approvalMode, 'full')
  delete global.window
})

test('ready idle submissions bypass the pending-message queue', () => {
  assert.match(sendSource, /shouldQueueConversationSubmission\(\{[\s\S]*?turnInFlight,[\s\S]*?conversationModelReady/)
  assert.equal(outbox.shouldQueueConversationSubmission({
    hasEmployee: true,
    conversationModelReady: true,
    turnInFlight: false,
  }), false)
})

test('the actual composer is editable before roster arrival and its send button accepts input before engine readiness', () => {
  assert.equal(textareaDisabled ? vm.runInNewContext(textareaDisabled, { activeTarget: null }) : false, false)
  assert.equal(vm.runInNewContext(submitDisabled, {
    activeTarget: { id: 'emp' }, activeConversationRouteReady: true,
    conversationModelReady: false, activeQueuedMessages: [], MAX_QUEUED_MESSAGES: 10,
    input: 'hello', imageAttachments: [],
  }), false)
})

test('the real drain claims once and retains a failed send for explicit retry', async () => {
  const { send } = composer()
  await send(null)
  let calls = 0
  const context = vm.createContext({
    permissionCoordinatorRef: { current: createConversationPermissionCoordinator() },
    ...outbox, turnInFlight: false, conversationModelReady: true,
    activeConversationRouteReady: true, conversationOwnerId: 'owner', storageOwnerId: 'owner',
    activeProfile: 'profile-a', activeConversationId: 'c1', activeEmployee: { id: 'emp' },
    activeConversationSessionKey: 'agent:emp:main',
    outboxEntries: outbox.listConversationOutbox('owner'),
    setOutboxEntries: () => {},
    setSelectedSessionByEmployee: () => {},
    sendMessage: async (_event, text, attachments, claimed) => {
      calls += 1
      assert.equal(text, '现在就开始')
      assert.equal(claimed.status, outbox.OUTBOX_STATUS.sending)
      assert.ok(claimed.idempotencyKey)
      throw new Error('local engine stopped')
    },
  })
  const drain = vm.runInContext(`(${drainSource})`, context)
  drain()
  drain()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  const [entry] = outbox.listConversationOutbox('owner')
  assert.equal(entry.status, outbox.OUTBOX_STATUS.failed)
  assert.equal(entry.lastError, 'local engine stopped')
  drain()
  assert.equal(calls, 1)
  delete global.window
})

test('failed durable acceptance leaves the submitted text in the composer', async () => {
  const { send, state } = composer()
  window.localStorage.setItem = () => { throw new Error('quota') }
  await send(null)
  assert.equal(state.input, '现在就开始')
  assert.match(state.error, /保存/)
  assert.equal(outbox.listConversationOutbox('owner').length, 0)
  delete global.window
})
