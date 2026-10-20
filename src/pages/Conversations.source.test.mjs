import assert from 'node:assert/strict'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const traverse = traverseModule.default ?? traverseModule

const RENDER_GLOBALS = new Set([
  'Array',
  'Boolean',
  'Date',
  'Error',
  'File',
  'FileReader',
  'Intl',
  'JSON',
  'Map',
  'Math',
  'Number',
  'Object',
  'Promise',
  'RegExp',
  'Set',
  'String',
  'URL',
  'cancelAnimationFrame',
  'clearInterval',
  'clearTimeout',
  'console',
  'crypto',
  'document',
  'globalThis',
  'localStorage',
  'location',
  'navigator',
  'requestAnimationFrame',
  'sessionStorage',
  'setInterval',
  'setTimeout',
  'window',
])

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function undeclaredRenderIdentifiers(source) {
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] })
  const unresolved = []

  traverse(ast, {
    ReferencedIdentifier(identifierPath) {
      const insideRenderTree = identifierPath.findParent(parent =>
        parent.isJSXElement?.() || parent.isJSXFragment?.(),
      )
      if (!insideRenderTree) return

      const name = identifierPath.node.name
      if (!identifierPath.scope.hasBinding(name) && !RENDER_GLOBALS.has(name)) {
        unresolved.push(`${name}:${identifierPath.node.loc.start.line}`)
      }
    },
  })

  return unresolved.sort()
}

test('conversation render expressions do not reference undeclared variables', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.deepEqual(undeclaredRenderIdentifiers(source), [])
})

test('conversation defers employee settings behind a secondary panel boundary', () => {
  const source = read('src/pages/Conversations.jsx')
  const panel = read('src/pages/conversations/InlineEmployeeSettingsPanel.jsx')

  assert.match(source, /lazyPage\(\(\) => import\('\.\/conversations\/InlineEmployeeSettingsPanel'\)\)/)
  assert.equal(source.includes('function InlineEmployeeSettingsPanel('), false)
  assert.equal(source.includes('onClose={() => setRightPaneMode(\'chat\')}'), true)
  assert.deepEqual(undeclaredRenderIdentifiers(panel), [])
})

test('deferred employee settings preserve loading, permission, optimistic update and rollback behavior', () => {
  const panel = read('src/pages/conversations/InlineEmployeeSettingsPanel.jsx')
  const loadStart = panel.indexOf('async function loadInlineSkillhubSnapshot()')
  const toggleStart = panel.indexOf('async function toggleInlineSkill(skillName)')
  const loadSource = panel.slice(loadStart, toggleStart)
  const toggleEnd = panel.indexOf('\n  useEffect(() => {', toggleStart)
  const toggleSource = panel.slice(toggleStart, toggleEnd)
  const effectEnd = panel.indexOf('\n\n  if (!employee)', toggleEnd)
  const effectSource = panel.slice(toggleEnd, effectEnd)
  const optimisticUpdate = toggleSource.indexOf('setSkillAgents(prev => {')
  const saveRequest = toggleSource.indexOf('engineClient.agents.setSkills({')

  assert.notEqual(loadStart, -1)
  assert.notEqual(toggleStart, -1)
  assert.notEqual(toggleEnd, -1)
  assert.notEqual(effectEnd, -1)
  assert.equal(loadSource.includes('engineClient.agents.skillhubSnapshot({ profile: activeProfile })'), true)
  assert.equal(loadSource.includes("invoke('openclaw_skillhub_snapshot'"), false)
  assert.equal(loadSource.includes('setSkillsLoading(true)'), true)
  assert.equal(loadSource.includes('setSkillsLoading(false)'), true)
  assert.equal(toggleSource.includes('if (!canManageSkillAssignments)'), true)
  assert.equal(toggleSource.includes('setSkillPresence(selectedSkillNames, skillName, !hasSkill)'), true)
  assert.notEqual(optimisticUpdate, -1)
  assert.notEqual(saveRequest, -1)
  assert.equal(toggleSource.includes("invoke('openclaw_agent_skills_set'"), false)
  assert.ok(optimisticUpdate < saveRequest)
  assert.equal(toggleSource.includes('onSkillsChanged?.()'), true)
  assert.equal(toggleSource.includes('setSkillAgents(previousAgents)'), true)
  assert.equal(toggleSource.includes('await loadInlineSkillhubSnapshot()'), true)
  assert.equal(toggleSource.includes("setSavingSkillName('')"), true)
  assert.equal(effectSource.includes("if (tab !== 'skills') return"), true)
  assert.equal(effectSource.includes('loadInlineSkillhubSnapshot()'), true)
  assert.equal(panel.includes('onClick={onClose}'), true)
})

test('conversation delegates notice and error presentation without moving workspace ownership', () => {
  const source = read('src/pages/Conversations.jsx')
  const bannerPath = path.join(repoRoot, 'src/pages/conversations/ConversationStatusBanner.jsx')
  const banner = fs.existsSync(bannerPath) ? fs.readFileSync(bannerPath, 'utf8') : ''

  assert.equal(source.includes("import ConversationStatusBanner from './conversations/ConversationStatusBanner'"), true)
  assert.equal(source.includes('<ConversationStatusBanner'), true)
  assert.equal(banner.includes('onRetryQueuedMessage'), true)
  assert.equal(banner.includes('queuedMessageId'), true)
  assert.equal(banner.includes('onClick={() => onRetryQueuedMessage(queuedMessageId)}'), true)
  assert.equal(banner.includes('void onRetryQueuedMessage'), false)
  assert.equal(banner.includes('onNavigateRecovery'), true)
  assert.equal(banner.includes('setInput('), false)
  assert.equal(banner.includes('setActiveConversation'), false)
})

test('host conversations keep chat separate from removed remote connection management', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('shouldDeferOpenClawDirectoryHydration'), true)
  assert.equal(source.includes('请先完成本机 Uniopc 引擎 Host 初始化，再开始对话。'), true)
  assert.equal(source.includes('shouldUseMemberGatewayAssignment(activeOpenClaw.workspaceProfile, memberClient.bootstrap, { appMode })'), false)
  assert.equal(source.includes('memberRemotePairingSetupFromBootstrap'), false)
  assert.equal(source.includes('discoverRemoteProfileSetup'), false)
  assert.equal(source.includes('memberRemoteConnectionSummary'), false)
  assert.equal(source.includes('发现 Owner 授权的 Uniopc 引擎 Profile'), false)
  assert.equal(source.includes('Owner 连接 ·'), false)
  assert.equal(source.includes('绑定本机'), false)
})

test('conversation surfaces benign tool/file step failures without an engine-recovery alarm', () => {
  const source = read('src/pages/Conversations.jsx')
  const banner = read('src/pages/conversations/ConversationStatusBanner.jsx')

  // A single failed tool/file step (e.g. `show …/plugin.json` failed) must be classified
  // as non-fatal, shown calmly, and must NOT offer the "去检查引擎" recovery CTA.
  assert.equal(source.includes('function isNonFatalToolStepError'), true)
  assert.equal(source.includes('const toolStepError = !rateLimitError && !nativeVoiceError && isNonFatalToolStepError(error)'), true)
  assert.equal(source.includes('有一个步骤没能完成'), true)
  assert.equal(source.includes('showRecovery: !toolStepError'), true)
  assert.equal(banner.includes('{error.showRecovery && ('), true)
  // Genuine engine failures still keep the recovery CTA — the classifier excludes them.
  assert.equal(source.includes("normalized.includes('gateway')"), true)
})

test('conversation messages constrain long text inside the chat column', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('overflow-y-auto overflow-x-hidden'), true)
  assert.equal(source.includes('className={`flex min-w-0 gap-3'), true)
  // The hover `group` sits on the inner content column so copy affordances only
  // reveal when hovering the message content, not the full-width row band.
  assert.equal(source.includes('className={`group min-w-0 max-w-[calc(100%-88px)]'), true)
  assert.equal(source.includes('[overflow-wrap:anywhere] [word-break:break-word]'), true)
  // 用户气泡从硬编码浅青（只在浅色下成立、且与品牌紫打架）改为品牌色调、
  // 主题感知的 token。全仓 cyan 已归零。
  assert.equal(source.includes('border border-brand/25 bg-state-selected text-primary'), true)
  assert.equal(/cyan-/.test(source), false)
  assert.equal(source.includes('const currentUserAvatarUrl = accountAvatarUrl({ user, profile })'), true)
  // 当前用户是人，头像走圆形（kind="human"）—— 形状即类别，人圆 AI 方。
  assert.equal(source.includes('<EmployeeAvatar name={currentUserDisplayName} avatarUrl={currentUserAvatarUrl} size="md" kind="human" />'), true)
})

test('conversation input exposes user-friendly Uniopc 引擎 execution modes', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('CONVERSATION_APPROVAL_MODES'), true)
  assert.equal(source.includes('默认权限'), true)
  assert.equal(source.includes('完全访问权限'), true)
  assert.equal(source.includes('清除会话覆盖，跟随当前员工与 Gateway 的默认策略'), true)
  assert.equal(source.includes('permissionMode: workspace'), true)
  assert.equal(source.includes('permissionMode: full'), true)
  assert.equal(source.includes('execSecurity=full / execAsk=off'), false)
  assert.equal(source.includes('有风险再问'), false)
  assert.equal(source.includes('执行前问我'), false)
})

test('conversation uses explicit session controls without replaying queued permission snapshots', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('approvalMode: fromQueue?.approvalMode || approvalMode'), false)
  assert.equal(source.includes('approvalMode: confirmedApprovalMode,\n      })'), false)
  assert.equal(source.includes('modelOverride: selectedModelOverride || null'), false)
  assert.equal(source.includes('chooseConversationModel'), true)
  assert.equal(source.includes('setConversationSessionModel'), true)
  assert.equal(source.includes('setApprovalMenuOpen'), true)
  assert.equal(source.includes('setModelMenuOpen'), true)
})

test('conversation document mentions load local summaries and preserve structured ids when sent', () => {
  const source = read('src/pages/Conversations.jsx')
  const sendStart = source.indexOf('const res = await sendConversationTurn')
  const sendEnd = source.indexOf('})', sendStart)
  const sendSource = source.slice(sendStart, sendEnd)

  assert.match(source, /from ['"]\.\.\/lib\/localDocuments['"]/)
  assert.match(source, /listLocalDocuments\('', \{ profile: activeProfile \}\)/)
  assert.equal(source.includes('getLocalDocument'), false)
  assert.equal(source.includes('listCloudDocuments'), false)
  assert.match(source, /const explicitMentions = enrichConversationMentions\(/)
  assert.match(source, /const mentions = \[\s*\.\.\.explicitMentions,/)
  assert.match(sendSource, /mentions,/)
})

test('conversation footer keeps the model control while a turn is in flight', () => {
  const source = read('src/pages/Conversations.jsx')
  const footerStart = source.indexOf('<div className="flex h-11 items-center justify-between')
  const footerEnd = source.indexOf('</div>\n            </form>', footerStart)
  const footerSource = source.slice(footerStart, footerEnd)
  const turnInFlightStart = footerSource.indexOf('{turnInFlight ? (')
  const modelButtonStart = footerSource.indexOf('setModelMenuOpen(open => !open)')

  assert.equal(turnInFlightStart >= 0, true)
  assert.equal(modelButtonStart >= 0, true)
  assert.equal(modelButtonStart < turnInFlightStart, true)
  // Thinking is an employee-level setting now — no per-message picker.
  assert.equal(footerSource.includes('setThinkingMenuOpen'), false)
})

test('Escape delegates an active employee turn to the shared stop handler', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('async function handleStopConversation()'), true)
  assert.equal(source.includes("document.addEventListener('keydown', handleConversationEscape)"), true)
  assert.equal(source.includes("document.removeEventListener('keydown', handleConversationEscape)"), true)
  assert.equal(source.includes("if (event.key !== 'Escape') return"), true)
  assert.equal(source.includes('imeCompositionRef.current || event.isComposing || event.keyCode === 229'), true)
  assert.equal(source.includes("document.querySelector('.ui-modal')"), true)
  assert.equal(source.includes('handleStopConversation()'), true)
})

test('conversation dropdown menus close on outside pointer interaction', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('const composerRef = useRef(null)'), true)
  assert.equal(source.includes('const sessionPickerRef = useRef(null)'), true)
  assert.equal(source.includes("document.addEventListener('mousedown', closeConversationMenusOnOutsidePointer)"), true)
  assert.equal(source.includes("document.addEventListener('touchstart', closeConversationMenusOnOutsidePointer)"), true)
  assert.equal(source.includes('if (composerRef.current?.contains(event.target)) return'), true)
  assert.equal(source.includes('if (sessionPickerRef.current?.contains(event.target)) return'), true)
  assert.equal(source.includes('setApprovalMenuOpen(false)'), true)
  assert.equal(source.includes('setModelMenuOpen(false)'), true)
  assert.equal(source.includes('setSessionPickerOpen(false)'), true)
})

test('conversation input does not repeat the selected chat target in the footer', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('正在和 '), false)
})

test('conversation assistant replies render markdown with streaming tail repair', () => {
  const source = read('src/pages/Conversations.jsx')
  const cssSource = read('src/index.css')

  assert.equal(source.includes("import ReactMarkdown from 'react-markdown'"), true)
  assert.equal(source.includes("import remarkGfm from 'remark-gfm'"), true)
  assert.equal(source.includes('repairStreamingMarkdownTail'), true)
  assert.equal(source.includes('splitConversationMediaSegments'), true)
  assert.equal(source.includes('CONVERSATION_MARKDOWN_COMPONENTS'), true)
  assert.equal(source.includes('conversation-markdown'), true)
  assert.equal(source.includes('conversation-streaming-cursor'), true)
  // User input keeps the mention-chip tokenizer; markdown is assistant-only.
  assert.equal(source.includes("if (role === 'user') return <ConversationInlineTokens"), true)
  // The old static streaming hint is replaced by the CSS cursor.
  assert.equal(source.includes('Gateway WebSocket 正在生成'), false)
  assert.equal(cssSource.includes('.conversation-markdown'), true)
  assert.equal(cssSource.includes('@keyframes conversationStreamingCursorBlink'), true)
  assert.equal(cssSource.includes(".conversation-streaming-cursor > :last-child::after"), true)
})

test('conversation pending assistant bubble uses animated Think indicator', () => {
  const conversationSource = read('src/pages/Conversations.jsx')
  const cssSource = read('src/index.css')

  assert.equal(conversationSource.includes('Think'), true)
  assert.equal(conversationSource.includes('conversation-thinking-dot'), true)
  assert.equal(conversationSource.includes('正在处理'), false)
  assert.equal(conversationSource.includes('正在等待 Uniopc 引擎 回复'), false)
  assert.equal(cssSource.includes('@keyframes conversationThinkingDot'), true)
})

test('conversation model picker uses active Uniopc 引擎 profile snapshot', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('CONVERSATION_MODEL_CHOICES'), false)
  assert.equal(source.includes('engineClient.models.snapshot({ profile: activeProfile })'), true)
  assert.equal(source.includes('conversationModelChoices'), true)
  assert.equal(source.includes('model.catalogAvailable'), false)
  assert.equal(source.includes('model.providerReady'), false)
  assert.equal(source.includes('BAILIAN_TOKEN_PLAN_CONVERSATION_MODELS'), false)
  assert.equal(source.includes('bailian-token-plan/kimi-k2.5'), false)
  assert.equal(source.includes('bailian-token-plan/glm-5'), false)
  assert.equal(source.includes('BLOCKED_CONVERSATION_PROVIDER_STATUSES'), true)
  assert.equal(source.includes("providerId === 'qwen' && providerReady === false"), true)
  assert.equal(source.includes('模型来源：当前 Uniopc 引擎 profile'), true)
  assert.equal(source.includes('添加自定义模型'), false)
  assert.equal(source.includes('openCustomModelDialog()'), false)
  assert.equal(source.includes('CUSTOM_MODEL_PRESETS'), false)
  assert.equal(source.includes('CUSTOM_MODEL_FREEFORM_ID'), false)
})

test('conversation model picker has no third-party provider setup path', () => {
  const source = read('src/pages/Conversations.jsx')

  for (const retired of [
    'CUSTOM_MODEL_PRESETS',
    'CUSTOM_MODEL_FREEFORM_ID',
    'customModelForm',
    'custom-model-form',
    "invoke('openclaw_use_custom_openai_model'",
    "invoke('openclaw_use_provider_api_key_model'",
    "invoke('openclaw_use_openai_api_model'",
  ]) assert.equal(source.includes(retired), false)
  assert.equal(source.includes('for (const model of Array.isArray(snapshot?.models) ? snapshot.models : [])'), false)
})

test('conversation uses the built-in Uniopc official model prepared by app startup', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('profileDefaultModelRefFromSnapshot'), true)
  assert.equal(source.includes('snapshot?.resolvedDefaultModel'), true)
  assert.equal(source.includes('runtimeOpenClawStatus?.resolvedDefaultModel'), true)
  assert.equal(source.includes('runtimeOpenClawStatus?.resolved_default_model'), false)
  // The default entry is a fixed brand routing to the official model.
  assert.equal(source.includes('默认模型（Uniopc 官方）'), true)
  assert.equal(source.includes("UNIOPC_OFFICIAL_MODEL_REF = 'uniopc-official/uniopc-default'"), true)
  // A routine picker change reuses the provider/token prepared by bootstrap.
  // Only the preparation helper may fall back to a full connect when the
  // provider or selected catalog entry is genuinely missing.
  assert.equal(source.includes('prepareUniopcOfficialModelForSelection({'), true)
  assert.equal(source.includes('snapshot: modelSnapshot'), true)
  assert.equal(source.includes('modelRef: nextModel'), true)
  assert.equal(source.includes('connectUniopcOfficialModel({ profile: activeProfile })'), false)
  assert.equal(source.includes('maybeBootstrapUniopcOfficialModel'), false)
  assert.equal(source.includes('deriveProfileChatReadiness'), true)
  assert.equal(source.includes('profileChatReadiness.sendReady'), true)
  assert.equal(source.includes('const conversationModelReady = Boolean('), true)
  assert.equal(
    source.includes('!activeEmployee || profileChatReadiness.sendReady'),
    true,
  )
  assert.equal(source.includes('if (activeEmployee && !conversationModelReady) return'), false)
  // Model readiness is a normal composer-control loading state, not a chat
  // notice that interrupts the conversation timeline.
  assert.equal(source.includes('正在确认当前账号的 Uniopc 官方模型…'), false)
  assert.equal(source.includes('isOfficialModelPreparingForProfile'), false)
  assert.equal(source.includes('modelBootstrapSessionsRef'), false)
  assert.equal(source.includes('disabled={!activeTarget || !activeConversationRouteReady || !conversationModelReady'), false)
  assert.equal(source.includes('当前 profile 还没有可用模型'), false)
})

test('conversation execution uses shared Gateway readiness while input remains available', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('getGatewayConnectionSnapshot,'), true)
  assert.equal(source.includes('isGatewayConnectionReady,'), true)
  assert.equal(
    source.includes('const gatewayConnectionSnapshot = getGatewayConnectionSnapshot(activeProfile, gatewayPort)'),
    true,
  )
  assert.equal(source.includes('gatewayReady,'), true)
  assert.equal(source.includes('if (activeEmployee && !conversationModelReady) return'), false)
  assert.equal(
    source.includes("disabled={!activeTarget || !activeConversationRouteReady || !conversationModelReady || (!input.trim() && imageAttachments.length === 0)}"),
    false,
  )
})

test('conversation refreshes the model snapshot only after the shared Gateway is ready', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('const refreshModelSnapshot = useCallback('), true)
  assert.equal(source.includes('if (!gatewayReady)'), true)
  assert.equal(source.includes('}, [activeProfile, gatewayReady, refreshModelSnapshot])'), true)
})

test('conversation model control keeps the selected model visible instead of blocking on model setup', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('modelConnecting'), false)
  assert.equal(source.includes('aria-label="模型加载中"'), false)
  assert.equal(source.includes('disabled={!activeEmployee || !gatewayReady}'), true)
  assert.equal(source.includes('gatewayPreparing'), false)
  assert.equal(source.includes('<span className="truncate">{modelChipLabel}</span>'), true)
})

test('thinking strength is an employee-level setting, not a per-message picker', () => {
  const source = read('src/pages/Conversations.jsx')
  const employees = read('src/pages/Employees.jsx')
  const client = read('src/lib/conversations/client.js')
  const agents = read('src-tauri/src/commands/openclaw_agents.rs')
  const commands = read('src-tauri/src/commands/conversations/mod.rs')
  const sessionCommands = read('src-tauri/src/commands/conversations/sessions.rs')

  // The composer never asks the user about thinking (Accio-style zero choice).
  assert.equal(source.includes('thinkingMenuOpen'), false)
  assert.equal(source.includes('chooseConversationThinkingMode'), false)
  assert.equal(source.includes('BASE_CONVERSATION_THINKING_LEVELS'), false)
  assert.equal(source.includes('thinkingOverride'), false)
  // Regression guard: a stray setThinkingMode call inside the history loader
  // once threw at runtime, was swallowed by .catch, and ate the whole reply.
  assert.equal(source.includes('setThinkingMode'), false)
  assert.equal(source.includes('setReasoningMode'), false)

  // Employee settings own the knob and persist it as agents.list thinkingDefault.
  assert.equal(employees.includes('EMPLOYEE_THINKING_CHOICES'), true)
  assert.equal(employees.includes('思考强度'), true)
  assert.equal(employees.includes('thinkingDefault: form.thinkingDefault'), true)
  assert.equal(employees.includes("thinkingDefault: employee.thinkingDefault || ''"), true)
  assert.equal(agents.includes('pub thinking_default: Option<String>'), true)
  assert.equal(agents.includes('fn build_agent_thinking_default_patch'), true)
  assert.equal(agents.includes('normalize_agent_thinking_default'), true)
  assert.equal(agents.includes('"thinkingDefault"'), true)

  // Session-level thinking API stays available for future automation.
  assert.equal(client.includes('export async function setConversationSessionThinking'), true)
  assert.equal(client.includes('engineClient.sessions.setThinking('), true)
  assert.equal(commands.includes('build_session_thinking_patch'), true)
  assert.equal(sessionCommands.includes('conversation_set_session_thinking'), true)
})

test('conversation reasoning display is always streamed without a user-facing picker', () => {
  const source = read('src/pages/Conversations.jsx')
  const client = read('src/lib/conversations/client.js')
  const commands = read('src-tauri/src/commands/conversations/mod.rs')
  const sessionCommands = read('src-tauri/src/commands/conversations/sessions.rs')

  // The reasoning level is a gateway protocol knob, not a user choice: the
  // session is auto-patched to stream so the thinking panel fills in live.
  assert.equal(source.includes("CONVERSATION_REASONING_STREAM_LEVEL = 'stream'"), true)
  assert.equal(source.includes('ensureConversationReasoningStream'), true)
  assert.equal(source.includes('setConversationSessionReasoning'), true)
  assert.equal(source.includes('CONVERSATION_REASONING_MODES'), false)
  assert.equal(source.includes('reasoningMenuOpen'), false)
  assert.equal(source.includes('chooseConversationReasoningMode'), false)
  assert.equal(source.includes('sessions.patch reasoningLevel'), false)
  assert.equal(client.includes('export async function setConversationSessionReasoning'), true)
  assert.equal(client.includes('engineClient.sessions.setReasoning('), true)
  assert.equal(sessionCommands.includes('build_session_reasoning_patch'), true)
  assert.equal(sessionCommands.includes('"reasoningLevel"'), true)
  assert.equal(sessionCommands.includes('conversation_set_session_reasoning'), true)
})

test('conversation reasoning + tools fold into one Accio-style process strip', () => {
  const source = read('src/pages/Conversations.jsx')

  // One merged collapsible ("已处理 Ns") replaces the separate reasoning panel
  // and tool timeline, folding thinking + tool calls under a single header.
  assert.equal(source.includes('function ConversationProcessTimeline'), true)
  assert.equal(source.includes('formatConversationReasoningDuration'), true)
  assert.equal(source.includes('reasoning={activeReasoningPanel}'), true)
  assert.equal(source.includes('timeline={activeToolTimeline}'), true)
  assert.equal(source.includes('aria-expanded={expanded}'), true)
  assert.equal(source.includes('setProcessExpandedByConversation'), true)
  // The reasoning + tool data pipeline is unchanged and still collapses on finish.
  assert.equal(source.includes('finishConversationReasoningPanel'), true)
  assert.equal(source.includes('expanded: false'), true)
  // The old two separate panel components are gone.
  assert.equal(source.includes('function ConversationReasoningPanel'), false)
  assert.equal(source.includes('function ConversationToolTimeline'), false)
})

test('产物 (artifacts) moved to a single global hub, off the per-conversation header', () => {
  const source = read('src/pages/Conversations.jsx')
  const formatting = read('src/lib/conversationMessageFormatting.js')
  const control = read('src/components/GlobalArtifactsControl.jsx')
  const layout = read('src/components/Layout.jsx')
  const store = read('src/lib/conversationStore.js')

  // Aggregation is still a pure, unit-tested helper over the MEDIA: tokens.
  assert.equal(formatting.includes('export function collectConversationArtifacts'), true)

  // The old per-conversation drawer stayed dead; the per-conversation surface
  // is now the compact slot component above the composer (two-layer IA: slot
  // shows top-N for THIS conversation, the docked panel holds everything).
  assert.equal(source.includes('function ConversationArtifactsDrawer'), false)
  assert.equal(source.includes('collectConversationArtifacts'), false)
  assert.equal(source.includes('artifactsOpen'), false)
  assert.equal(source.includes('<ConversationArtifactsSlot'), true)
  const slot = read('src/components/ConversationArtifactsSlot.jsx')
  // The slot merges the engine's authoritative in-workspace write set with the
  // local (declared + sniffed) index; local wins path collisions because it
  // carries declared titles/kinds. Its "查看全部" opens the docked panel.
  assert.equal(slot.includes('listConversationSessionFiles(sessionKey'), true)
  assert.equal(slot.includes("invoke('artifact_stat_paths', { paths })"), true)
  assert.equal(slot.includes("window.dispatchEvent(new CustomEvent('imai:open-artifacts-panel'))"), true)

  // A single global hub aggregates every owner conversation from local storage,
  // merging assistant MEDIA: tokens with the files tools actually wrote.
  const artifacts = read('src/lib/conversationArtifacts.js')
  assert.equal(control.includes('listStoredConversations(ownerId)'), true)
  assert.equal(control.includes('listStoredToolArtifacts(ownerId)'), true)
  assert.equal(control.includes('collectAllArtifacts('), true)
  assert.equal(artifacts.includes('collectConversationArtifacts'), true)
  assert.equal(artifacts.includes('.flatMap('), true)
  // Broken/missing files degrade to a labelled placeholder, never a bare "?".
  assert.equal(control.includes('onError={() => setFailed(true)}'), true)
  // The count stays live via a broadcast from the store on every save.
  assert.equal(store.includes("dispatchEvent(new CustomEvent('imai:conversations-updated'))"), true)
  assert.equal(control.includes("addEventListener('imai:conversations-updated'"), true)

  // Accio-style: the hub is split into a titlebar toggle (to the right of the
  // version pill) and a DOCKED side panel that lives inline in the layout row,
  // so opening it shrinks the main content instead of overlaying it.
  assert.equal(control.includes('export function useGlobalArtifacts'), true)
  assert.equal(control.includes('export function GlobalArtifactsToggle'), true)
  assert.equal(control.includes('export function GlobalArtifactsPanel'), true)
  assert.equal(layout.includes('<GlobalArtifactsToggle'), true)
  assert.equal(layout.includes('<GlobalArtifactsPanel'), true)

  // The panel closes from the ✕ in its header — there is no overlay drawer, so
  // no full-screen backdrop catcher and no translate-x slide behind it.
  assert.equal(control.includes('aria-label="关闭产物"'), true)
  assert.equal(control.includes('onClick={() => setOpen(false)}'), true)
  assert.equal(control.includes('translate-x-full'), false)
  assert.equal(control.includes('fixed inset-y-0'), false)

  // Clicking any card opens the in-app preview modal (media, markdown, code,
  // PDF, HTML; Office degrades to an explicit OS-open panel), closable via ✕,
  // backdrop click, or Esc. The old image/video-only lightbox is gone.
  const previewComponent = read('src/components/ArtifactPreview.jsx')
  assert.equal(control.includes('function ArtifactLightbox'), false)
  assert.equal(control.includes('onPreview(artifact)'), true)
  assert.equal(control.includes('<ArtifactPreviewModal artifact={preview} onClose={() => setPreview(null)} />'), true)
  assert.equal(previewComponent.includes('export function ArtifactPreviewModal'), true)
  assert.equal(previewComponent.includes("event.key === 'Escape'"), true)
  // Text-family previews read through Rust (any absolute path), media/PDF/HTML
  // stream via the asset protocol; HTML stays sandboxed and cross-origin.
  assert.equal(previewComponent.includes("invoke('artifact_read_text'"), true)
  assert.equal(previewComponent.includes('sandbox="allow-scripts"'), true)
  assert.equal(previewComponent.includes('allow-same-origin'), false)
})

test('产物 covers every produced file, not just generated images', () => {
  const source = read('src/pages/Conversations.jsx')
  const control = read('src/components/GlobalArtifactsControl.jsx')
  const artifacts = read('src/lib/conversationArtifacts.js')
  const stream = read('src-tauri/src/services/openclaw_gateway_stream.rs')
  const gateway = read('src-tauri/src/services/openclaw_gateway.rs')

  // The gateway only streams tool ARGS to clients that claim the capability;
  // without it we get the args-less item stream and can extract nothing.
  assert.equal(gateway.includes('pub const GATEWAY_CLIENT_CAPS: [&str; 2] = ["tool-events", "exec-approvals"];'), true)
  assert.equal(gateway.includes('"caps": []'), false)
  // Session subscribers receive the same frames under `session.tool`; accepting
  // it keeps extraction working even if the cap is ever dropped.
  assert.equal(stream.includes('if event == "session.tool" {'), true)
  // Paths are extracted from the RAW args, never from the truncated preview —
  // a `write` call ships the file body ahead of `file_path`.
  assert.equal(stream.includes('tool_artifacts::extract_tool_artifact_paths('), true)
  assert.equal(stream.includes('pub tool_artifacts: Vec<'), true)

  // Produced files are persisted per owner so the global panel sees them
  // regardless of which conversation is open.
  assert.equal(source.includes('function recordGatewayToolArtifacts'), true)
  assert.equal(source.includes('payload?.toolArtifacts'), true)
  assert.equal(artifacts.includes('export function recordToolArtifacts'), true)
  assert.equal(artifacts.includes('export function listStoredToolArtifacts'), true)

  // Non-media artifacts get a type glyph and are filtered against the
  // filesystem — a tool_started frame names a file before it exists. The OS
  // handoff moved into the preview modal (its fallback for Office/unknown).
  const previewSource = read('src/components/ArtifactPreview.jsx')
  assert.equal(control.includes("invoke('artifact_stat_paths', { paths })"), true)
  assert.equal(previewSource.includes("runAction('artifact_open_path'"), true)
  assert.equal(control.includes("runAction('artifact_reveal_in_dir'"), true)
  assert.equal(control.includes('artifactIcon(artifact?.fileKind)'), true)
})

test('conversation page switches real Uniopc 引擎 gateway sessions per employee', () => {
  const source = read('src/pages/Conversations.jsx')
  const client = read('src/lib/conversations/client.js')

  assert.equal(client.includes('export async function listConversationSessions'), true)
  assert.equal(client.includes('engineClient.sessions.list('), true)
  assert.equal(client.includes('export async function createConversationSession'), true)
  assert.equal(client.includes('engineClient.sessions.create('), true)
  assert.equal(source.includes('SessionPicker'), true)
  assert.equal(source.includes('selectedSessionByEmployee'), true)
  assert.equal(source.includes('activeConversationSessionKey'), true)
  assert.equal(source.includes('sessionKey: activeConversationSessionKey'), true)
  // History is still keyed on the active session; the options argument only
  // controls whether the extra session-metadata round trip is made.
  assert.equal(source.includes('loadConversationHistory(activeConversationSessionKey, historyProfile, {'), true)
  assert.equal(source.includes('const sessionKey = buildSessionKey(activeEmployee.id)'), false)
})

test('conversation keeps the session control beside the active AI employee', () => {
  const source = read('src/pages/Conversations.jsx')
  const headerStart = source.indexOf('<header className="relative flex h-16')
  const headerEnd = source.indexOf('</header>', headerStart)
  const header = source.slice(headerStart, headerEnd)
  const pickerStart = source.indexOf('function SessionPicker({')
  const pickerEnd = source.indexOf('function orderEmployeesForChat', pickerStart)
  const pickerSource = source.slice(pickerStart, pickerEnd)

  assert.notEqual(headerStart, -1)
  assert.notEqual(headerEnd, -1)
  assert.equal(header.indexOf('<SessionPicker') > header.indexOf('displayEmployeeName(activeEmployee)'), true)
  assert.equal(header.indexOf('切换浏览器面板') > header.indexOf('<SessionPicker'), true)
  assert.equal(header.includes('同步当前对话'), false)
  assert.equal(pickerSource.includes('title="刷新聊天记录"'), true)
})

test('conversation session picker exposes stable E2E session key observables', () => {
  const source = read('src/pages/Conversations.jsx')
  const pickerStart = source.indexOf('function SessionPicker({')
  const pickerEnd = source.indexOf('function orderEmployeesForChat', pickerStart)
  const pickerSource = source.slice(pickerStart, pickerEnd)

  assert.notEqual(pickerStart, -1)
  assert.notEqual(pickerEnd, -1)
  assert.equal(pickerSource.includes('data-e2e-active-session-key={activeSessionKey}'), true)
  assert.equal(pickerSource.includes('data-e2e-session-key={sessionKey}'), true)
})

test('conversation session picker uses a compact density layout', () => {
  const source = read('src/pages/Conversations.jsx')
  const pickerStart = source.indexOf('function SessionPicker({')
  const pickerEnd = source.indexOf('function orderEmployeesForChat', pickerStart)
  const pickerSource = source.slice(pickerStart, pickerEnd)

  assert.notEqual(pickerStart, -1)
  assert.notEqual(pickerEnd, -1)
  assert.equal(pickerSource.includes('w-[320px]'), true)
  assert.equal(pickerSource.includes('p-1.5'), true)
  assert.equal(pickerSource.includes('h-7'), true)
  assert.equal(pickerSource.includes('py-0.5'), true)
  assert.equal(pickerSource.includes('py-1.5'), true)
  assert.equal(pickerSource.includes('title="新聊天"'), true)
  assert.equal(pickerSource.includes('aria-label={creating ? \'正在创建新聊天\' : \'新聊天\'}'), true)
  assert.equal(pickerSource.includes('border-t border-[var(--ui-color-border)] p-1.5'), false)
  assert.equal(pickerSource.includes('h-8 w-full'), false)
})

test('conversation session picker renames gateway sessions through official label patch', () => {
  const source = read('src/pages/Conversations.jsx')
  const client = read('src/lib/conversations/client.js')
  const commands = read('src-tauri/src/commands/conversations/mod.rs')
  const sessionCommands = read('src-tauri/src/commands/conversations/sessions.rs')
  const lib = read('src-tauri/src/lib.rs')

  assert.equal(client.includes('export async function renameConversationSession'), true)
  assert.equal(client.includes('engineClient.sessions.rename('), true)
  assert.equal(sessionCommands.includes('pub async fn conversation_rename_session'), true)
  assert.equal(commands.includes('build_session_label_patch'), true)
  assert.equal(lib.includes('commands::conversations::sessions::conversation_rename_session'), true)
  assert.equal(source.includes('renameConversationSession,'), true)
  assert.equal(source.includes('editingSessionKey'), true)
  assert.equal(source.includes('onRenameSession'), true)
  assert.equal(source.includes('重命名'), true)
  assert.equal(source.includes('session?.label ||'), true)
  assert.equal(source.includes('session?.title ||'), true)
})

test('conversation resolves stale local media paths before rendering an MP4 source', () => {
  const source = read('src/pages/Conversations.jsx')
  const mediaStart = source.indexOf('function ConversationMediaToken({ token })')
  const mediaEnd = source.indexOf('function ConversationInlineTokens', mediaStart)
  const mediaSource = source.slice(mediaStart, mediaEnd)

  assert.notEqual(mediaStart, -1)
  assert.notEqual(mediaEnd, -1)
  assert.equal(mediaSource.includes("invoke('resolve_media_asset_path', { path: token.value })"), true)
  assert.equal(mediaSource.includes("setResolveError('媒体文件不存在或不可访问')"), true)
  assert.equal(mediaSource.includes('playsInline'), true)
  assert.equal(mediaSource.includes('<source src={src} type="video/mp4" />'), true)
  assert.equal(mediaSource.includes('videoRef.current.load()'), true)
  assert.equal(mediaSource.includes('onError={event =>'), true)
  assert.equal(mediaSource.includes('视频无法播放：{resolveError || videoError}。'), true)
})

test('conversation composer imports native file drops and picks the supported attachment types', () => {
  const source = read('src/pages/Conversations.jsx')
  const composerStart = source.indexOf('<form\n            ref={composerRef}')
  const composerEnd = source.indexOf('\n          </form>', composerStart)
  const composer = source.slice(composerStart, composerEnd)

  assert.notEqual(composerStart, -1)
  assert.notEqual(composerEnd, -1)
  assert.equal(composer.includes('onDrop={event =>'), true)
  assert.equal(composer.includes('addImageFiles(event.dataTransfer.files)'), true)
  assert.equal(source.includes('onDragDropEvent(async event =>'), true)
  assert.equal(source.includes("import { getCurrentWebview } from '@tauri-apps/api/webview'"), true)
  assert.equal(source.includes('const appWebview = getCurrentWebview()'), true)
  assert.equal(source.includes('appWebview.onDragDropEvent(async event =>'), true)
  assert.equal(source.includes('nativeDragPositionToViewport(position'), true)
  assert.equal(source.includes("invoke('conversation_import_attachments'"), true)
  assert.equal(source.includes("'ppt', 'pptx', 'txt', 'mp4'"), true)
  assert.equal(source.includes("'png', 'jpg', 'jpeg', 'gif', 'webp'"), true)
  assert.equal(source.includes("String(file?.type || '').startsWith('image/') || String(file?.type || '') === 'application/pdf'"), true)
  assert.equal(source.includes('<span>文件附件</span>'), true)
  assert.equal(source.includes('attachmentParseStatus: \'parsed\''), false)
  assert.equal(source.includes('已送达 · 附件解析状态未知'), true)
  assert.equal(source.includes('download={attachment.name || \'附件\'}'), true)
  assert.equal(source.includes('title={`下载 ${attachment.name || \'附件\'}`}'), true)
})

test('conversation history merge carries sent local attachments into persistent session messages', () => {
  const source = read('src/pages/Conversations.jsx')
  const historyStart = source.indexOf('loadConversationHistory(activeConversationSessionKey, historyProfile')
  const historyEnd = source.indexOf('\n      .catch(() => null)', historyStart)
  const historyEffect = source.slice(historyStart, historyEnd)

  assert.notEqual(historyStart, -1)
  assert.notEqual(historyEnd, -1)
  assert.equal(historyEffect.includes('activeOptimisticUserMessage?.conversationId === activeConversationId'), true)
  assert.equal(historyEffect.includes('pendingUserMessage ? [...currentMessages, pendingUserMessage] : currentMessages'), true)
  assert.equal(source.includes('activeOptimisticUserMessage, activeProfile, activeSending, historyRefreshNonce'), true)
})
