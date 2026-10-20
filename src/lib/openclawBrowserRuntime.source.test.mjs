import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { browserDockKeyboardTransition } from './browserDockKeyboard.js'
import { browserDockAgentTargetCandidate, createBrowserDockActionQueue, resolveBrowserDockTab, selectBrowserDockTab } from './browserDockSession.js'
import { mapBrowserDockPointer } from './browserDockPointer.js'

const repoRoot = path.resolve(import.meta.dirname, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('operations owns the official Uniopc 引擎 browser runtime management surface', () => {
  const operations = read('src/pages/Operations.jsx')
  const modelSettings = read('src/pages/ModelSettings.jsx')
  const libRs = read('src-tauri/src/lib.rs')

  assert.equal(operations.includes('浏览器控制'), true)
  assert.equal(operations.includes("invoke('openclaw_browser_runtime_snapshot'"), true)
  assert.equal(operations.includes("invoke('openclaw_browser_runtime_set_enabled'"), true)
  assert.equal(operations.includes("invoke('openclaw_browser_action'"), true)
  assert.equal(operations.includes('浏览器位置'), true)
  assert.equal(operations.includes('远程 Host'), true)
  assert.equal(operations.includes('scope upgrade'), true)
  assert.equal(operations.includes('browser_tool_policy_missing'), true)
  assert.equal(operations.includes('gateway_browser_rpc_unsupported'), true)
  assert.equal(operations.includes('修复并开启'), true)
  assert.equal(operations.includes('高级诊断'), true)
  assert.equal(operations.includes('Needs browser policy repair'), false)
  assert.equal(operations.includes('Next:'), false)
  assert.equal(operations.includes('Gateway Pairing'), false)
  assert.equal(operations.includes('读取 Pairing 状态'), false)
  assert.equal(operations.includes('批准最新 Pairing'), false)
  assert.equal(modelSettings.includes('托管浏览器'), false)
  assert.equal(libRs.includes('commands::openclaw_browser::openclaw_browser_runtime_snapshot'), true)
  assert.equal(libRs.includes('commands::openclaw_browser::openclaw_browser_action'), true)
  assert.equal(libRs.includes('commands::native_browser::native_browser_open'), true)
  assert.equal(libRs.includes('commands::native_browser::native_browser_action'), true)
})

test('conversation dock mirrors and controls the workspace OpenClaw browser session', () => {
  const conversations = read('src/pages/Conversations.jsx')
  const browser = read('src-tauri/src/services/openclaw_browser.rs')
  const commands = read('src-tauri/src/commands/openclaw_browser.rs')
  const libRs = read('src-tauri/src/lib.rs')

  assert.equal(conversations.includes("invoke('native_browser_open'"), false)
  assert.equal(conversations.includes("invoke('openclaw_browser_dock_snapshot'"), true)
  assert.equal(conversations.includes("invoke('openclaw_browser_dock_action'"), true)
  assert.equal(conversations.includes('与 AI 共享的工作区浏览器'), true)
  assert.equal(conversations.includes("mode === 'browser' ? '浏览器'"), true)
  assert.equal(conversations.includes('browserTargetByProfile[activeProfile]'), true)
  assert.equal(conversations.includes('selectedBrowserTargetId={browserTargetByProfile[activeProfile]'), true)
  assert.equal(conversations.includes('你和 AI 在同一页面操作'), true)
  assert.equal(conversations.includes('data-testid="browser-dock-viewport"'), true)
  assert.equal(conversations.includes('data-testid="browser-dock-image"'), true)
  assert.equal(conversations.includes('data-testid="browser-dock-address"'), true)
  assert.equal(conversations.includes('onCompositionStart='), true)
  assert.equal(conversations.includes('onCompositionUpdate='), true)
  assert.equal(conversations.includes('onCompositionEnd='), true)
  assert.equal(conversations.includes('浏览器网页键盘输入'), true)
  assert.equal(browser.includes('Page.captureScreenshot'), true)
  assert.equal(browser.includes('Page.startScreencast'), true)
  assert.equal(browser.includes('Page.enable'), true)
  assert.equal(browser.includes('everyNthFrame":1'), true)
  assert.equal(browser.includes('Page.frameStoppedLoading'), true)
  assert.equal(browser.includes('awaiting_fresh_capture'), true)
  assert.equal(browser.includes('Page.screencastFrameAck'), true)
  assert.equal(browser.includes('Input.dispatchMouseEvent'), true)
  assert.equal(browser.includes('Input.insertText'), true)
  assert.equal(browser.includes('当前工作区的 Browser Runtime'), true)
  assert.equal(browser.includes('右侧实时浏览器目前仅支持本机托管'), true)
  assert.equal(commands.includes('openclaw_browser_dock_action'), true)
  assert.equal(libRs.includes('commands::openclaw_browser::openclaw_browser_dock_action'), true)
})

test('browser runtime enable aligns config with official browser tool policy', () => {
  const service = read('src-tauri/src/services/openclaw_browser.rs')
  const command = read('src-tauri/src/commands/openclaw_browser.rs')
  const conversationsCommand = read('src-tauri/src/commands/conversations/mod.rs')
  const conversationsPairingCommand = read('src-tauri/src/commands/conversations/pairing.rs')

  assert.equal(service.includes('browser_runtime_config_patch'), true)
  assert.equal(service.includes('"alsoAllow"'), true)
  assert.equal(service.includes('BROWSER_TOOL_ID'), true)
  assert.equal(service.includes('openclaw_gateway::config_patch'), true)
  assert.equal(command.includes('AppHandle'), true)
  // Pure sidecar: respawn the app-owned gateway child instead of restarting a
  // system service.
  assert.equal(command.includes('model::GatewaySupervisor>()'), true)
  assert.equal(command.includes('.restart()'), true)
  assert.equal(conversationsPairingCommand.includes('openclaw_profile_approve_latest_pairing('), true)
  assert.equal(conversationsCommand.includes('["devices", "approve", "--latest", "--json"]'), true)
  assert.equal(conversationsCommand.includes('parse_json_object_from_mixed_output'), true)
})

test('browser dock sends one final CJK composition string and suppresses intermediate IME keys', () => {
  let composing = { composing: false, suppressNextCommitKey: false }
  const actions = []
  for (const event of [
    { type: 'compositionstart' },
    { type: 'keydown', key: 'Process', isComposing: true },
    { type: 'compositionupdate', data: 'zhong' },
    { type: 'keydown', key: 'Enter', isComposing: true },
    { type: 'compositionend', data: '中文' },
  ]) {
    const result = browserDockKeyboardTransition(composing, event)
    composing = { composing: result.composing, suppressNextCommitKey: result.suppressNextCommitKey }
    if (result.action) actions.push(result.action)
  }
  assert.deepEqual(actions, [{ type: 'text', text: '中文' }])
  assert.equal(composing.composing, false)
})

test('browser dock still forwards ordinary text and special keys outside IME composition', () => {
  const ordinary = browserDockKeyboardTransition(false, { type: 'keydown', key: 'a' })
  const enter = browserDockKeyboardTransition(false, { type: 'keydown', key: 'Enter' })
  const composing = browserDockKeyboardTransition({ composing: true, suppressNextCommitKey: false }, { type: 'keydown', key: 'a', isComposing: true })
  assert.deepEqual(ordinary.action, { type: 'text', text: 'a' })
  assert.deepEqual(enter.action, { type: 'key', key: 'Enter' })
  assert.equal(composing.action, null)
  assert.equal(composing.composing, true)
})

test('browser dock suppresses WKWebView commit Enter after compositionend but forwards a later Enter', () => {
  let state = { composing: false, suppressNextCommitKey: false }
  const actions = []
  let result = browserDockKeyboardTransition(state, { type: 'compositionstart' })
  state = { composing: result.composing, suppressNextCommitKey: result.suppressNextCommitKey }
  result = browserDockKeyboardTransition(state, { type: 'compositionend', data: '搜索词' })
  state = { composing: result.composing, suppressNextCommitKey: result.suppressNextCommitKey }
  actions.push(result.action)
  assert.equal(state.suppressNextCommitKey, true)

  result = browserDockKeyboardTransition(state, { type: 'keydown', key: 'Enter', keyCode: 13 })
  state = { composing: result.composing, suppressNextCommitKey: result.suppressNextCommitKey }
  assert.equal(result.action, null)
  assert.equal(result.suppressKey, true)

  result = browserDockKeyboardTransition(state, { type: 'keydown', key: 'Enter', keyCode: 13 })
  assert.deepEqual(result.action, { type: 'key', key: 'Enter' })
  assert.deepEqual(actions, [{ type: 'text', text: '搜索词' }])
})

test('browser dock expires the post-composition commit marker before later intentional Enter', () => {
  const ended = browserDockKeyboardTransition({ composing: true, suppressNextCommitKey: false }, { type: 'compositionend', data: '中文' })
  const expired = browserDockKeyboardTransition(ended, { type: 'commit-window-expired' })
  const laterEnter = browserDockKeyboardTransition(expired, { type: 'keydown', key: 'Enter', keyCode: 13 })
  assert.equal(expired.suppressNextCommitKey, false)
  assert.deepEqual(laterEnter.action, { type: 'key', key: 'Enter' })
})

test('browser dock uses current screencast metadata for the paired image', () => {
  const browser = read('src-tauri/src/services/openclaw_browser.rs')
  assert.ok(browser.indexOf('"method":"Page.enable"') < browser.indexOf('"method":"Page.startScreencast"'))
  assert.ok(browser.indexOf('pending_metadata.insert(metadata_id, image)') < browser.indexOf('let metadata_request'))
  assert.match(browser, /if let Some\(\(epoch, image\)\) = pending_metadata\.remove\(&id\)[\s\S]*?epoch == navigation_epoch[\s\S]*?app\.emit_to/)
})

test('browser dock follows only explicit targets from the active local browser tool', () => {
  const tabs = [{ id: 'target-a', type: 'page' }, { targetId: 'target-b', type: 'page' }]
  assert.equal(selectBrowserDockTab(tabs, 'target-b').targetId, 'target-b')
  assert.equal(resolveBrowserDockTab(tabs, 'target-a'), 'target-a')
  const event = { sessionKey: 'active', toolName: 'browser', state: 'tool_result', toolResultPreview: '{"targetId":"target-b"}' }
  assert.equal(browserDockAgentTargetCandidate(event, 'active', true), 'target-b')
  assert.equal(browserDockAgentTargetCandidate({ ...event, sessionKey: 'other' }, 'active', true), null)
  assert.equal(browserDockAgentTargetCandidate({ ...event, toolName: 'shell' }, 'active', true), null)
  assert.equal(browserDockAgentTargetCandidate(event, 'active', false), null)
  assert.equal(browserDockAgentTargetCandidate({ ...event, toolArgs: '{"profile":"chrome","targetId":"target-b"}' }, 'active', true), null)
  assert.equal(browserDockAgentTargetCandidate({ ...event, toolArgs: '{"target":"node","targetId":"target-b"}' }, 'active', true), null)
  assert.equal(browserDockAgentTargetCandidate({ ...event, toolName: 'browser_request' }, 'active', true), null)
  assert.equal(browserDockAgentTargetCandidate({ ...event, toolResultPreview: '[{"targetId":"a"},{"targetId":"b"}]' }, 'active', true), null)
})

test('browser dock serializes input actions and continues after a failed action', async () => {
  const enqueue = createBrowserDockActionQueue()
  const order = []
  const first = enqueue(async () => { await new Promise(resolve => setTimeout(resolve, 5)); order.push('first') })
  const failed = enqueue(async () => { order.push('failed'); throw new Error('expected') })
  const last = enqueue(async () => { order.push('last') })
  await Promise.all([first, failed.catch(() => null), last])
  assert.deepEqual(order, ['first', 'failed', 'last'])
})

test('browser dock accepts native insertText input and suppresses IME duplicate input', () => {
  const typed = browserDockKeyboardTransition(false, { type: 'input', inputType: 'insertText', data: 'hello', value: 'hello' })
  assert.deepEqual(typed.action, { type: 'text', text: 'hello' })
  const nativeTyped = browserDockKeyboardTransition(false, { type: 'input', inputType: '', data: '测试abc', value: '测试abc' })
  assert.deepEqual(nativeTyped.action, { type: 'text', text: '测试abc' })
  const ended = browserDockKeyboardTransition({ composing: true }, { type: 'compositionend', data: '中文' })
  const duplicate = browserDockKeyboardTransition(ended, { type: 'input', inputType: 'insertText', data: '中文', value: '中文' })
  assert.equal(duplicate.action, null)
})

test('browser dock forwards Meta+A as a modified key instead of inserting a literal a', () => {
  const modifier = browserDockKeyboardTransition(false, { type: 'keydown', key: 'Meta', metaKey: true })
  const selectAll = browserDockKeyboardTransition(false, { type: 'keydown', key: 'a', metaKey: true })
  assert.equal(modifier.action, null)
  assert.deepEqual(selectAll.action, { type: 'key', key: 'a', modifiers: 4 })
})

test('browser dock preserves aspect ratio and maps pointers into image content only', () => {
  // A 16:9 image centered in a taller viewport has 50px letterbox bars above
  // and below; clicks in those bars must not reach the browser page.
  const portraitViewport = { left: 10, top: 20, width: 320, height: 280 }
  assert.equal(mapBrowserDockPointer(160, 40, portraitViewport, 1600, 900), null)
  assert.deepEqual(mapBrowserDockPointer(10, 160, portraitViewport, 1600, 900), { x: 0, y: 0.5 })
  assert.deepEqual(mapBrowserDockPointer(330, 250, portraitViewport, 1600, 900), { x: 1, y: 1 })

  // A portrait image in a wide viewport gets side bars.
  const wideViewport = { left: 0, top: 0, width: 400, height: 300 }
  assert.equal(mapBrowserDockPointer(40, 150, wideViewport, 600, 900), null)
  assert.deepEqual(mapBrowserDockPointer(200, 150, wideViewport, 600, 900), { x: 0.5, y: 0.5 })
  assert.equal(mapBrowserDockPointer(0, 0, wideViewport, 0, 900), null)
})


test('browser dock follows the native target when an official open result also contains its tab alias', () => {
  const tabs = [{ targetId: 'native-a', tabId: 't1' }, { targetId: 'native-b', tabId: 't2' }]
  const payload = { toolName: 'browser', state: 'tool_result', sessionKey: 'local-session', toolArgs: { action: 'open', target: 'host' } }
  const result = { targetId: 'native-b', tabId: 't2', suggestedTargetId: 't2', ownership: { nativeTargetId: 'native-b', status: 'durable' } }
  for (const preview of [result, JSON.stringify(result), `Browser result: ${JSON.stringify(result)}`]) {
    const candidate = browserDockAgentTargetCandidate({ ...payload, toolResultPreview: preview }, 'local-session', true)
    assert.equal(candidate, 'native-b')
    assert.equal(resolveBrowserDockTab(tabs, candidate), 'native-b')
  }
  assert.equal(browserDockAgentTargetCandidate({ ...payload, toolResultPreview: { tabId: 't2' } }, 'local-session', true), 't2')
  assert.equal(browserDockAgentTargetCandidate({ ...payload, toolResultPreview: tabs }, 'local-session', true), null)
})
