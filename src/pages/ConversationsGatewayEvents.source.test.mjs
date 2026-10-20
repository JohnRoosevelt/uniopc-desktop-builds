import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

// The browser dock also observes gateway tool events. These assertions cover
// the workspace transcript subscription, not whichever listener occurs first.
function workspaceGatewayListenerStart(source) {
  const workspaceStart = source.indexOf('function ConversationWorkspace()')
  assert.ok(workspaceStart >= 0, 'conversation workspace exists')
  const listenerStart = source.indexOf("listen('conversation-gateway-event'", workspaceStart)
  assert.ok(listenerStart >= workspaceStart, 'workspace gateway listener exists')
  return listenerStart
}

test('conversation gateway seq_gap clears sending state and refreshes history', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes("state === 'seq_gap'"), true)
  assert.equal(source.includes('setHistoryRefreshNonce(prev => prev + 1)'), true)
  assert.equal(source.includes('next.delete(item.id)'), true)
})

test('conversation recovery presentation leaves gateway and transcript state in the workspace', () => {
  const source = read('src/pages/Conversations.jsx')
  const bannerPath = path.join(repoRoot, 'src/pages/conversations/ConversationStatusBanner.jsx')
  const banner = fs.existsSync(bannerPath) ? fs.readFileSync(bannerPath, 'utf8') : ''

  assert.equal(source.includes("listen('conversation-gateway-event'"), true)
  assert.equal(source.includes('const [conversations, setConversations] = useState('), true)
  assert.equal(source.includes('const [input, setInput] = useState(\'\')'), true)
  assert.equal(source.includes('const activeConversationId = activeEmployee'), true)
  assert.equal(banner.includes("listen('conversation-gateway-event'"), false)
  assert.equal(banner.includes('setConversations'), false)
  assert.equal(banner.includes('setInput'), false)
  assert.equal(banner.includes('activeConversationId'), false)
})

test('conversation gateway assistant stream uses official temporary streaming bubble model', () => {
  const source = read('src/pages/Conversations.jsx')
  const listenerStart = workspaceGatewayListenerStart(source)
  const listenerEnd = source.indexOf('}).then(unlisten =>', listenerStart)
  const listenerSource = source.slice(listenerStart, listenerEnd)

  assert.equal(source.includes('const [streamingAssistantTextByConversation, setStreamingAssistantTextByConversation] = useState({})'), true)
  assert.equal(source.includes('const activeStreamingAssistantText = activeConversationId'), true)
  assert.equal(source.includes('ConversationStreamingAssistantBubble'), true)
  assert.equal(listenerSource.includes('setStreamingAssistantTextByConversation(prev => ({'), true)
  assert.equal(listenerSource.includes('const currentStreaming = streamingAssistantTextByConversation[item.id]'), false)
  assert.equal(listenerSource.includes('content,\n              status: \'streaming\''), false)
})

test('conversation gateway errors consume structured recovery without rendering message keys', () => {
  const source = read('src/pages/Conversations.jsx')
  const listenerStart = workspaceGatewayListenerStart(source)
  const listenerEnd = source.indexOf("  }, [])", listenerStart)
  const listener = source.slice(listenerStart, listenerEnd)

  assert.equal(listener.includes('const gatewayError = payload.gatewayError'), true)
  assert.equal(listener.includes('gatewayStreamErrorMessage(gatewayError)'), true)
  assert.equal(listener.includes('gatewayError,'), true)
  assert.equal(listener.includes('sanitizeBrand(errorMessage || content)'), false)
})

test('conversation gateway final keeps the streaming bubble until reloaded history lands', () => {
  const source = read('src/pages/Conversations.jsx')
  const listenerStart = workspaceGatewayListenerStart(source)
  const listenerEnd = source.indexOf('}).then(unlisten =>', listenerStart)
  const listenerSource = source.slice(listenerStart, listenerEnd)

  assert.equal(listenerSource.includes("state === 'final'"), true)
  // final defers the bubble teardown; error/aborted still clear immediately.
  assert.equal(listenerSource.includes('finalizedGatewayConversationsRef.current.add(item.id)'), true)
  assert.equal(listenerSource.includes('clearConversationStreamingAssistantText'), true)
  assert.equal(listenerSource.includes('setHistoryRefreshNonce(prev => prev + 1)'), true)
  assert.equal(listenerSource.includes("content: content || message.content || ''"), false)
  // The history loader is the one that retires the bubble after a final.
  assert.equal(source.includes('finalizedGatewayConversationsRef.current.has(activeConversationId)'), true)
})

test('conversation gateway final releases the next-send lock before history refresh completes', () => {
  const source = read('src/pages/Conversations.jsx')
  const terminalStart = source.indexOf("if (state === 'final' || state === 'error' || state === 'aborted')")
  const terminalEnd = source.indexOf("if (state.startsWith('tool_'))", terminalStart)
  const terminalSource = source.slice(terminalStart, terminalEnd)

  // The transcript refresh may lag on Windows. A received terminal event must
  // still make the composer available immediately instead of queueing a normal
  // follow-up message behind a completed turn.
  const finalStart = terminalSource.indexOf("if (state === 'final') {")
  const finalEnd = terminalSource.indexOf('} else {', finalStart)
  const finalSource = terminalSource.slice(finalStart, finalEnd)
  assert.equal(finalSource.includes('clearConversationPendingGatewayRun(item.id)'), true)
})

test('a locally requested matching terminal event is not rendered as a send failure', () => {
  const source = read('src/pages/Conversations.jsx')
  const abortStart = source.indexOf('async function handleStopConversation()')
  const abortCall = source.indexOf('await abortConversationTurn({', abortStart)
  const eventStart = source.indexOf("if (state === 'final' || state === 'error' || state === 'aborted')")
  const eventEnd = source.indexOf("if (state.startsWith('tool_'))", eventStart)
  const terminalSource = source.slice(eventStart, eventEnd)

  assert.equal(source.includes('const userCancelledGatewayRunRef = useRef(null)'), true)
  assert.ok(source.indexOf('userCancelledGatewayRunRef.current = {', abortStart) < abortCall)
  assert.equal(source.includes("const isUserCancelledTerminal = (state === 'error' || state === 'aborted')\n        && cancelledRun?.sessionKey === sessionKey"), true)
  assert.ok(
    source.indexOf('if (isUserCancelledTerminal) userCancelledGatewayRunRef.current = null', eventStart - 800)
      < source.indexOf('setConversations(prev => prev.map(item => {', eventStart - 800),
  )
  assert.equal(terminalSource.includes("if (!isUserCancelledTerminal && (state === 'error' || state === 'aborted'))"), true)
})

test('conversation list offers copy, failed resend and a smooth back-to-bottom control', () => {
  const source = read('src/pages/Conversations.jsx')
  const scroll = read('src/lib/conversationScroll.js')

  assert.equal(source.includes('copyConversationMessage'), true)
  assert.equal(source.includes('navigator.clipboard.writeText'), true)
  assert.equal(source.includes('editResendFailedMessage'), true)
  assert.equal(source.includes('编辑重发'), true)
  // Copy is now an icon button (copy glyph → check glyph when copied); the copied
  // state is conveyed via aria-label rather than the old "已复制 ✓" text.
  assert.equal(source.includes("aria-label={copiedMessageId === String(message.id || '') ? '已复制' : '复制消息'}"), true)
  assert.equal(source.includes('smoothScrollConversationToBottom(listRef.current)'), true)
  assert.equal(source.includes('回到底部'), true)
  assert.equal(scroll.includes('export function easeOutQuart'), true)
  assert.equal(scroll.includes('export function smoothScrollConversationToBottom'), true)
  assert.equal(scroll.includes("element.addEventListener('wheel', cancel, { passive: true })"), true)
})

test('conversation gateway reasoning events update a retained collapsible thinking panel', () => {
  const source = read('src/pages/Conversations.jsx')
  const listenerStart = workspaceGatewayListenerStart(source)
  const listenerEnd = source.indexOf('}).then(unlisten =>', listenerStart)
  const listenerSource = source.slice(listenerStart, listenerEnd)

  assert.equal(source.includes('const [reasoningPanelByConversation, setReasoningPanelByConversation] = useState({})'), true)
  assert.equal(source.includes('ConversationReasoningPanel'), true)
  assert.equal(listenerSource.includes('const isReasoning = Boolean(payload.isReasoning)'), true)
  assert.equal(listenerSource.includes('const reasoningContent = typeof payload.reasoningContent ==='), true)
  assert.equal(listenerSource.includes('updateConversationReasoningPanel(item.id'), true)
  assert.equal(listenerSource.includes('finishConversationReasoningPanel(item.id)'), true)
  assert.equal(listenerSource.includes("state === 'final'"), true)
})

test('conversation gateway tool stream renders a live collapsible tool timeline', () => {
  const source = read('src/pages/Conversations.jsx')
  const stream = read('src-tauri/src/services/openclaw_gateway_stream.rs')

  // Rust: the official agent tool stream is mapped instead of dropped.
  assert.equal(stream.includes('if stream == "tool"'), true)
  assert.equal(stream.includes('fn map_gateway_tool_stream'), true)
  assert.equal(stream.includes('"tool_started"'), true)
  assert.equal(stream.includes('"tool_result"'), true)
  assert.equal(stream.includes('"tool_error"'), true)
  assert.equal(stream.includes('pub tool_name: Option<String>'), true)
  assert.equal(stream.includes('pub tool_call_id: Option<String>'), true)

  // JS: tool events feed an Accio-style process strip with live timer.
  assert.equal(source.includes("state.startsWith('tool_')"), true)
  assert.equal(source.includes('updateConversationToolTimeline(item.id'), true)
  assert.equal(source.includes('finishConversationToolTimeline(item.id'), true)
  assert.equal(source.includes('resetConversationToolTimeline(activeConversationId)'), true)
  assert.equal(source.includes('function ConversationProcessTimeline'), true)
  assert.equal(source.includes('已处理'), true)
  assert.equal(source.includes('处理中...'), true)
  assert.equal(source.includes('setConversationToolTimelineExpanded'), true)
})

test('conversation history refresh is not blocked by local optimistic message count', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('currentMessages.length > mergedMessages.length'), false)
})

test('conversation keeps the active turn user message outside mutable session history', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('const [activeOptimisticUserMessage, setActiveOptimisticUserMessage] = useState(null)'), true)
  assert.equal(source.includes('const activeOptimisticMessages = activeOptimisticUserMessage?.conversationId === activeConversationId'), true)
  assert.equal(source.includes('setActiveOptimisticUserMessage(userMessage)'), true)
  assert.equal(source.includes('removeConfirmedConversationOptimisticMessages([current], history.messages)'), false)
})

test('session picker refresh forces gateway session reload', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('onRefresh={() => refreshConversationSessions({ silent: false })}'), true)
})

test('a run whose final frame never arrives is settled by asking the engine, not by guessing', () => {
  const source = read('src/pages/Conversations.jsx')
  const history = read('src-tauri/src/commands/conversations/mod.rs')
  const client = read('src/lib/conversations/client.js')

  // Rust surfaces the engine's own turn state from chat.history.
  assert.equal(history.includes('pub has_active_run: Option<bool>'), true)
  assert.equal(history.includes('pub in_flight_run_id: Option<String>'), true)
  assert.equal(history.includes('"hasActiveRun"'), true)
  assert.equal(history.includes('"inFlightRun"'), true)
  assert.equal(client.includes('hasActiveRun:'), true)
  assert.equal(client.includes('inFlightRunId:'), true)

  // JS probes on silence and only clears the spinner when the engine says idle.
  assert.equal(source.includes('const reconcileGatewayRunState = useCallback'), true)
  assert.equal(source.includes('LOST_RUN_SILENCE_MS'), true)
  assert.equal(source.includes('gatewayActivityAtRef.current[sessionKey] = Date.now()'), true)
  assert.equal(source.includes("meta.hasActiveRun === true || meta.inFlightRunId"), true)
  // An unreachable gateway must never be read as "the run finished".
  assert.equal(source.includes('history = await loadConversationHistory(sessionKey, profile, { includeSessionMeta: false })'), true)
})

test('a post-turn transcript refresh does not re-subscribe or re-read session metadata', () => {
  const source = read('src/pages/Conversations.jsx')
  const history = read('src-tauri/src/commands/conversations/history.rs')
  const impl = read('src-tauri/src/commands/conversations/mod.rs')

  assert.equal(history.includes('include_session_meta: Option<bool>'), true)
  assert.equal(impl.includes('let sessions_value = if include_session_meta {'), true)

  assert.equal(source.includes('const isSessionSwitch = subscribedSessionRef.current !== subscribedKey'), true)
  // A failed subscribe must not be remembered as done — this path only gets one
  // attempt per switch, unlike the old subscribe-on-every-refresh behaviour.
  assert.equal(source.includes('subscribedSessionRef.current = subscribedKey\n        })'), true)
  assert.equal(source.includes("subscribedSessionRef.current = ''\n        })"), true)
  assert.equal(source.includes('includeSessionMeta: isSessionSwitch'), true)
  // Model override must only be applied from metadata we actually requested.
  assert.equal(source.includes('setSelectedModelOverride(sessionModelRefFromMeta(history.meta))'), true)
  const effectStart = source.indexOf('const subscribedKey = `${historyProfile}::${activeConversationSessionKey}`')
  const applyIndex = source.indexOf('setSelectedModelOverride(sessionModelRefFromMeta(history.meta))', effectStart)
  const guardIndex = source.indexOf('if (isSessionSwitch) {', applyIndex - 200)
  assert.notEqual(effectStart, -1)
  assert.ok(guardIndex !== -1 && guardIndex < applyIndex)
})

test('a failed session-level subscribe is reported instead of silently losing tool events', () => {
  const source = read('src/pages/Conversations.jsx')
  const stream = read('src-tauri/src/services/openclaw_gateway_stream.rs')

  assert.equal(stream.includes('fn session_subscribe_ack_reporter'), true)
  assert.equal(stream.includes('"subscribe_degraded"'), true)
  // The ack must be tracked; the old fire-and-forget dropped it on the floor.
  assert.equal(stream.includes('session_subscribe_ack_reporter(app.clone(), session_key.clone())'), true)
  assert.equal(source.includes("state === 'subscribe_degraded'"), true)
})

test('a full history page does not make older cached messages look deleted', () => {
  const source = read('src/pages/Conversations.jsx')
  const impl = read('src-tauri/src/commands/conversations/mod.rs')
  const client = read('src/lib/conversations/client.js')
  const store = read('src/lib/conversationStore.js')

  // chat.history has no offset, so a full page is the only truncation signal.
  assert.equal(impl.includes('const CONVERSATION_HISTORY_LIMIT: u64 = 120;'), true)
  assert.equal(impl.includes('let messages_truncated = history.len() as u64 >= CONVERSATION_HISTORY_LIMIT;'), true)
  assert.equal(client.includes('truncated: Boolean(res.messagesTruncated)'), true)
  assert.equal(client.includes('res.messages_truncated'), false)
  assert.equal(source.includes('historyTruncated: Boolean(history.meta?.truncated)'), true)
  assert.equal(store.includes('if (historyTruncated && history.length > 0) {'), true)
})

test('the message identity key is threaded from the gateway to the merge', () => {
  const impl = read('src-tauri/src/commands/conversations/mod.rs')
  const client = read('src/lib/conversations/client.js')
  const store = read('src/lib/conversationStore.js')
  const source = read('src/pages/Conversations.jsx')

  assert.equal(impl.includes('pub idempotency_key: Option<String>'), true)
  assert.equal(impl.includes('fn gateway_history_message_idempotency_key'), true)
  assert.equal(client.includes('idempotencyKey: message.idempotencyKey'), true)
  assert.equal(client.includes('message.idempotency_key'), false)
  // The optimistic bubble carries the same value we send as idempotencyKey.
  assert.equal(source.includes('idempotencyKey: turnId,'), true)
  // Exact key match must beat the content+timestamp guess.
  assert.equal(store.includes('function idempotencyVerdict(left, right)'), true)
  assert.equal(store.includes('if (byKey !== null) return byKey'), true)
})
