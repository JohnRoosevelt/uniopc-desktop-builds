import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

// Accio-style "send while running" queue: messages typed during an in-flight turn
// are held per-conversation and drained one-by-one between turns. This is a
// renderer product-layer queue, NOT the gateway `chat.inject` mid-turn primitive.
test('conversation composer queues messages typed during an in-flight turn', () => {
  const source = read('src/pages/Conversations.jsx')

  // Queue state is hydrated from the durable outbox, not from empty React state:
  // a message typed while busy must survive switching conversation and restart.
  assert.equal(
    source.includes('const [outboxEntries, setOutboxEntries] = useState(() => listConversationOutbox(storageOwnerId))'),
    true,
  )
  assert.equal(source.includes('MAX_ENTRIES_PER_CONVERSATION as MAX_QUEUED_MESSAGES'), true)

  // sendMessage grows a fromQueue drain flag.
  assert.equal(
    source.includes('async function sendMessage(event, draft = input, draftAttachments = imageAttachments, fromQueue = null)'),
    true,
  )

  // Input acceptance is independent of engine readiness; execution still waits.
  assert.equal(source.includes('if (shouldQueueConversationSubmission({'), true)
  assert.equal(source.includes('modelBootstrapInFlight'), false)
  assert.equal(source.includes('enqueueConversationOutbox(storageOwnerId, {'), true)

  // A drain must not clobber the composer's in-progress text.
  assert.equal(source.includes('if (!fromQueue) {\n      // A queue drain must not clobber whatever the user is typing next.'), true)
})

test('conversation queue drains one message per finished turn without double-sending', () => {
  const source = read('src/pages/Conversations.jsx')

  // Drain effect is gated on both an idle conversation and a ready model.
  assert.equal(source.includes('|| turnInFlight\n      || !conversationModelReady'), true)
  assert.equal(source.includes('sendMessage(null, head.text, head.attachments, head)'), true)
  // The atomic claim reads current storage, not the previous React render.
  assert.equal(source.includes('head = claimQueuedConversationOutbox(storageOwnerId, {'), true)
  assert.equal(
    source.includes('setOutboxEntries(listConversationOutbox(storageOwnerId))'),
    true,
  )
  // An ACK only moves the entry to confirmation; history owns retirement.
  assert.equal(source.includes('status: OUTBOX_STATUS.confirming,'), true)
  assert.equal(source.includes('confirmConversationOutbox(storageOwnerId, {'), true)
  assert.equal(source.includes('status: OUTBOX_STATUS.failed,'), true)
})

test('a send that fails is parked durably instead of vanishing on reload', () => {
  const source = read('src/pages/Conversations.jsx')
  const store = read('src/lib/conversationStore.js')

  // A failed user row is filtered out of the transcript on reload...
  assert.equal(store.includes("if (message.role === 'user' && message.status === 'failed') return true"), true)
  // ...so the failed send must also leave a durable outbox entry.
  assert.equal(source.includes('status: OUTBOX_STATUS.failed,'), true)
  assert.equal(source.includes('id: `outbox-${turnId}`'), true)
  // Edit-and-resend retires that same entry, so both paths cannot both deliver.
  assert.equal(source.includes('removeConversationOutbox(storageOwnerId, `outbox-${turnId}`)'), true)
  // sendMessage must reject so the drain loop can tell success from failure.
  assert.equal(source.includes('function handleComposerSubmit(event)'), true)
})

test('an ambiguous Gateway send waits for canonical confirmation before replay', () => {
  const source = read('src/pages/Conversations.jsx')
  const outbox = read('src/lib/conversationOutbox.js')

  assert.equal(source.includes('isConversationDeliveryUnconfirmedError(err)'), true)
  assert.equal(source.includes('return { deliveryUnconfirmed: true }'), true)
  assert.equal(source.includes('confirmConversationOutbox(storageOwnerId, {'), true)
  assert.equal(outbox.includes("confirming: 'confirming'"), true)
  assert.equal(outbox.includes('entry.status === OUTBOX_STATUS.sending ? { ...entry, status: OUTBOX_STATUS.confirming }'), true)
  assert.equal(outbox.includes('[OUTBOX_STATUS.sending, OUTBOX_STATUS.confirming].includes(entry.status)'), true)
})

test('a recoverable official-model send failure is requeued with its original idempotency key', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('const recovered = await recoverOfficialModelAuth({'), true)
  assert.equal(source.includes('status: OUTBOX_STATUS.queued,'), true)
  assert.equal(source.includes('lastError: \'\','), true)
  assert.equal(source.includes('autoRecovery: true'), true)
})

test('conversation queue chips are editable and removable', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('function removeQueuedConversationMessage(conversationId, queuedId)'), true)
  assert.equal(source.includes('function editQueuedConversationMessage(conversationId, queuedId)'), true)
  assert.equal(source.includes('conversationOutboxStatusLabel(queued, { gatewayReady, conversationModelReady, turnInFlight })'), true)
  assert.equal(source.includes('editQueuedConversationMessage(activeConversationId, queued.id)'), true)
  assert.equal(source.includes('removeQueuedConversationMessage(activeConversationId, queued.id)'), true)
})
