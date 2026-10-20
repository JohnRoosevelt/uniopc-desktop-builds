import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('conversation send command returns after gateway accepted ack without waiting for final content', () => {
  const source = read('src-tauri/src/commands/conversations/mod.rs')
  const start = source.indexOf('pub async fn send_conversation_turn_inner')
  const end = source.indexOf('#[cfg(test)]', start)
  const sendInner = source.slice(start, end)
  const helperStart = source.indexOf('async fn send_gateway_chat_message')
  const helperEnd = source.indexOf('fn build_gateway_connect_attempt_result', helperStart)
  const sendHelper = source.slice(helperStart, helperEnd)

  assert.equal(sendHelper.includes('wait_run_terminal'), false)
  assert.equal(sendHelper.includes('wait_for_gateway_reply_content_for_endpoint'), false)
  assert.equal(sendInner.includes('wait_run_terminal'), false)
  assert.equal(sendInner.includes('sync_generated_project_documents'), false)
  assert.equal(sendInner.includes('fetch_gateway_history_for_endpoint'), false)
  assert.equal(sendInner.includes('data_flow: "openclaw.gateway.chat.accepted"'), true)
})

test('conversation UI keeps assistant streaming after send ack and lets events finalize it', () => {
  const client = read('src/lib/conversations/client.js')
  const page = read('src/pages/Conversations.jsx')
  const sendStart = page.indexOf('const res = await sendConversationTurn')
  const catchStart = page.indexOf('} catch (err) {', sendStart)
  const ackBlock = page.slice(sendStart, catchStart)

  assert.equal(client.includes("content: res.content || '模型没有返回内容。'"), false)
  assert.equal(page.includes('const assistantMessage = {'), false)
  assert.equal(ackBlock.includes('const acceptedRunId = res.meta?.runId || turnId'), true)
  assert.equal(ackBlock.includes('if (acceptedRunId !== turnId)'), true)
  assert.equal(ackBlock.includes('res.content || message.content'), false)
  assert.equal(ackBlock.includes("status: message.status === 'sent' ? 'sent' : 'streaming'"), false)
})

test('conversation UI marks pending run before awaiting gateway send ack', () => {
  const page = read('src/pages/Conversations.jsx')
  const sendingStart = page.indexOf('setSendingConversationIds(prev => new Set(prev).add(activeConversationId))')
  const sendStart = page.indexOf('const res = await sendConversationTurn', sendingStart)
  const beforeAwaitSend = page.slice(sendingStart, sendStart)
  const ackBlockStart = page.indexOf('const res = await sendConversationTurn')
  const ackBlockEnd = page.indexOf('updateConversation(activeConversationId, item => {', ackBlockStart)
  const ackPrelude = page.slice(ackBlockStart, ackBlockEnd)

  assert.equal(beforeAwaitSend.includes('setPendingGatewayRunByConversation(prev => ({'), true)
  assert.equal(beforeAwaitSend.includes('[activeConversationId]: turnId'), true)
  assert.equal(ackPrelude.includes('if (acceptedRunId !== turnId)'), true)
})

test('queued retry stays targeted and never clears the composer or switches conversations', () => {
  const page = read('src/pages/Conversations.jsx')
  const banner = read('src/pages/conversations/ConversationStatusBanner.jsx')
  const retryStart = page.indexOf('function retryQueuedConversationMessage(conversationId, queuedId)')
  const retryEnd = page.indexOf('// Drain one message at a time', retryStart)
  const retrySource = page.slice(retryStart, retryEnd)
  const queueRenderStart = page.indexOf('{activeQueuedMessages.map((queued, index) => (')
  // The composer starts with mention suggestions; its CSS layout can change.
  const queueRenderEnd = page.indexOf('{mentionQuery &&', queueRenderStart)
  const queueRenderSource = page.slice(queueRenderStart, queueRenderEnd)

  assert.notEqual(retryStart, -1)
  assert.notEqual(retryEnd, -1)
  assert.notEqual(queueRenderStart, -1)
  assert.notEqual(queueRenderEnd, -1)
  assert.equal(queueRenderSource.includes('<ConversationStatusBanner'), true)
  assert.equal(queueRenderSource.includes('queuedMessageId={queued.id}'), true)
  assert.equal(queueRenderSource.includes('if (queuedMessageId !== queued.id) return'), true)
  assert.equal(
    queueRenderSource.includes('retryQueuedConversationMessage(activeConversationId, queued.id)'),
    true,
  )
  assert.equal(page.includes('title="重新发送"'), false)
  assert.equal(banner.includes('title="重新发送"'), true)
  assert.equal(banner.includes('onClick={() => onRetryQueuedMessage(queuedMessageId)}'), true)
  assert.equal(retrySource.includes("setInput('')"), false)
  assert.equal(retrySource.includes('setActiveConversation'), false)
  assert.equal(retrySource.includes('activeConversationId ='), false)
  assert.equal(retrySource.includes('setSelectedSessionByEmployee'), false)
  assert.equal(retrySource.includes('setSearchParams'), false)
  assert.equal(retrySource.includes('selectGatewayConversationSession'), false)
  assert.equal(retrySource.includes('selectEmployee('), false)
  assert.equal(retrySource.includes('openEmployeeSettings('), false)
  assert.equal(retrySource.includes('setEmployees'), false)
  assert.equal(retrySource.includes('setConversationSessions'), false)
})

test('conversation UI subscribes active session before history load like official client', () => {
  const client = read('src/lib/conversations/client.js')
  const page = read('src/pages/Conversations.jsx')
  const commands = read('src-tauri/src/commands/conversations/turns.rs')
  const lib = read('src-tauri/src/lib.rs')
  const sessionStart = page.indexOf('const activeConversationSessionKey =')
  const historyLoadStart = page.indexOf('loadConversationHistory(activeConversationSessionKey, historyProfile)', sessionStart)
  const activeSessionSetup = page.slice(sessionStart, historyLoadStart)

  assert.equal(client.includes('export async function subscribeConversationSession'), true)
  assert.equal(client.includes('engineClient.sessions.subscribe({ sessionKey: normalized, profile })'), true)
  assert.equal(client.includes("invoke('conversation_subscribe_session'"), false)
  assert.equal(page.includes('subscribeConversationSession,'), true)
  assert.equal(page.includes('loadCachedConversationHistory'), false)
  assert.equal(activeSessionSetup.includes('subscribeConversationSession(activeConversationSessionKey, historyProfile)'), true)
  assert.equal(commands.includes('pub async fn conversation_subscribe_session'), true)
  assert.equal(lib.includes('commands::conversations::turns::conversation_subscribe_session'), true)
})
