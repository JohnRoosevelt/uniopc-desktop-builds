import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const supabaseRoot = process.env.UNIOPC_SUPABASE_DIR || path.resolve(repoRoot, '../uniopc-supabase/supabase')

const hasBackendSource = fs.existsSync(path.join(supabaseRoot, 'migrations'))
function testBackendSourceContract(name, fn) {
  test(name, { skip: !hasBackendSource && 'backend source checkout is not configured' }, fn)
}

function read(relativePath) {
  if (relativePath.startsWith('supabase/')) {
    return fs.readFileSync(path.join(supabaseRoot, relativePath.slice('supabase/'.length)), 'utf8').replace(/\r\n/g, '\n')
  }
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

function exists(relativePath) {
  if (relativePath.startsWith('supabase/')) {
    return fs.existsSync(path.join(supabaseRoot, relativePath.slice('supabase/'.length)))
  }
  return fs.existsSync(path.join(repoRoot, relativePath))
}

test('legacy frontend-only gateway websocket bridge is removed', () => {
  assert.equal(exists('src/lib/conversations/gatewaySocket.js'), false)
  assert.equal(read('package.json').includes('@tauri-apps/plugin-websocket'), false)
  assert.equal(read('src-tauri/Cargo.toml').includes('tauri-plugin-websocket'), false)
  assert.equal(read('src-tauri/src/lib.rs').includes('tauri_plugin_websocket'), false)
  assert.equal(read('src-tauri/capabilities/default.json').includes('websocket:default'), false)
})

test('temporary BlockSuite debug store script is removed', () => {
  assert.equal(exists('src/lib/_tmp_debug_store.mjs'), false)
})

test('legacy unmounted React modules are removed', () => {
  const removedFiles = [
    'src/components/Button.jsx',
    'src/pages/Profile.jsx',
    'src/pages/Studio/index.jsx',
    'src/lib/conversationEmployees.js',
    'src/lib/conversationEmployees.test.mjs',
  ]

  for (const file of removedFiles) {
    assert.equal(exists(file), false, `${file} should not exist`)
  }
})

test('conversation employee list keeps status on the avatar instead of a text row', () => {
  const source = read('src/pages/Conversations.jsx')
  const sharedList = read('src/components/EmployeeListPane.jsx')

  assert.equal(source.includes('formatModelLikeLabel(employee.model)'), false)
  // 状态仍然挂在头像上（tooltip），不占独立文本行；
  // 正在生成回复时 tooltip 换成「正在回复」，与呼吸环对应。
  assert.equal(sharedList.includes("title={busy ? '正在回复' : formatStatusLabel(employee.status)}"), true)
  assert.equal(source.includes('AI 员工\\n'), false)
  assert.equal(source.includes('人类员工\\n'), false)
  assert.equal(source.includes('已选择左侧 AI 员工'), false)
  assert.equal(source.includes('已选择左侧人类员工'), false)
  assert.equal(source.includes('chatTargets'), false)
  assert.equal(sharedList.includes('employees.map'), true)
  assert.equal(sharedList.includes('humans.map'), false)
})

test('retired human collaboration code is absent from the employee-only conversation flow', () => {
  const source = read('src/pages/Conversations.jsx')
  const employees = read('src/pages/Employees.jsx')
  const sharedList = read('src/components/EmployeeListPane.jsx')

  assert.equal(exists('src/lib/humanEmployees.js'), false)
  assert.equal(source.includes('listCloudHumanMessages'), false)
  assert.equal(source.includes('sendCloudHumanMessage'), false)
  assert.equal(source.includes('activeHuman'), false)
  assert.equal(employees.includes("import { filterCurrentHumanEmployee } from '../lib/humanEmployees'"), false)
  assert.equal(sharedList.includes('humans = []'), false)
  assert.equal(sharedList.includes('onOpenHumanChat'), false)
})

test('employee settings list uses the same compact employee rows as conversations', () => {
  const conversations = read('src/pages/Conversations.jsx')
  const source = read('src/pages/Employees.jsx')
  const directory = read('src/pages/employees/EmployeeDirectoryPane.jsx')
  const sharedList = read('src/components/EmployeeListPane.jsx')

  assert.equal(conversations.includes("import EmployeeListPane from '../components/EmployeeListPane'"), true)
  assert.equal(source.includes("import EmployeeDirectoryPane from './employees/EmployeeDirectoryPane'"), true)
  assert.equal(directory.includes("import EmployeeListPane from '../../components/EmployeeListPane'"), true)
  assert.equal(`${source}\n${directory}`.includes('EmployeeListAvatar'), false)
  assert.equal(sharedList.includes('function EmployeeListAvatar'), true)
  assert.equal(directory.includes('border-b border-white/8 px-3.5 py-2'), false)
  assert.equal(directory.includes('>AI 员工<'), false)
  assert.equal(directory.includes('>人类员工<'), false)
  assert.equal(sharedList.includes('grid min-w-0 grid-cols-[32px_minmax(0,1fr)] gap-2.5 px-2.5 py-3'), true)
  // 在场状态从"右下角小圆点"改成"头像外圈呼吸环"（signature）：
  // 那个绿点实测是全屏出现最多的彩色，比品牌紫还抢眼。
  assert.equal(sharedList.includes('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full'), false)
  assert.equal(sharedList.includes('ui-presence'), true)
  assert.equal(/bg-emerald-400/.test(sharedList), false)
  assert.equal(sharedList.includes("mode === 'settings'"), true)
  assert.equal(sharedList.includes("mode === 'chat'"), true)
})

test('employee settings keeps stable directory selection and defers connection details', () => {
  const source = read('src/pages/Employees.jsx')
  const directory = read('src/pages/employees/EmployeeDirectoryPane.jsx')
  const detail = read('src/pages/employees/EmployeeDetailPane.jsx')
  const connections = read('src/pages/employees/EmployeeConnectionsDialog.jsx')
  const directoryCall = source.slice(
    source.indexOf('<EmployeeDirectoryPane'),
    source.indexOf('/>', source.indexOf('<EmployeeDirectoryPane')),
  )
  const detailCall = source.slice(
    source.indexOf('<EmployeeDetailPane'),
    source.indexOf('/>', source.indexOf('<EmployeeDetailPane')),
  )

  assert.equal(exists('src/pages/employees/EmployeeDirectoryPane.jsx'), true)
  assert.equal(exists('src/pages/employees/EmployeeDetailPane.jsx'), true)
  assert.equal(exists('src/pages/employees/EmployeeConnectionsDialog.jsx'), true)
  assert.equal(source.includes("import EmployeeDirectoryPane from './employees/EmployeeDirectoryPane'"), true)
  assert.equal(source.includes("import EmployeeDetailPane from './employees/EmployeeDetailPane'"), true)
  assert.equal(source.includes("const EmployeeConnectionsDialog = lazyPage(() => import('./employees/EmployeeConnectionsDialog'))"), true)
  assert.equal(source.includes("{(employeeDocsOpen || connectModalOpen) && (\n        <EmployeeConnectionsDialog"), true)
  assert.equal(source.includes('selectedEmployeeId={selectedEmployeeId}'), true)
  assert.equal(source.includes('onSelect={selectEmployee}'), true)
  assert.equal(source.includes('employee={selectedEmployee}'), true)
  assert.equal(source.includes('detailTab={employeeDetailTab}'), true)
  assert.equal(source.includes('onDetailTabChange={setEmployeeDetailTab}'), true)
  assert.equal(source.includes('onEdit={openEditModal}'), true)
  assert.equal(source.includes('onOpenConnections={openConnectModal}'), true)
  assert.equal(directoryCall.includes('notice={notice}'), true)
  assert.equal(directoryCall.includes('error={error}'), true)
  assert.equal(detailCall.includes('notice={notice}'), true)
  assert.equal(detailCall.includes('error={error}'), true)
  assert.equal(directory.includes('{error && ('), true)
  assert.equal(directory.includes('{notice && ('), true)
  assert.equal(detail.includes('{error && ('), false)
  assert.equal(detail.includes('{notice && ('), false)
  assert.equal(directory.includes('m-3 rounded-xl border border-rose-400/18 bg-rose-400/10 px-3 py-2 text-sm leading-5 text-danger-text'), true)
  assert.equal(directory.includes('m-3 rounded-xl border border-violet-400/18 bg-violet-400/10 px-3 py-2 text-sm leading-5 text-accent-text'), true)
  assert.equal(directory.indexOf('{error && (') < directory.indexOf('{notice && ('), true)
  assert.equal(directory.indexOf('{notice && (') < directory.indexOf('{requests.length > 0 && ('), true)
  assert.equal(directory.includes('activeEmployeeId={selectedEmployeeId}'), true)
  assert.equal(directory.includes('onOpenEmployeeSettings={onSelect}'), true)
  assert.equal(source.includes('async function loadEmployees('), true)
  for (const pane of [directory, detail, connections]) {
    for (const pageOwnedApi of [
      'invoke(',
      'supabase',
      'useState(',
      'useEffect(',
      'useSearchParams',
      'useProfileWorkspace',
      'useActiveOpenClawProfile',
      'profileWorkspaceNavigationState',
      'profileWorkspacePath',
      'loadEmployees',
      'loadEmployeeDirectory',
      'loadLocalEmployees',
      'primeLocalEmployeesCache',
      'requireCurrentProfile',
      'setEmployees',
      'setEmployeeRequests',
      'setSelectedEmployeeId',
      'setEmployeeDetailTab',
      'setSkillQuery',
      'setSkillListMode',
      'setModalOpen',
      'setConnectModalOpen',
      'setEmployeeDocsOpen',
      'setForm',
      'setFeishuForm',
      'setWechatForm',
      'setSelectedEmployeeDocPath',
      'setEmployeeDocumentValue',
      'setEditingEmployeeDocument',
    ]) {
      assert.equal(pane.includes(pageOwnedApi), false, `${pageOwnedApi} must remain in Employees.jsx`)
    }
  }
})

test('recoverable employee action failures preserve selection tabs filters forms and open dialogs', () => {
  const source = read('src/pages/Employees.jsx')
  const recoverableActions = [
    ['saveEmployee', 'async function saveEmployee(event)', 'async function deleteEmployee(employee)', 'setSaving'],
    ['toggleSelectedEmployeeSkill', 'async function toggleSelectedEmployeeSkill(skillName)', 'async function loadEmployeeDocuments(', 'setSavingSkillName'],
    ['saveEmployeeDocument', 'async function saveEmployeeDocument()', 'useEffect(() => {\n    if ((modalOpen || connectModalOpen)', 'setSavingEmployeeDocument'],
    ['saveAndBindFeishu', 'async function saveAndBindFeishu()', 'async function unbindFeishu()', 'setSavingFeishu'],
    ['bindWechat', 'async function bindWechat()', 'async function unbindWechat()', 'setBindingWechat'],
  ]
  const documentedSuccessOnlyMutations = {
    saveEmployee: [
      { mutation: 'closeModal()', after: 'await loadEmployeeRequests()', before: "setNotice('AI 员工创建申请已提交" },
      { mutation: 'setSelectedEmployeeId(savedEmployee.id)', after: 'setEmployees(prev => {', before: 'invalidateLocalEmployeesCache(currentProfile)' },
      { mutation: 'closeModal()', after: 'invalidateLocalEmployeesCache(currentProfile)', before: 'if (editing) {' },
    ],
    saveEmployeeDocument: [
      { mutation: "setEmployeeDocumentValue(detail?.content || '')", after: 'setEmployeeDocumentDetail(detail)', before: 'setEditingEmployeeDocument(false)' },
      { mutation: 'setEditingEmployeeDocument(false)', after: 'setEmployeeDocumentDetail(detail)', before: 'await loadEmployeeDocuments(employeeDocsEmployee)' },
    ],
    saveAndBindFeishu: [
      { mutation: 'syncFeishuFormForEmployee(form.id, nextOverview)', after: 'setFeishuOverview(nextOverview)', before: '} catch (err) {' },
    ],
  }
  const forbiddenFailureMutations = [
    'closeModal(',
    'closeConnectModal(',
    'closeEmployeeDocs(',
    'selectEmployee(',
    'syncFeishuFormForEmployee(',
    'syncWechatFormForEmployee(',
    'setSelectedEmployeeId(',
    'setEmployeeDetailTab(',
    'setSkillQuery(',
    'setSkillListMode(',
    'setModalOpen(false)',
    'setConnectModalOpen(false)',
    'setEmployeeDocsOpen(false)',
    'setForm(',
    'setFeishuForm(',
    'setWechatForm(',
    'setSelectedEmployeeDocPath(',
    'setEmployeeDocumentValue(',
    'setEditingEmployeeDocument(',
  ]

  for (const [name, startMarker, endMarker, expectedFinallySetter] of recoverableActions) {
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker, start)
    assert.notEqual(start, -1, `${name} start must exist`)
    assert.notEqual(end, -1, `${name} end must exist`)
    const action = source.slice(start, end)
    const tryStart = action.indexOf('try {')
    const catchStart = action.lastIndexOf('} catch (err) {')
    const finallyStart = action.indexOf('} finally {', catchStart)
    assert.notEqual(tryStart, -1, `${name} must keep its recoverable try path`)
    assert.notEqual(catchStart, -1, `${name} must keep a recoverable catch`)
    assert.notEqual(finallyStart, -1, `${name} must keep loading cleanup in finally`)
    const catchPath = action.slice(catchStart, finallyStart)
    const finallyPath = action.slice(finallyStart)
    const finallySetters = [...finallyPath.matchAll(/\b(set[A-Z]\w*)\s*\(/g)].map(match => match[1])
    assert.equal(catchPath.includes('setError('), true, `${name} must surface its failure`)
    assert.deepEqual(finallySetters, [expectedFinallySetter], `${name} finally may only clear its busy state`)

    let rejectionSensitivePath = action
    for (const { mutation, after, before } of documentedSuccessOnlyMutations[name] || []) {
      const afterStart = rejectionSensitivePath.indexOf(after, tryStart)
      const beforeStart = rejectionSensitivePath.indexOf(before, afterStart + after.length)
      const mutationStart = rejectionSensitivePath.indexOf(mutation, afterStart + after.length)
      assert.notEqual(afterStart, -1, `${name} success boundary must keep ${after}`)
      assert.notEqual(beforeStart, -1, `${name} success boundary must keep ${before}`)
      assert.equal(
        mutationStart >= 0 && mutationStart < beforeStart,
        true,
        `${name} may call ${mutation} only inside its documented success boundary`,
      )
      rejectionSensitivePath = `${rejectionSensitivePath.slice(0, mutationStart)}${rejectionSensitivePath.slice(mutationStart + mutation.length)}`
    }
    for (const mutation of forbiddenFailureMutations) {
      assert.equal(rejectionSensitivePath.includes(mutation), false, `${name} rejection-sensitive path must not call ${mutation}`)
    }
  }
})

test('employee creation inherits the profile model instead of asking for one', () => {
  const source = read('src/pages/Employees.jsx')

  assert.equal(source.includes('MODEL_UNAVAILABLE_MESSAGE'), false)
  assert.equal(source.includes('openClawModelOptionsFromSnapshot'), false)
  assert.equal(source.includes('请选择一个已连接且可用的模型'), false)
  assert.equal(source.includes("{editing ? '员工模型' : '默认模型'}"), false)
  assert.equal(source.includes('modelOptions.map'), false)
  assert.equal(source.includes('model: selectedModel'), false)
})

test('profile model page separates provider account status from model choices', () => {
  const source = read('src/pages/ModelSettings.jsx')
  const providerStatusStart = source.indexOf('function ProviderStatus')
  const providerStatusEnd = source.indexOf('function providerFromModelRef', providerStatusStart)
  const providerStatusSource = source.slice(providerStatusStart, providerStatusEnd)

  assert.equal(source.includes('availableModelChoicesFromSnapshot'), true)
  assert.equal(source.includes('可用对话模型'), true)
  assert.equal(source.includes('个模型可用'), true)
  assert.equal(source.includes('个来源可用'), false)
  assert.equal(source.includes('已连接模型'), false)
  assert.equal(source.includes("`模型：${currentModel}`"), false)
  assert.notEqual(providerStatusStart, -1)
  assert.notEqual(providerStatusEnd, -1)
  assert.equal(providerStatusSource.includes('providerSourceCount'), true)
  assert.equal(providerStatusSource.includes('modelCount'), true)
  assert.equal(providerStatusSource.includes('个来源'), true)
  assert.equal(providerStatusSource.includes('个模型'), true)
  assert.equal(providerStatusSource.includes('Codex 被限流'), false)
  assert.equal(providerStatusSource.includes('账号：'), false)
})

test('profile model page exposes Uniopc 引擎 media capability sections', () => {
  const source = read('src/pages/ModelSettings.jsx')

  assert.equal(source.includes('Profile 模型与能力'), true)
  assert.equal(source.includes('function CapabilityOverview'), true)
  assert.equal(source.includes('图片生成'), true)
  assert.equal(source.includes('视频生成'), true)
  assert.equal(source.includes('语音合成'), true)
  assert.equal(source.includes('语音识别'), true)
  assert.equal(source.includes('agents.defaults.imageGenerationModel'), true)
  assert.equal(source.includes('agents.defaults.videoGenerationModel'), true)
  assert.equal(source.includes('messages.tts'), true)
  assert.equal(source.includes('tools.media.audio'), true)
  assert.equal(source.includes('image_generate'), true)
  assert.equal(source.includes('video_generate'), true)
  assert.equal(source.includes('能力配置和 Provider 授权都由 Uniopc 引擎 管理'), true)
})

test('profile media capability UI saves Gateway-backed capability defaults', () => {
  const source = read('src/pages/ModelSettings.jsx')
  const command = read('src-tauri/src/commands/model/models.rs')
  const commandRoot = read('src-tauri/src/commands/model/mod.rs')
  const tauri = read('src-tauri/src/lib.rs')

  assert.equal(source.includes('待补 UI'), false)
  assert.equal(source.includes('capabilityForm'), true)
  assert.equal(source.includes("invoke('openclaw_media_capabilities_save'"), true)
  assert.equal(source.includes('保存能力配置'), true)
  assert.equal(source.includes('图片模型'), true)
  assert.equal(source.includes('视频模型'), true)
  assert.equal(source.includes('TTS 模型'), true)
  assert.equal(source.includes('STT 模型'), true)
  assert.equal(command.includes('pub async fn openclaw_media_capabilities_save'), true)
  assert.equal(commandRoot.includes('OpenClawMediaCapabilitiesSaveRequest'), true)
  assert.equal(commandRoot.includes('build_openclaw_media_capabilities_patch'), true)
  assert.equal(commandRoot.includes('openclaw_gateway::config_patch'), true)
  assert.equal(tauri.includes('commands::model::models::openclaw_media_capabilities_save'), true)
})

test('profile media capability cards open inline configuration controls', () => {
  const source = read('src/pages/ModelSettings.jsx')

  assert.equal(source.includes('function CapabilityConfigDialog'), true)
  assert.equal(source.includes('capabilityDialogId'), true)
  assert.equal(source.includes('setCapabilityDialogId'), true)
  assert.equal(source.includes('onCapabilityOpen(item.id)'), true)
  assert.equal(source.includes('role="dialog"'), true)
  assert.equal(source.includes('aria-modal="true"'), true)
  assert.equal(source.includes('配置{item.title}'), true)
  assert.equal(source.includes('capabilityDialog?.fields?.map'), true)
  assert.equal(source.includes("保存{capabilityDialog?.title || '能力'}配置"), true)
  assert.equal(source.includes('配置模型不会在这里保存 API Key'), false)
  assert.equal(source.includes('Provider 授权或 API Key'), false)
  assert.equal(source.includes('关闭配置'), true)
  // 遮罩改走 scrim token：bg-black/65 只在深色下成立，浅色主题需要同样压暗
  assert.equal(source.includes('bg-scrim-strong'), true)
  assert.equal(source.includes('backdrop-blur-sm'), true)
  assert.equal(source.includes('`${SURFACE.modal} max-h-[calc(100vh-48px)] w-full max-w-[560px] overflow-y-auto p-5`'), true)
  assert.equal(source.includes('onClick={event => event.stopPropagation()}'), true)
  assert.equal(source.includes('aria-label="关闭配置"'), true)
  assert.equal(source.includes('whitespace-nowrap'), true)
  assert.equal(source.includes('bg-' + '[var(--ui-color-panel)]'), false)
  assert.equal(source.includes('className={`${SURFACE.panelSoft} mt-4 p-4`}'), false)
})

test('profile media capability cards keep metadata readable on light surfaces', () => {
  const source = read('src/pages/ModelSettings.jsx')
  const overviewStart = source.indexOf('function CapabilityOverview')
  const overviewEnd = source.indexOf('function CapabilityConfigDialog')
  const overview = source.slice(overviewStart, overviewEnd)

  assert.ok(overviewStart > -1)
  assert.ok(overviewEnd > overviewStart)
  assert.equal(overview.includes('text-primary'), true)
  assert.equal(overview.includes('text-secondary'), true)
  assert.equal(overview.includes('bg-surface-overlay'), true)
  assert.equal(overview.includes('bg-surface-sunken'), true)
  assert.equal(overview.includes('text-white'), false)
  assert.equal(overview.includes('text-slate-200'), false)
  assert.equal(overview.includes('border-white/8 bg-black/10'), false)
  assert.equal(overview.includes('border-white/10'), false)
})

test('conversation employee settings changes the right pane without navigating away', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('const [rightPaneMode, setRightPaneMode] = useState'), true)
  assert.equal(source.includes("setRightPaneMode('settings')"), true)
  assert.equal(source.includes("rightPaneMode === 'settings'"), true)
  assert.equal(source.includes("navigate(`/employees?agent=${employeeId}`)"), false)
  assert.equal(source.includes("navigate(`/employees?human=${humanId}`)"), false)
})

test('conversation employee settings skills tab reads and writes current profile Gateway skills', () => {
  const source = read('src/pages/Conversations.jsx')
  const panel = read('src/pages/conversations/InlineEmployeeSettingsPanel.jsx')

  assert.equal(panel.includes("import {\n  isSkillAssignable,\n  setSkillPresence,\n  skillStatus,\n  sourceLabel,\n} from '../../lib/skillAssignments'"), true)
  assert.equal(panel.includes('engineClient.agents.skillhubSnapshot({ profile: activeProfile })'), true)
  assert.equal(panel.includes('engineClient.agents.setSkills({'), true)
  assert.equal(panel.includes("invoke('openclaw_skillhub_snapshot'"), false)
  assert.equal(panel.includes("invoke('openclaw_agent_skills_set'"), false)
  assert.equal(panel.includes('agentId: employeeAgentId'), true)
  assert.equal(panel.includes('展示当前 Uniopc 引擎 profile/Gateway 已发现的 Skill；这里做员工分配，不安装 Skill。'), true)
  assert.equal(panel.includes("const [skillListMode, setSkillListMode] = useState('assigned')"), true)
  assert.equal(panel.includes("{ id: 'assigned', label: '已分配', count: selectedSkillNames.length }"), true)
  assert.equal(panel.includes("{ id: 'all', label: '全部', count: skills.length }"), true)
  assert.equal(panel.includes('当前员工真正可调用的 Skill'), true)
  assert.equal(source.includes('canManageSkillAssignments={Boolean(activeOpenClaw.isAdmin || activeOpenClaw.isOwner)}'), true)
  assert.equal(panel.includes('Skill 分配属于 Profile 员工管理动作，需要 Owner/Admin 在员工管理侧操作。'), true)
  assert.equal(panel.includes('分配给员工'), true)
  assert.equal(panel.includes('添加更多 Skill'), false)
  assert.equal(panel.includes('Skill 分配保留在员工设置视图中'), false)
  assert.equal(source.includes('onSkillsChanged={() => loadMentionResources({ silent: true })}'), true)
})

test('conversation page keeps structural dividers but removes noisy row lines', () => {
  const source = read('src/pages/Conversations.jsx')
  const layout = read('src/components/Layout.jsx')

  assert.equal(layout.includes("const contentIsFullBleed = location.pathname.startsWith('/conversations')"), true)
  assert.equal(layout.includes("contentIsFullBleed ? 'overflow-hidden p-0' : 'overflow-auto p-5'"), true)
  assert.equal(source.includes('relative grid h-full min-h-0 overflow-hidden bg-transparent lg:grid-cols-[240px_1px_minmax(0,1fr)]'), true)
  assert.equal(source.includes('<div className="hidden bg-subtle lg:block" />'), true)
  assert.equal(source.includes('absolute inset-x-0 top-16 z-10 h-px bg-subtle'), true)
  assert.equal(read('src/components/EmployeeListPane.jsx').includes('min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5 py-2'), true)
  assert.equal(read('src/components/EmployeeListPane.jsx').includes('group grid grid-cols-[minmax(0,1fr)_auto] items-stretch rounded-lg transition-colors'), true)
  assert.equal(read('src/components/EmployeeListPane.jsx').includes('grid min-w-0 grid-cols-[32px_minmax(0,1fr)] gap-2.5 px-2.5 py-3'), true)
  assert.equal(source.includes('left-[300px]'), false)
  assert.equal(source.includes('lg:border-r border-subtle'), false)
  assert.equal(source.includes('items-center justify-between border-b border-subtle'), false)
  assert.equal(source.includes('items-stretch border-b border-subtle'), false)
  assert.equal(source.includes('gap-3 border-b border-subtle px-3.5 py-3.5'), false)
})

test('employee avatars are one system: image → deliberate emoji → generated initial', () => {
  // 这条契约取代了旧的"AI 一律渲染成 🤖"。旧行为的实际效果是 9 位员工里
  // 5 个长得完全一样 —— 而"机器人"对一队 AI 员工不传达任何信息。
  const avatar = read('src/components/EmployeeAvatar.jsx')
  const identity = read('src/lib/avatarIdentity.js')

  // 剥掉注释再检查 —— 注释里会举 isAi/kind 作反例，不能算违规（这坑踩过两次）。
  const avatarCode = avatar
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')

  // 三级渲染优先级对 AI 与人类完全一致 —— 不再有旧的 isAi 渲染分叉。
  assert.equal(avatarCode.includes('deliberateEmoji'), true)
  assert.equal(avatarCode.includes('ui-avatar-generated'), true)
  assert.equal(avatarCode.includes('avatarInitial'), true)
  assert.equal(avatarCode.includes('isAi'), false)

  // kind 只决定形状（人圆 / AI 方），不决定画什么内容 —— 这不是复活分叉。
  assert.match(avatarCode, /const SHAPE_BY_KIND = \{\s*human:.*rounded-full.*ai:.*rounded/s)
  // kind 只在选形状时被读一次；此后的渲染分支（img / emoji / 生成块）不许再碰 kind。
  const afterShape = avatarCode.slice(avatarCode.indexOf('const base ='))
  assert.equal(/\bkind\b/.test(afterShape), false, 'kind 不该出现在渲染分支里，只用于选形状')

  // 占位 🤖 视为"没设过"，让存量员工回落到各自的首字母块
  assert.match(identity, /const PLACEHOLDER_EMOJI = new Set\(\['🤖'\]\)/)
  assert.equal(identity.includes('export function deliberateEmoji'), true)

  // 色相由名字哈希决定且必须稳定 —— 同一个人在任何位置都是同一个颜色
  assert.equal(identity.includes('export function avatarHue'), true)
  assert.equal(/Math\.random|Date\.now/.test(identity), false)
})

test('avatar hues avoid the semantic colour ranges', () => {
  // 头像色相撞上绿/橙/红会被误读成状态（成功/警告/危险）。
  // 锁在蓝—紫—品红一段（品牌紫 #8b31f5 约 268°）。
  const identity = read('src/lib/avatarIdentity.js')
  const match = identity.match(/const AVATAR_HUES = \[([^\]]+)\]/)
  assert.ok(match, '找不到 AVATAR_HUES')
  const hues = match[1].split(',').map(value => Number(value.trim()))
  assert.ok(hues.length >= 6, '色相太少会频繁撞色')
  for (const hue of hues) {
    assert.ok(hue >= 200 && hue <= 330, `色相 ${hue}° 落在语义色区间`)
  }
})

test('AI 员工的 emoji 不再被写入 🤖 默认值', () => {
  // 🤖 曾经是新建表单预填值和云端 RPC 兜底值，所以它是被存进数据的，
  // 不是渲染时才出现的 —— 这是 5 个员工撞脸的真正原因。
  const employees = read('src/pages/Employees.jsx')
  const cloud = read('src/lib/cloudWorkspace.js')
  assert.equal(employees.includes("emoji: '🤖'"), false)
  assert.equal(cloud.includes("|| '🤖'"), false)
})

test('project workspace pages are removed', () => {
  assert.equal(exists('src/pages/CloudWorkbench.jsx'), false)
  assert.equal(exists('src/pages/CloudProject.jsx'), false)
})

test('personal documents no longer expose project member or ACL controls', () => {
  const documents = read('src/pages/CloudDocuments.jsx')

  assert.equal(documents.includes('listCloudProjectMemberships'), false)
  assert.equal(documents.includes('projectId'), false)
  assert.equal(documents.includes('canChangeAccessMember'), false)
  assert.equal(documents.includes('document ACL'), false)
  assert.equal(documents.includes('文档仅归当前 Owner'), true)
})

test('ordinary employee app hides approved AI employee creation requests after they become employees', () => {
  const source = read('src/pages/Employees.jsx')
  const directory = read('src/pages/employees/EmployeeDirectoryPane.jsx')

  assert.equal(source.includes('visibleEmployeeRequests'), true)
  assert.equal(source.includes("request.status === 'pending' || request.status === 'failed'"), true)
  assert.equal(directory.includes("request.status === 'approved' ? '已批准'"), false)
  assert.equal(directory.includes('requests.length > 0'), true)
})

test('employee create action opens the AI employee form directly', () => {
  const source = read('src/pages/Employees.jsx')
  const detail = read('src/pages/employees/EmployeeDetailPane.jsx')

  assert.equal(source.includes('addChoiceOpen'), false)
  assert.equal(source.includes('setAddChoiceOpen'), false)
  assert.equal(source.includes('onCreate={openCreateModal}'), true)
  assert.equal(detail.includes('onClick={onCreate} className="mt-4'), true)
  assert.equal(source.includes("title={editing ? '编辑 AI 员工' : canManageAiEmployees ? '新建 AI 员工' : '申请创建 AI 员工'}"), true)
  assert.equal(source.includes("title={canManageAiEmployees ? '新增 AI 员工' : '申请创建 AI 员工'}"), false)
  assert.equal(source.includes('创建一个 Uniopc 引擎 agent，用模型、Skill 和渠道工作。'), false)
})

test('admin member detail exposes host profile plugin consistency actions', () => {
  const source = read('src/pages/AdminMemberDetail.jsx')
  assert.equal(source.includes('getMyWorkspacePluginPolicyBootstrap'), true)
  assert.equal(source.includes('checkProfilePluginConsistency'), true)
  assert.equal(source.includes('reconcileProfilePluginConsistency'), true)
  assert.equal(source.includes('statusProfileExists(status) === false'), true)
  assert.equal(source.includes('statusProfileExists(targetHostStatus) === false'), true)
  assert.equal(source.includes('Host 插件配置'), true)
  assert.equal(source.includes('组织插件'), true)
  assert.equal(source.includes('一键启用'), true)
  assert.equal(source.includes('检查配置'), false)
  assert.equal(source.includes('同步云端策略'), false)
})

test('admin plugin list is driven by organization entitlements and merged with local profile state', () => {
  const source = read('src/pages/AdminMemberDetail.jsx')

  assert.equal(source.includes('const localPluginById = new Map('), true)
  assert.equal(source.includes('const authorizedProfilePlugins = organizationPluginEntitlements'), true)
  assert.equal(source.includes('localPluginById.get(entitlement.pluginId)'), true)
  assert.equal(source.includes('pluginName'), true)
  assert.equal(source.includes('pluginDescription'), true)
})

test('admin plugin tab blocks host plugin actions until a profile exists', () => {
  const source = read('src/pages/AdminMemberDetail.jsx')
  const missingProfileGuardIndex = source.indexOf('!member.openclawProfile ?')
  const pluginPolicyIndex = source.indexOf('读取当前组织授权的插件')

  assert.notEqual(missingProfileGuardIndex, -1)
  assert.notEqual(pluginPolicyIndex, -1)
  assert.equal(source.includes('先创建 Uniopc 引擎 Profile'), true)
  assert.equal(missingProfileGuardIndex < pluginPolicyIndex, true)
})

test('admin plugin tab hides bridge and credential refresh implementation details', () => {
  const source = read('src/pages/AdminMemberDetail.jsx')

  assert.equal(source.includes('工具桥未开启'), false)
  assert.equal(source.includes('刷新凭证'), false)
  assert.equal(source.includes('运行凭证缺失'), false)
  assert.equal(source.includes('待同步'), false)
  assert.equal(source.includes('未就绪：请点击一键启用。'), true)
  assert.equal(source.includes("return isCloudAgentPlugin ? '未配置' : '配置缺失'"), true)
})

test('admin plugin row actions distinguish default global plugins from uninstalled plugins', () => {
  const source = read('src/pages/AdminMemberDetail.jsx')

  assert.equal(source.includes('function profilePluginActionLabel'), true)
  assert.equal(source.includes("return '配置并启用'"), true)
  assert.equal(source.includes("return '安装并启用'"), true)
  assert.equal(source.includes('组织默认授权'), true)
  assert.equal(source.includes('默认启用且不可关闭'), false)
  assert.equal(source.includes('全局插件默认对所有成员启用，当前不支持关闭。'), false)
  assert.equal(source.includes("profilePluginActionLabel(plugin, { global: true })"), false)
  assert.equal(source.includes("plugin.enabled ? '关闭' : '开启'"), false)
})

test('admin plugin row configures the selected plugin instead of reconciling every plugin', () => {
  const source = read('src/pages/AdminMemberDetail.jsx')
  const rowStart = source.indexOf('visibleProfilePlugins.map(plugin =>')
  const rowEnd = source.indexOf('</section>', rowStart)
  const rowSource = source.slice(rowStart, rowEnd)

  assert.notEqual(rowStart, -1)
  assert.notEqual(rowEnd, -1)
  assert.equal(rowSource.includes('reconcilePluginConsistency()'), false)
  assert.equal(rowSource.includes("toggleProfilePlugin(plugin, plugin.status === 'missing_env' || plugin.status === 'bridge_disabled' ? true : nextEnabled)"), true)
})

test('cloud agent host credential requests use the bounded trusted Rust route', () => {
  const source = read('src/lib/cloudWorkspacePluginAuth.js')
  const rust = read('src-tauri/src/commands/trusted_network.rs')

  assert.equal(source.includes("invoke('trusted_host_credential_issue'"), true)
  assert.equal(source.includes('new AbortController()'), false)
  assert.equal(rust.includes('.timeout(Duration::from_secs(15))'), true)
  assert.equal(rust.includes('.redirect(reqwest::redirect::Policy::none())'), true)
  assert.equal(rust.includes('client_for_route(NetworkRoute::Direct'), true)
  assert.equal(source.includes('Cloud Agent Host Credential 签发超时'), true)
})

test('macOS permissions live in the host system module instead of workspace settings', () => {
  const app = read('src/App.jsx')
  const layout = read('src/components/Layout.jsx')
  const settings = read('src/pages/Settings.jsx')
  const hostPermissions = read('src/pages/HostPermissions.jsx')
  const commands = read('src-tauri/src/commands/mod.rs')
  const lib = read('src-tauri/src/lib.rs')
  const service = read('src-tauri/src/services/mac_permissions.rs')
  const infoPlist = read('src-tauri/Info.plist')

  // 本机权限 is now a system-management link inside Settings (navigating to the
  // host-permissions module route); it no longer lives in the sidebar. The
  // permission LOGIC still lives only in HostPermissions.jsx — never embedded in
  // Settings (asserted by the mac_permissions checks below).
  assert.equal(layout.includes("label: '本机权限'"), false)
  assert.equal(settings.includes("label: '本机权限'"), true)
  assert.equal(settings.includes("route: 'host-permissions'"), true)
  assert.equal(layout.includes("label: 'Uniopc 引擎 版本'"), false)
  assert.equal(app.includes("const HostPermissions = lazyPage(() => import('./pages/HostPermissions'))"), true)
  assert.equal(app.includes('path="/profiles/:profileRef/host-permissions" element={profileWorkspaceElement(<HostPermissions />)}'), true)
  assert.equal(app.includes('path="/host-permissions" element={<ProfileWorkspaceRedirect childPath="host-permissions" />}'), true)
  assert.equal(app.includes('path="/settings/permissions" element={<ProfileWorkspaceRedirect childPath="host-permissions" />}'), true)
  assert.equal(app.includes('path="/profiles/:profileRef/settings/permissions" element={<ProfileWorkspaceRedirect childPath="host-permissions" />}'), true)
  assert.equal(settings.includes("id: 'permissions'"), false)
  assert.equal(settings.includes("invoke('mac_permissions_status'"), false)
  assert.equal(settings.includes("invoke('mac_permissions_request'"), false)
  assert.equal(hostPermissions.includes('本机权限'), true)
  assert.equal(hostPermissions.includes('这台 Mac'), true)
  assert.equal(hostPermissions.includes('macOS access for notifications, capture, voice, and device context.'), true)
  assert.equal(hostPermissions.includes("invoke('mac_permissions_status'"), true)
  assert.equal(hostPermissions.includes("invoke('mac_permissions_request'"), true)
  assert.equal(hostPermissions.includes('Automation (AppleScript)'), true)
  assert.equal(hostPermissions.includes('Screen Recording'), true)
  assert.equal(hostPermissions.includes('Speech Recognition'), true)
  assert.equal(commands.includes('pub mod mac_permissions;'), true)
  assert.equal(lib.includes('commands::mac_permissions::mac_permissions_status'), true)
  assert.equal(lib.includes('commands::mac_permissions::mac_permissions_request'), true)
  assert.equal(service.includes('UNUserNotificationCenter'), true)
  assert.equal(service.includes('AVCaptureDevice'), true)
  assert.equal(service.includes('SFSpeechRecognizer'), true)
  assert.equal(service.includes('CLLocationManager'), true)
  assert.equal(infoPlist.includes('NSMicrophoneUsageDescription'), true)
  assert.equal(infoPlist.includes('NSSpeechRecognitionUsageDescription'), true)
  assert.equal(infoPlist.includes('NSAppleEventsUsageDescription'), true)
})

test('workspace system controls live in the Settings 系统管理 section', () => {
  const layout = read('src/components/Layout.jsx')
  const settings = read('src/pages/Settings.jsx')

  assert.equal(layout.includes('const runtimeItems = ['), false)
  assert.equal(layout.includes('items: runtimeItems'), false)
  // The sidebar no longer builds a system group; 运行环境 / 本机权限 are now
  // system-management entries inside Settings that navigate to their routes.
  assert.equal(layout.includes('const workspaceSystemItems = ['), false)
  // Settings is reachable from the sidebar footer gear (JSX prop, not a nav item).
  assert.equal(layout.includes("to={profileRoutePath('settings')}"), true)
  assert.equal(settings.includes("title: '系统管理'"), true)
  assert.equal(settings.includes("route: 'environment'"), true)
  assert.equal(settings.includes("route: 'host-permissions'"), true)
  assert.equal(layout.includes("to: profileRoutePath('environment')"), false)
  assert.equal(layout.includes("to: profileRoutePath('host-permissions')"), false)
  assert.equal(layout.includes("to: profileRoutePath('openclaw-runtime')"), false)
  assert.equal(layout.includes('我的 Uniopc 引擎'), false)
  assert.equal(layout.includes("to: profileRoutePath('operations')"), false)
  assert.equal(layout.includes("to: profileRoutePath('models')"), false)
})

test('team management is removed from the personal desktop workspace', () => {
  const layout = read('src/components/Layout.jsx')
  const settings = read('src/pages/Settings.jsx')

  assert.equal(layout.includes('const adminReturnItems = ['), false)
  assert.equal(layout.includes("to: '/admin'"), false)
  assert.equal(layout.includes("label: '返回管理页面'"), false)
  assert.equal(layout.includes("to: profileRoutePath('team')"), false)
  assert.equal(layout.includes("label: '我的团队'"), false)
  assert.equal(settings.includes("label: '我的团队'"), false)
  assert.equal(settings.includes("route: 'team'"), false)
  assert.equal(layout.includes("title: '管理'"), false)
  assert.equal(layout.includes('group.title &&'), true)
  // The sidebar no longer renders a separate system nav group.
  assert.equal(layout.includes("title: t('nav.groupSystem')"), false)
})

test('personal desktop exposes no team or nested member modules', () => {
  const layout = read('src/components/Layout.jsx')
  const settings = read('src/pages/Settings.jsx')

  assert.equal(layout.includes("import { useAuth } from '../hooks/useAuth'"), true)
  assert.equal(layout.includes('listCloudOrganizationMembers'), false)
  assert.equal(layout.includes("label: '我的团队'"), false)
  assert.equal(settings.includes("label: '我的团队'"), false)
  assert.equal(layout.includes("label: t('nav.invite')"), false)
  assert.equal(layout.includes("to: '/invite'"), false)
  assert.equal(layout.includes('teamSidebarMembers'), false)
  assert.equal(layout.includes('const hasTeamChildren'), false)
  assert.equal(layout.includes('sidebar-parent-row'), false)
  assert.equal(layout.includes('expandedTeamMemberId'), false)
  assert.equal(layout.includes('expandedTeamMemberIds'), false)
  assert.equal(layout.includes('function activeTeamMemberIdFromPath'), false)
  assert.equal(layout.includes('const activeTeamMemberId = activeTeamMemberIdFromPath(location.pathname)'), false)
  assert.equal(layout.includes('sidebar-team-member-row'), false)
  assert.equal(layout.includes('sidebar-team-member-module'), false)
  assert.equal(layout.includes('function teamMemberModuleItems'), false)
  assert.equal(layout.includes('isTeamMemberModuleActive(module)'), false)
  assert.equal(layout.includes("to={teamMemberDetailPath(member)}"), false)
  assert.equal(layout.includes("navigate(teamMemberDetailPath(member, 'profile'))"), false)
  for (const label of ['Uniopc 引擎 Profile', '本机 Gateway', 'AI 员工', '插件管理']) {
    assert.equal(layout.includes(`label: '${label}'`), false)
  }
  assert.equal(layout.includes("label: t('nav.admin')"), false)
})

test('sidebar footer shows the signed-in user identity', () => {
  const layout = read('src/components/Layout.jsx')

  assert.equal(layout.includes("import { useAuth } from '../hooks/useAuth'"), true)
  assert.equal(layout.includes('function accountDisplayName'), true)
  assert.equal(layout.includes('function accountAvatarUrl'), true)
  assert.equal(layout.includes('function accountInitial'), true)
  assert.equal(layout.includes('const { user, profile } = useAuth()'), true)
  assert.equal(layout.includes('const accountName = accountDisplayName({ user, profile })'), true)
  assert.equal(layout.includes('const accountAvatar = accountAvatarUrl({ user, profile })'), true)
  assert.equal(layout.includes("to={profileRoutePath('settings/profile')}"), true)
  assert.equal(layout.includes('sidebar-account-row'), true)
  assert.equal(layout.includes('sidebar-account-avatar'), true)
  assert.equal(layout.includes('sidebar-account-name'), true)
  // 设计系统 v3：没设名字的人不再上下两行都显示邮箱，邮箱行已移除
  assert.equal(layout.includes('sidebar-account-email'), false)
  assert.equal(layout.includes('profile?.nickname'), true)
  assert.equal(layout.includes('profile?.avatar_url'), true)
  assert.equal(layout.includes('user?.email'), true)
})

test('admin member detail subscribes to workspace plugin policy version changes', () => {
  const source = read('src/pages/AdminMemberDetail.jsx')
  assert.equal(source.includes('subscribeWorkspacePolicyVersion'), true)
  assert.equal(source.includes('workspace.workspaceProfile?.organizationId'), true)
  assert.equal(source.includes('reconcilePluginConsistency'), true)
})

test('employee directory pages wait for workspace profile before reading local Uniopc 引擎 runtime', () => {
  const employees = read('src/pages/Employees.jsx')
  const conversations = read('src/pages/Conversations.jsx')

  assert.equal(employees.includes('shouldDeferOpenClawDirectoryHydration'), true)
  assert.equal(conversations.includes('shouldDeferOpenClawDirectoryHydration'), true)
  assert.equal(employees.includes('if (deferOpenClawDirectoryHydration)'), true)
  assert.equal(conversations.includes('if (deferOpenClawDirectoryHydration)'), true)
})

test('cloud documents are personal and do not render project permission state', () => {
  const source = read('src/pages/CloudDocuments.jsx')

  assert.equal(source.includes('listCloudProjectMemberships'), false)
  assert.equal(source.includes('projectAccessById'), false)
  assert.equal(source.includes('AccessAvatarGroup'), false)
  assert.equal(source.includes('project_id'), false)
  assert.equal(source.includes('文档仅归当前 Owner'), true)
})

test('telegram connector modal is removed from MCP hub', () => {
  const source = read('src/pages/McpHub.jsx')

  assert.equal(source.includes('telegram-connect'), false)
  assert.equal(source.includes('第 1 步：应用凭据'), false)
  assert.equal(source.includes('第 2 步：登录账号'), false)
  assert.equal(source.includes('showTelegramSecrets'), false)
  assert.equal(source.includes('openclaw_telegram_'), false)
})

test('app center does not expose bundled account connector presets', () => {
  const source = read('src/pages/McpHub.jsx')
  const config = read('src/lib/mcpConfig.js')

  assert.equal(source.includes('selectedSystemConnectorApp'), false)
  assert.equal(source.includes('CONNECTOR_APP_PRESETS'), false)
  assert.equal(source.includes('telegramAccounts'), false)
  assert.equal(config.includes('connectorAppsFromPluginManifests(BUNDLED_CONNECTOR_PLUGIN_MANIFESTS)'), false)
  assert.equal(config.includes('TELEGRAM_'), false)
})

test('app center does not keep account connector tabs or actions', () => {
  const source = read('src/pages/McpHub.jsx')

  assert.equal(source.includes("{ id: 'apps', label: '应用' }"), false)
  assert.equal(source.includes("useState('apps')"), false)
  assert.equal(source.includes("activeTab === 'apps'"), false)
  assert.equal(source.includes("hubMode === 'mcp' ? 'mine' : 'official'"), true)
  assert.equal(source.includes('selectedSystemConnectorApp'), false)
  assert.equal(source.includes('openTelegramConnectModal()'), false)
})

test('app center hosted plugin cards stay concise and use unified managed details', () => {
  const source = read('src/pages/McpHub.jsx')

  const systemCard = source.slice(
    source.indexOf('function SystemPluginCard'),
    source.indexOf('export default function McpHub'),
  )
  const pluginGrid = source.slice(
    source.indexOf('<PluginCatalogGrid'),
    source.indexOf("{activeTab === 'mine'"),
  )

  assert.equal(source.includes('function ToolPluginCard'), false)
  assert.equal(source.includes('selectedToolPlugin'), false)
  assert.equal(source.includes('openToolPluginDetails'), false)
  assert.equal(source.includes('openclaw_plugin_marketplace_install'), false)
  assert.equal(source.includes("marketDetailModal === 'tool-plugin'"), false)
  assert.equal(systemCard.includes('安装方式'), false)
  assert.equal(systemCard.includes('TikHub Key 配置'), false)
  assert.equal(pluginGrid.includes('preset.tags'), false)
  assert.equal(pluginGrid.includes('SystemPluginCard'), true)
  // 官方 tab 按场景分组渲染，第三方走同一 SystemPluginCard 分支。
  assert.equal(pluginGrid.includes("activeTab === 'third-party' ? ("), true)
  assert.equal(source.includes('selectedSystemPlugin'), true)
  assert.equal(source.includes('marketDetailModal'), true)
})

test('app center hosted plugin cards show compact visual icons without ClawHub branding', () => {
  const source = read('src/pages/McpHub.jsx')

  assert.equal(source.includes('function MarketplaceIcon'), true)
  assert.equal(source.includes('<MarketplaceIcon kind={iconKind} label={iconLabel || title} />'), true)
  assert.equal(source.includes('iconKind="imai"'), true)
  assert.equal(source.includes('iconKind="clawhub"'), false)
  assert.equal(source.includes('iconKind="mcp"'), false)
})

test('desktop titlebar navigation controls remain visible in overlay mode', () => {
  const layout = read('src/components/Layout.jsx')
  const updateControl = read('src/components/AppUpdateTitlebarControl.jsx')
  const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'))
  const capabilities = JSON.parse(read('src-tauri/capabilities/default.json'))
  const mainWindow = tauriConfig.app.windows[0]

  assert.equal(layout.includes("import { getCurrentWindow } from '@tauri-apps/api/window'"), true)
  assert.equal(layout.includes("import AppUpdateTitlebarControl from './AppUpdateTitlebarControl'"), true)
  assert.equal(layout.includes('function TitlebarIconButton'), true)
  assert.equal(layout.includes('function TitlebarUpdateButton({ status, onClick })'), false)
  assert.equal(layout.includes("const UPDATE_CHECK_CHANNEL = 'stable'"), true)
  assert.equal(layout.includes('getAppUpdateStatus({ channel: UPDATE_CHECK_CHANNEL })'), false)
  assert.equal(layout.includes('navigate(profileRoutePath('), false)
  assert.equal(layout.includes('function startWindowDrag(event)'), true)
  assert.equal(layout.includes('getCurrentWindow().startDragging()'), true)
  assert.equal(layout.includes('relative flex h-screen flex-col'), true)
  assert.equal(layout.includes('pointer-events-none absolute inset-x-0 top-0 z-[70] h-[36px] bg-transparent'), true)
  assert.equal(layout.includes('pointer-events-none absolute inset-x-0 top-0 z-[70] h-[56px] bg-transparent'), false)
  assert.equal(layout.includes('<main className="flex-1 overflow-hidden bg-surface-base pl-0 pr-3 pb-3 pt-[36px]">'), true)
  assert.equal(layout.includes('<main className="flex-1 overflow-hidden bg-surface-base px-3 pb-3 pt-[36px]">'), false)
  assert.equal(layout.includes('<main className="flex-1 overflow-hidden bg-surface-base px-3 pb-3 pt-[56px]">'), false)
  assert.equal(layout.includes('<main className="flex-1 overflow-hidden bg-surface-base p-3">'), false)
  assert.equal(layout.includes('data-tauri-drag-region'), true)
  assert.equal(layout.includes('onMouseDown={startWindowDrag}'), true)
  assert.equal(layout.includes('className="pointer-events-auto absolute inset-0 z-0"'), true)
  assert.equal(layout.includes("HAS_INAPP_WINDOW_CONTROLS ? 'left-[16px]' : 'left-[84px]'"), true)
  // Linux runs decorations: false like Windows, so it shares the in-app controls.
  assert.equal(layout.includes('const HAS_INAPP_WINDOW_CONTROLS = IS_WINDOWS || IS_LINUX'), true)
  assert.equal(layout.includes('{HAS_INAPP_WINDOW_CONTROLS && <WindowsWindowControls />}'), true)
  assert.equal(updateControl.includes("rightClassName = 'right-[18px]'"), true)
  assert.equal(updateControl.includes('${rightClassName} top-[12px] z-10'), true)
  assert.equal(layout.includes('channel={UPDATE_CHECK_CHANNEL}'), true)
  assert.equal(layout.includes('left-[76px]'), false)
  assert.equal(layout.includes('left-[152px]'), false)
  assert.equal(layout.includes('left-[118px]'), false)
  assert.equal(layout.includes('gap-3 md:flex'), true)
  assert.equal(layout.includes('inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-transparent'), true)
  assert.equal(layout.includes('<svg className="h-3.5 w-3.5"'), true)
  assert.equal(layout.includes('<svg className="h-4 w-4"'), true)
  assert.equal(layout.includes('text-tertiary'), true)
  assert.equal(layout.includes("title={collapsed ? '展开侧边栏' : '收起侧边栏'}"), true)
  assert.equal(layout.includes('title="上一页"'), true)
  assert.equal(layout.includes('title="下一页"'), true)
  assert.equal(capabilities.permissions.includes('core:window:allow-start-dragging'), true)
  assert.equal(mainWindow.title, '')
  assert.equal(mainWindow.hiddenTitle, true)
  assert.equal(mainWindow.titleBarStyle, 'Overlay')
  assert.deepEqual(mainWindow.trafficLightPosition, { x: 18, y: 18 })
  assert.equal(layout.includes('top-[56px]'), true)
  assert.equal(layout.includes('md:pt-[56px]'), true)
  assert.equal(layout.includes('md:pt-[78px]'), false)
  assert.equal(layout.includes('left-[88px]'), false)
  assert.equal(layout.includes('left-[104px]'), false)
  assert.equal(layout.includes('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-transparent'), false)
  assert.equal(layout.includes('h-7 w-7'), false)
  assert.equal(layout.includes('relative z-30 flex h-[32px] shrink-0'), false)
  assert.equal(layout.includes('<span className="text-[12px] leading-none">{label}</span>'), false)
})

test('desktop titlebar shows the current top-level menu name', () => {
  const layout = read('src/components/Layout.jsx')

  assert.equal(layout.includes('const currentTitle = deriveRouteTitle(location.pathname, flatNavItems, t)'), true)
  assert.equal(layout.includes('className={`pointer-events-auto absolute top-[8px] z-10 hidden max-w-[320px]'), true)
  assert.equal(layout.includes('title={currentTitle}'), true)
  assert.equal(layout.includes('{currentTitle}'), true)
  assert.equal(layout.includes("pathname.startsWith('/profiles/') && pathname.includes('/cloud-project/')"), true)
  assert.equal(layout.includes("pathname.startsWith('/profiles/') && pathname.includes('/cloud-documents')"), true)
})

test('workspace navigation keeps personal documents and conversations as distinct exact routes', () => {
  const layout = read('src/components/Layout.jsx')

  assert.match(layout, /to: profileRoutePath\('conversations'\),\s+label: t\('nav\.conversations'\),\s+exact: true/)
  assert.match(layout, /to: profileRoutePath\('cloud-documents'\),\s+label: t\('nav\.cloudDocuments'\),\s+exact: true/)
  assert.equal(layout.includes("profileRoutePath('cloud-workbench')"), false)
})

test('global titlebar update control is mounted in the shared shell and standalone setup pages', () => {
  const layout = read('src/components/Layout.jsx')
  const login = read('src/pages/Login.jsx')
  const setup = read('src/pages/OpenClawSetupGate.jsx')
  const createOrganization = read('src/pages/CreateOrganization.jsx')

  assert.equal(layout.includes("import AppUpdateTitlebarControl from './AppUpdateTitlebarControl'"), true)
  assert.equal(layout.includes('channel={UPDATE_CHECK_CHANNEL}'), true)
  assert.equal(layout.includes('function TitlebarUpdateButton({ status, onClick })'), false)

  assert.equal(login.includes("import AppUpdateTitlebarControl from '../components/AppUpdateTitlebarControl'"), true)
  assert.equal(login.includes('appUpdateSlot={<AppUpdateTitlebarControl />}'), true)

  assert.equal(setup.includes("import AppUpdateTitlebarControl from '../components/AppUpdateTitlebarControl'"), true)
  assert.equal(setup.includes('<AppUpdateTitlebarControl />'), true)

  assert.equal(createOrganization.includes("import AppUpdateTitlebarControl from '../components/AppUpdateTitlebarControl'"), true)
  assert.equal(createOrganization.includes('<AppUpdateTitlebarControl />'), true)
})

test('desktop login exposes only phone SMS authentication', () => {
  const login = read('src/pages/Login.jsx')

  assert.match(login, /requestPhoneOtp, verifyPhoneOtp/)
  assert.match(login, /手机号登录 \/ 注册/)
  assert.match(login, /验证并登录 \/ 注册/)
  assert.doesNotMatch(login, /signInWithEmail|signUpWithEmail|handleEmailSubmit|type="email"|密码/)
})

test('host app center keeps plugin marketplace catalogs and no member-client app-center branch', () => {
  const source = read('src/pages/McpHub.jsx')
  const layout = read('src/components/Layout.jsx')

  assert.equal(source.includes('isMemberClientAppCenter'), false)
  assert.equal(source.includes('isMemberClientAppMode'), false)
  assert.equal(source.includes('管理员还没有为你开通插件能力'), false)
  assert.equal(source.includes('buildEmployeeAppPlugins(profilePlugins'), false)
  assert.equal(source.includes('buildProfilePluginCapabilities(profilePlugins'), false)
  assert.equal(source.includes('listMyOrganizationPluginEntitlements'), true)
  assert.equal(source.includes('fetchTrustedPluginCatalog'), true)
  assert.equal(source.includes('listCloudPluginCatalog'), false)
  assert.equal(source.includes('organizationPluginEntitlements'), true)
  assert.equal(source.includes('cloudPluginCatalog'), true)
  assert.equal(source.includes('systemPlugins'), true)
  assert.equal(source.includes('thirdPartyPlugins'), true)
  assert.equal(source.includes('customPlugins'), true)
  assert.equal(source.includes('pluginEntitlementStatus'), true)
  assert.equal(source.includes('pluginGatewayStatus'), true)
  assert.equal(layout.includes("label: t('nav.plugins')"), true)
  assert.equal(layout.includes('isMemberClientApp'), false)
})

test('app center plugin catalog is loaded from cloud catalog without local preset fallback', () => {
  const hub = read('src/pages/McpHub.jsx')

  assert.equal(hub.includes("} from '../lib/cloudWorkspace'"), true)
  assert.equal(hub.includes('fetchTrustedPluginCatalog,'), true)
  assert.equal(hub.includes('listCloudPluginCatalog,'), false)
  assert.equal(hub.includes('listMyOrganizationPluginEntitlements,'), true)
  assert.equal(hub.includes('SYSTEM_TOOL_PLUGIN_PRESETS'), false)
  assert.equal(hub.includes('TOOL_MARKET_PLUGIN_PRESETS'), false)
  assert.equal(hub.includes('loadCloudPluginCatalog'), true)
  assert.equal(hub.includes("catalogSection === 'third-party'"), true)
  assert.equal(hub.includes("catalogSection !== 'third-party'"), true)
})

test('desktop combines plugin and MCP under one sidebar menu with top switch', () => {
  const app = read('src/App.jsx')
  const layout = read('src/components/Layout.jsx')
  const source = read('src/pages/McpHub.jsx')
  const zh = read('src/locales/zh.json')
  const en = read('src/locales/en.json')

  assert.equal(app.includes('<Route path="/plugins" element={<McpHub mode="plugins" />}'), true)
  assert.equal(app.includes('<Route path="/mcphub" element={<McpHub mode="mcp" />}'), true)
  assert.equal(layout.includes("to: '/plugins'"), true)
  assert.equal(layout.includes("to: '/mcphub'"), false)
  assert.equal(layout.includes("pathname.startsWith('/mcphub')"), true)
  assert.equal(layout.includes("to: profileRoutePath('plugins')"), false)
  assert.equal(layout.includes("to: profileRoutePath('mcphub')"), false)
  assert.equal(layout.includes("label: t('nav.plugins')"), true)
  assert.equal(layout.includes("label: t('nav.mcp')"), false)
  assert.equal(source.includes("export default function McpHub({ appMode = APP_MODES.HOST, mode = 'plugins' })"), true)
  assert.equal(source.includes('const hubMode = mode'), true)
  assert.equal(source.includes('const HUB_MODE_TABS = ['), true)
  assert.equal(source.includes("{ id: 'plugins', label: '插件', childPath: 'plugins' }"), true)
  assert.equal(source.includes("{ id: 'mcp', label: 'MCP', childPath: 'mcphub' }"), true)
  assert.equal(source.includes('function switchHubMode(nextMode)'), true)
  assert.equal(source.includes("{ id: 'official', label: '官方'"), true)
  assert.equal(source.includes("{ id: 'third-party', label: '第三方'"), true)
  assert.equal(source.includes("{ id: 'custom', label: '自定义'"), true)
  assert.equal(source.includes("hubMode === 'mcp' ? ['mine'] : PLUGIN_TABS.map(tab => tab.id)"), true)
  assert.equal(zh.includes('"plugins": "插件"'), true)
  assert.equal(zh.includes('"mcp": "MCP"'), true)
  assert.equal(en.includes('"plugins": "Plugins"'), true)
  assert.equal(en.includes('"mcp": "MCP"'), true)
})

test('plugin and MCP pages use the active workspace Uniopc 引擎 profile', () => {
  const source = read('src/pages/McpHub.jsx')
  const skillhub = read('src/pages/Skillhub.jsx')

  assert.equal(source.includes('const profileWorkspace = useProfileWorkspace()'), true)
  assert.equal(source.includes("const activeProfile = profileWorkspace ? profileWorkspace.activeProfile : activeOpenClaw.activeProfile || ''"), true)
  assert.equal(source.includes('const gatewayPort = profileWorkspace ? profileWorkspace.gatewayPort : workspaceProfile?.gatewayPort || workspaceProfile?.gateway_port || null'), true)
  assert.equal(source.includes('getGatewayConnectionSnapshot(activeProfile, gatewayPort)'), true)
  assert.equal(source.includes('refreshGatewayConnectionSnapshot'), true)
  assert.equal(source.includes('runtime.gatewayConnection.snapshots[activeProfile]'), false)
  assert.equal(source.includes('if (activeOpenClaw.loading || !activeProfile)'), true)
  assert.equal(source.includes('}, [canManageMcpServers, activeOpenClaw.loading, activeProfile, gatewayPort])'), true)
  assert.equal(source.includes('const gatewayConnected = isGatewayConnectionReady(connectionSnapshot)'), true)
  assert.equal(source.includes("snapshot?.status !== 'connected'"), false)
  assert.equal(source.includes('const readiness = getGatewayConnectionReadiness(snapshot)'), true)
  assert.equal(source.includes('if (!getGatewayConnectionReadiness(latestConnectionSnapshot).ready)'), true)
  assert.equal(source.includes('profileGatewayStatus'), false)
  assert.equal(source.includes('gateway_running'), false)
  assert.equal(skillhub.includes("import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'"), true)
  assert.equal(skillhub.includes('const activeOpenClaw = useActiveOpenClawProfile()'), true)
  assert.equal(skillhub.includes("const activeProfile = activeOpenClaw.activeProfile || ''"), true)
  assert.equal(skillhub.includes('if (activeOpenClaw.loading || !activeProfile) return'), true)
})

test('frontend does not fall back to the legacy imai Uniopc 引擎 profile', () => {
  const files = [
    'src/hooks/useActiveOpenClawProfile.jsx',
    'src/pages/Conversations.jsx',
    'src/pages/Employees.jsx',
    'src/pages/ModelSettings.jsx',
    'src/pages/OpenClawSetupGate.jsx',
    'src/pages/Operations.jsx',
    'src/pages/Skillhub.jsx',
    'src/lib/cloudWorkspacePluginAuth.js',
    'src/lib/openclawEmployees.js',
  ]

  for (const file of files) {
    const source = read(file)
    assert.equal(source.includes('DEFAULT_OPENCLAW_PROFILE'), false, `${file} must not import/use DEFAULT_OPENCLAW_PROFILE`)
    assert.equal(source.includes("|| 'imai'"), false, `${file} must not fall back to imai`)
    assert.equal(source.includes("|| \"imai\""), false, `${file} must not fall back to imai`)
    assert.equal(source.includes("profile = 'imai'"), false, `${file} must not default arguments to imai`)
  }
})

test('conversation plugin mentions only expose Gateway discovered plugin tools', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes("import { buildProfilePluginCapabilities } from '../lib/appCenterPlugins'"), false)
  assert.equal(source.includes('const CONVERSATION_PLUGIN_CATALOG = ['), false)
  assert.equal(source.includes("import { SYSTEM_TOOL_PLUGIN_PRESETS, TOOL_MARKET_PLUGIN_PRESETS } from '../lib/mcpConfig'"), false)
  assert.equal(source.includes("invoke('openclaw_profile_plugins_list'"), false)
  assert.equal(source.includes('plugins: buildProfilePluginCapabilities(profilePlugins, CONVERSATION_PLUGIN_CATALOG)'), false)
  assert.equal(source.includes('plugins: []'), true)
  assert.equal(source.includes('plugins: [...SYSTEM_TOOL_PLUGIN_PRESETS, ...TOOL_MARKET_PLUGIN_PRESETS]'), false)
  assert.equal(source.includes('filterPluginMentionOptionsByProfile(options'), false)
})

test('conversation slash menu uses tool capabilities and sends structured invocations', () => {
  const conversations = read('src/pages/Conversations.jsx')
  const client = read('src/lib/conversations/client.js')
  const engineClient = read('src/lib/engine/client.js')
  const lib = read('src-tauri/src/lib.rs')
  const agents = read('src-tauri/src/commands/openclaw_agents.rs')

  assert.equal(conversations.includes('engineClient.plugins.listToolCapabilities({ profile: activeProfile })'), true)
  assert.equal(conversations.includes("invoke('openclaw_profile_tool_capabilities_list'"), false)
  assert.equal(conversations.includes('MENTION_TOOL_CAPABILITY_TIMEOUT_MS'), false)
  assert.equal(engineClient.includes('listToolCapabilities: commandMethod(call, ENGINE_COMMANDS.plugins.listToolCapabilities, RESOURCE_READ_TIMEOUT_MS)'), true)
  assert.equal(conversations.includes('toolInvocations'), true)
  assert.equal(conversations.includes('option.toolName'), true)
  assert.equal(conversations.includes('plugin.tools.map'), false)
  assert.equal(conversations.includes('const toolOptions = Array.isArray(plugin.tools)'), false)
  assert.equal(conversations.includes('`${plugin.id}.${tool.name}`'), false)
  assert.equal(conversations.includes('可调用 Uniopc 引擎 Plugin Tool'), false)
  assert.equal(conversations.includes("mentionQuery.trigger === 'slash'"), true)
  assert.equal(conversations.includes('mentionResourcesLoading'), true)
  assert.equal(conversations.includes('shouldRefreshSlashMentionResources({'), true)
  assert.equal(conversations.includes('正在读取当前员工 / profile 的 Skill、Plugin、MCP、项目和文档'), true)
  assert.equal(conversations.includes('const activeEmployeeAgentId = activeEmployee?.openclawAgentId || activeEmployee?.id ||'), true)
  assert.equal(conversations.includes('activeEmployee?.openclaw_agent_id'), false)
  assert.equal(conversations.includes('skillSnapshot?.agents'), true)
  // 技能可见性过滤已下沉到 lib/conversationMentions.selectAgentVisibleSkills
  assert.equal(conversations.includes('selectAgentVisibleSkills(profileSkills, assignedSkillNames, toolPlugins)'), true)
  assert.equal(read('src/lib/conversationMentions.js').includes('if (skill.disabled || skill.eligible === false) return false'), true)
  assert.equal(conversations.includes('/ 调用已就绪能力'), true)
  assert.equal(agents.includes('let skills = load_openclaw_skills(profile_ref).await?;'), true)
  assert.equal(agents.includes('load_openclaw_agents(&app, profile_ref)'), true)
  assert.equal(client.includes('toolInvocations = []'), true)
  assert.equal(client.includes('toolInvocations,'), true)
  assert.equal(lib.includes('openclaw_profile_tool_capabilities_list'), true)
})

test('conversation slash menu does not mutate Uniopc 引擎 plugin config while listing capabilities', () => {
  const conversations = read('src/pages/Conversations.jsx')

  assert.equal(conversations.includes("import { cloudWorkspacePluginSetRequest } from '../lib/cloudWorkspacePluginAuth'"), false)
  assert.equal(conversations.includes('ensureFoundationSlashPluginReady(toolPlugins)'), false)
  assert.equal(conversations.includes("invoke('openclaw_profile_plugin_set'"), false)
  assert.equal(conversations.includes('req: await cloudWorkspacePluginSetRequest(activeProfile)'), false)
})

test('workspace plugin center opens managed details before enabling hosted Cloud Agent plugins', () => {
  const hub = read('src/pages/McpHub.jsx')

  assert.equal(hub.includes("from '../lib/cloudWorkspacePluginAuth'"), true)
  assert.equal(hub.includes('cloudAgentRuntimePluginId'), true)
  assert.equal(hub.includes('currentCloudAgentRuntimeAuthEnv'), true)
  assert.equal(hub.includes('isCloudAgentPluginId'), true)
  assert.equal(hub.includes('isCloudAgentRuntimeIssuerUnavailableError'), false)
  assert.equal(hub.includes('engineClient.plugins.setProfile({'), true)
  assert.equal(hub.includes('engineClient.plugins.listSupported()'), true)
  assert.equal(hub.includes("invoke('openclaw_profile_plugin_set'"), false)
  assert.equal(hub.includes("invoke('openclaw_supported_plugins_list'"), false)
  assert.equal(hub.includes('resolvePluginReadiness'), true)
  assert.equal(hub.includes('const readiness = resolvePluginReadiness'), true)
  assert.equal(hub.includes('supportedRuntimePluginIds'), true)
  assert.equal(hub.includes('const { installPluginId, runtimePluginId: declaredRuntimePluginId } = resolveCloudPluginLifecycleIds(preset)'), true)
  assert.equal(hub.includes('pluginIds: [runtimePluginId]'), true)
  assert.equal(hub.includes('pluginId: installPluginId'), true)
  assert.equal(hub.includes('await refreshProfilePluginStatusFromLocal()'), true)
  assert.equal(hub.includes('onDetails={openSystemPluginDetails}'), true)
  assert.equal(hub.includes('runSystemPluginPrimaryAction(selectedSystemPlugin)'), true)
  assert.equal(hub.includes("primaryAction === 'open_management'"), true)
  assert.equal(hub.includes('if (preset.managementRoute) {\n      navigateSystemPluginManagementRoute(preset)\n      return\n    }'), false)
  assert.equal(hub.includes('openSystemPluginDetails(preset) {\n    if (!preset?.id) return\n    setSelectedSystemPluginId(preset.id)'), true)
  assert.equal(hub.includes('navigateSystemPluginManagementRoute(preset)'), true)
  assert.equal(hub.includes('授权状态 / 配置状态 / 运行状态'), false)
  assert.equal(hub.includes('主按钮会变成“打开”'), false)
  assert.equal(hub.includes('该类插件不需要写入 Uniopc 引擎 profile，也不需要 Gateway 启用。'), false)
  assert.equal(hub.includes('启用后系统会为当前 Host Profile'), false)
  assert.equal(hub.includes('selectedSystemPluginLifecycle?.busyLabel'), true)
  assert.equal(hub.includes('selectedSystemPluginLifecycle?.primaryLabel'), true)
  assert.equal(hub.includes('uninstallSystemPlugin(selectedSystemPlugin)'), true)
  assert.equal(hub.includes('selectedSystemPluginLifecycle.uninstallLabel'), true)
  assert.equal(hub.includes('resetSystemPluginCredential(selectedSystemPlugin)'), false)
  assert.equal(hub.includes("selectedSystemPlugin.gatewayState === 'ready' && ("), false)
  assert.equal(hub.includes('const managedPlugins = useMemo('), true)
  assert.equal(hub.includes('managedPlugins.find(preset => preset.id === selectedSystemPluginId)'), true)
  assert.equal(hub.includes("activeTab === 'official' ? ("), true)
  assert.equal(hub.includes("activeTab === 'third-party' ? ("), true)
  assert.equal(hub.includes('isCloudAgentHostCredentialAlreadyExistsError'), false)
  assert.equal(hub.includes('setConfirmResetPluginId(preset.id)'), false)
  assert.equal(hub.includes('confirmResetPluginId === selectedSystemPlugin.id ? ACTION.primary : ACTION.secondary'), false)
  assert.equal(hub.includes('confirmResetPluginId !== selectedSystemPlugin.id && ('), false)
  assert.equal(hub.includes('resetHostCredential: true'), true)
  assert.equal(hub.includes('confirmResetPluginId'), false)
  assert.equal(hub.includes('确认重置'), false)
  assert.equal(hub.includes('window.confirm(`重置'), false)
  assert.equal(hub.includes("selectedSystemPlugin.gatewayState === 'ready'"), false)
  assert.equal(hub.includes('重置授权凭证'), false)
  assert.equal(hub.includes('重新授权并启用'), true)
  assert.equal(hub.includes('span className="h-2 w-2 rounded-full'), false)
  assert.equal(hub.includes('<MarketplaceIcon kind="imai" label={selectedSystemPlugin.title.replace(/^Uniopc\\s*/, \'\')} />'), false)
  assert.equal(hub.includes('连接 {selectedSystemPlugin.title}'), true)
  assert.equal(hub.includes("pluginEntitlementStatus(selectedSystemPlugin, organizationPluginEntitlements).label"), true)
  assert.equal(hub.includes('当前状态'), true)
  assert.equal(hub.includes('selectedSystemPlugin.statusItems'), true)
  assert.equal(hub.includes('...readiness.statusItems'), true)
  assert.equal(hub.includes('Gateway 连接'), true)
  assert.equal(hub.includes('gatewayConnected ? \'已连接\' : \'未连接\''), true)
  assert.equal(hub.includes('如何让插件可用'), false)
  assert.equal(hub.includes('一切由你掌控'), false)
  assert.equal(hub.includes('应用可能带来较高风险'), false)
  assert.equal(hub.includes('与此应用共享的数据'), false)
  assert.equal(hub.includes('actionBusy'), true)
  assert.equal(hub.includes('配置并启用'), true)
  assert.equal(hub.includes('刷新 Runtime Token'), false)
  assert.equal(hub.includes('运行端通过 Gateway 使用已配置好的插件能力'), false)
})

test('workspace plugin detail only shows checking state before the current profile snapshot exists', () => {
  const hub = read('src/pages/McpHub.jsx')

  assert.equal(hub.includes('const hasCurrentProfilePluginSnapshot = Boolean('), true)
  assert.equal(hub.includes('checkingGateway: loadingProfilePlugins && !hasCurrentProfilePluginSnapshot'), true)
})

test('workspace plugin center uses Gateway tool capabilities as the runtime availability source', () => {
  const hub = read('src/pages/McpHub.jsx')

  assert.equal(hub.includes("invoke('openclaw_profile_tool_capabilities_list'"), false)
  assert.equal(hub.includes('setProfileToolCapabilitiesSnapshot(report?.capabilities || null)'), true)
  assert.equal(hub.includes('const toolCapability = pluginCapabilityById.get(installPluginId) || null'), true)
  // 直接采用网关上报的 status,不按工具数量二次推导——"零工具是否异常"只有
  // Rust 侧知道(未声明工具的插件本就该零工具)。前端推导曾把技能包与角色
  // 模板包误判成"运行异常"。
  assert.equal(hub.includes("const toolCapabilityState = toolCapability?.status || ''"), true)
  assert.equal(hub.includes('toolCapabilityState,'), true)
  assert.equal(hub.includes('toolCapabilityLabel: toolCapabilityStatusLabel(toolCapability),'), true)
})

test('workspace plugin center imports React hooks used by tool capability checks', () => {
  const hub = read('src/pages/McpHub.jsx')

  assert.match(hub, /^import \{[^}]*\buseCallback\b[^}]*\} from 'react'/m)
  assert.equal(hub.includes('const toolCapabilityStatusLabel = useCallback('), true)
})

test('workspace plugin center forwards cloud business health from Gateway capabilities', () => {
  const hub = read('src/pages/McpHub.jsx')

  assert.equal(hub.includes('businessHealthState: toolCapability?.businessHealthState ||'), true)
  assert.equal(hub.includes('businessHealthLabel: toolCapability?.businessHealthLabel ||'), true)
})

test('plugin hub loads cached cloud observations before local doctor checks', () => {
  const hub = read('src/pages/McpHub.jsx')
  const workspace = read('src/lib/cloudWorkspace.js')

  assert.equal(workspace.includes('export function buildCachedProfilePluginSnapshot'), true)
  assert.equal(hub.includes('buildCachedProfilePluginSnapshot'), true)
  assert.equal(hub.includes('function applyCachedProfilePluginSnapshot(profile, catalog)'), true)
  assert.equal(hub.includes('if (current && String(current.profile || \'\').trim() === profileKey) return current'), true)
  assert.equal(hub.includes('listCloudProfilePluginAssignments'), false)
  assert.equal(hub.includes('mergeCloudPluginCatalogObservations'), false)
  assert.equal(hub.includes('reportCloudProfilePluginObservation'), true)
  assert.equal(hub.includes('report_cloud_profile_plugin_observation'), false)
  assert.equal(hub.includes('async function refreshProfilePluginStatusFromLocal()'), true)
  assert.equal(hub.includes('loadProfilePluginStatus()'), false)
  assert.equal(hub.includes('refreshProfilePluginStatusFromLocal()'), true)
  assert.equal(hub.includes('loadProfilePluginStatus({ local: true })'), false)
})

testBackendSourceContract('plugin marketplace catalog rpc carries cached local observation columns', () => {
  const sql = read('supabase/migrations/202607010001_plugin_local_cache_and_roles.sql')

  assert.match(sql, /update public\.cloud_openclaw_profiles\s+set runtime_mode = 'member_local'/)
  assert.match(sql, /member_role in \('owner', 'member'\)/)
  assert.match(sql, /member_role = 'admin'/)
  assert.match(sql, /create or replace function public\.is_cloud_org_admin/)
  assert.doesNotMatch(sql, /member_role in \('owner', 'admin'\)/)
  assert.match(sql, /returns table \([\s\S]*observed_status text[\s\S]*observed_version text[\s\S]*drift_status text[\s\S]*observed_at timestamptz/)
  assert.match(sql, /left join public\.cloud_profile_plugin_assignments a/)
  assert.match(sql, /a\.openclaw_profile_id = v_profile_id/)
})

test('workspace plugin center folds host credential repair into the primary enable action', () => {
  const hub = read('src/pages/McpHub.jsx')
  const branchStart = hub.indexOf('isCloudAgentPluginId(preset.id) && isCloudAgentHostCredentialResetRequiredError(err)')
  assert.notEqual(branchStart, -1, 'missing host credential already-exists branch')
  const branchBody = hub.slice(branchStart, hub.indexOf('} finally {', branchStart))

  assert.match(branchBody, /applySystemPluginSetup\(preset, \{ resetHostCredential: true(?:, \.\.\.connectorRetry)? \}\)/)
  assert.match(branchBody, /重新授权并启用/)
  assert.match(branchBody, /return/)
})

test('conversation slash mentions preserve MCP and Skill invocations', () => {
  const conversations = read('src/pages/Conversations.jsx')

  assert.equal(conversations.includes('const slashInvocations = extractConversationToolInvocations(text)'), true)
  assert.equal(conversations.includes('...slashInvocations.map'), true)
  assert.equal(conversations.includes("invocation.kind === 'plugin'"), true)
  assert.equal(conversations.includes('kind: invocation.kind,'), true)
  assert.equal(conversations.includes('name: invocation.name,'), true)
})

test('Uniopc 引擎 model settings use official Gateway boundaries without legacy local model config', () => {
  const lib = read('src-tauri/src/lib.rs')
  const services = read('src-tauri/src/services/mod.rs')
  const modelSettings = read('src/pages/ModelSettings.jsx')
  const openclawModels = read('src/lib/openclawModels.js')
  const runtimeCommands = read('src-tauri/src/commands/model/runtime.rs')
  const modelCommands = read('src-tauri/src/commands/model/models.rs')
  const profileCommands = read('src-tauri/src/commands/model/profiles.rs')

  for (const command of [
    'model_list_configs',
    'model_save_config',
    'model_delete_config',
    'model_test_connection',
  ]) {
    assert.equal(lib.includes(`commands::model::${command}`), false, `${command} should not be registered`)
    assert.equal(modelSettings.includes(`'${command}'`), false, `${command} should not be invoked by ModelSettings`)
  }

  assert.equal(services.includes('pub mod model;'), false)
  assert.equal(exists('src-tauri/src/services/model.rs'), false)
  assert.equal(exists('src-tauri/src/commands/model.rs'), false)
  assert.equal(exists('src-tauri/src/commands/model/mod.rs'), true)
  assert.equal(exists('src-tauri/src/commands/model/runtime.rs'), true)
  assert.equal(exists('src-tauri/src/commands/model/models.rs'), true)
  assert.equal(exists('src-tauri/src/commands/model/profiles.rs'), true)
  assert.equal(runtimeCommands.includes('#[tauri::command]'), true)
  assert.equal(runtimeCommands.includes('pub async fn openclaw_status'), true)
  assert.equal(runtimeCommands.includes('pub async fn openclaw_install'), true)
  assert.equal(modelCommands.includes('#[tauri::command]'), true)
  assert.equal(modelCommands.includes('pub async fn openclaw_models_snapshot'), true)
  assert.equal(modelCommands.includes('pub async fn openclaw_use_provider_api_key_model'), true)
  for (const retired of [
    'MODEL_SETUP_OPTIONS',
    '切换对话模型来源',
    'API Key',
    "invoke('openclaw_use_openai_api_model'",
    "invoke('openclaw_use_provider_api_key_model'",
    "invoke('openclaw_login_openai_codex'",
    "invoke('openclaw_login_minimax_oauth'",
  ]) assert.equal(modelSettings.includes(retired), false, `${retired} should not be exposed by model settings`)
  assert.equal(modelSettings.includes('connectUniopcOfficialModel'), true)
  assert.equal(profileCommands.includes('#[tauri::command]'), true)
  assert.equal(profileCommands.includes('pub(crate) async fn openclaw_profile_provision'), true)
  assert.equal(profileCommands.includes('pub async fn openclaw_profile_status'), true)
  assert.equal(openclawModels.includes('custom-openai-compatible'), false)
  assert.equal(openclawModels.includes('custom_openai_compatible'), false)
  assert.equal(modelSettings.includes('工具模型配置'), false)
  assert.equal(modelSettings.includes('toolForm'), false)
  assert.equal(modelSettings.includes('toolConfigs'), false)
  assert.equal(modelSettings.includes('toolHealth'), false)
})

test('Rust command facades own their runtime, model, and plugin implementations', () => {
  const modelRoot = read('src-tauri/src/commands/model/mod.rs')
  const runtime = read('src-tauri/src/commands/model/runtime.rs')
  const models = read('src-tauri/src/commands/model/models.rs')
  const pluginRoot = read('src-tauri/src/commands/openclaw_plugins.rs')
  const plugins = read('src-tauri/src/commands/openclaw_plugins/plugins.rs')

  for (const implementation of [
    'openclaw_install_impl',
    'openclaw_start_gateway_impl',
    'openclaw_stop_gateway_impl',
    'openclaw_update_impl',
    'openclaw_uninstall_impl',
  ]) {
    assert.equal(runtime.includes(`fn ${implementation}`), true, `${implementation} must live in runtime.rs`)
    assert.equal(modelRoot.includes(`fn ${implementation}`), false, `${implementation} must leave model/mod.rs`)
    assert.equal(runtime.includes(`super::${implementation}`), false, `${implementation} facade must call its local body`)
  }
  assert.equal(runtime.includes('fn try_install_bundled_openclaw_runtime'), true)
  assert.equal(runtime.includes('fn stop_gateway_for_profile_under_shutdown_guard'), true)
  for (const helper of [
    'shell_output_streaming',
    'ensure_openclaw_gateway_started',
    'bundled_runtime_pending_activation',
    'build_openclaw_update_status',
  ]) {
    assert.equal(runtime.includes(`fn ${helper}`), true, `${helper} must live in runtime.rs`)
    assert.equal(modelRoot.includes(`fn ${helper}`), false, `${helper} must leave model/mod.rs`)
  }

  for (const implementation of [
    'openclaw_use_provider_api_key_model_impl',
    'openclaw_use_custom_openai_model_impl',
    'openclaw_use_uniopc_official_model_impl',
    'openclaw_use_openai_api_model_impl',
    'openclaw_login_openai_codex_impl',
    'openclaw_login_minimax_oauth_impl',
  ]) {
    assert.equal(models.includes(`fn ${implementation}`), true, `${implementation} must live in models.rs`)
    assert.equal(modelRoot.includes(`fn ${implementation}`), false, `${implementation} must leave model/mod.rs`)
    assert.equal(models.includes(`super::${implementation}`), false, `${implementation} facade must call its local body`)
  }
  assert.equal(models.includes('fn finish_openai_codex_login_with_synced_official_auth'), true)
  for (const helper of [
    'ensure_openclaw_default_model_for_profile',
    'launch_terminal_command',
    'sync_official_codex_auth_if_available',
    'openclaw_ready_model_refs_for_profile',
  ]) {
    assert.equal(models.includes(`fn ${helper}`), true, `${helper} must live in models.rs`)
    assert.equal(modelRoot.includes(`fn ${helper}`), false, `${helper} must leave model/mod.rs`)
  }

  for (const implementation of [
    'openclaw_profile_plugins_list_impl',
    'openclaw_supported_plugins_list_impl',
    'uniopc_plugin_lifecycle_prepare_impl',
    'uniopc_plugin_lifecycle_commit_impl',
    'uniopc_plugin_lifecycle_cancel_impl',
    'uniopc_cloud_plugin_uninstall_impl',
    'openclaw_profile_plugin_doctor_check_impl',
    'openclaw_profile_tool_capabilities_list_impl',
    'openclaw_profile_plugin_set_impl',
    'openclaw_profile_plugin_reconcile_impl',
    'uniopc_plugin_grants_write_impl',
  ]) {
    assert.equal(plugins.includes(`fn ${implementation}`), true, `${implementation} must live in plugins.rs`)
    assert.equal(pluginRoot.includes(`fn ${implementation}`), false, `${implementation} must leave openclaw_plugins.rs`)
    assert.equal(plugins.includes(`super::${implementation}`), false, `${implementation} facade must call its local body`)
  }
  for (const helper of [
    'normalize_profile',
    'plugin_paths_for_app',
    'tool_capabilities_for_profile',
  ]) {
    assert.equal(plugins.includes(`fn ${helper}`), true, `${helper} must live in plugins.rs`)
    assert.equal(pluginRoot.includes(`fn ${helper}`), false, `${helper} must leave openclaw_plugins.rs`)
  }
})

test('Uniopc 引擎 model command data contracts live outside the model command root', () => {
  const modelRoot = read('src-tauri/src/commands/model/mod.rs')

  assert.equal(exists('src-tauri/src/commands/model/types.rs'), true)
  const types = read('src-tauri/src/commands/model/types.rs')

  assert.equal(modelRoot.includes('mod types;'), true)
  assert.equal(modelRoot.includes('pub struct OpenClawStatus'), false)
  assert.equal(modelRoot.includes('pub struct OpenClawModelsSnapshot'), false)
  assert.equal(modelRoot.includes('pub struct OpenClawProfileProvisionRequest'), false)
  assert.equal(modelRoot.includes('struct OpenClawGatewayStatus'), false)

  for (const contract of [
    'pub struct OpenClawStatus',
    'pub struct OpenClawSetupProgress',
    'pub struct OpenClawInstallResult',
    'pub struct OpenClawModelsSnapshot',
    'pub(crate) struct OpenClawGatewayStatus',
    'pub struct OpenClawProfileProvisionRequest',
    'pub struct OpenClawProfileStatusResult',
  ]) {
    assert.equal(types.includes(contract), true, `missing model command contract: ${contract}`)
  }
})

test('member profile provisioning injects cloud workspace auth for the default workspace plugin', () => {
  const admin = read('src/pages/Admin.jsx')
  const detail = read('src/pages/AdminMemberDetail.jsx')
  const hub = read('src/pages/McpHub.jsx')
  const auth = read('src/lib/cloudWorkspacePluginAuth.js')
  const rustPlugins = read('src-tauri/src/commands/openclaw_plugins.rs')
  const rustModel = read('src-tauri/src/commands/model/mod.rs')

  assert.equal(auth.includes('currentCloudAgentRuntimeAuthEnv'), true)
  assert.equal(auth.includes('issue-agent-runtime-token'), true)
  assert.equal(auth.includes('async function currentSupabaseAccessToken()'), true)
  assert.equal(auth.includes('supabase.auth.getUser(token)'), true)
  assert.equal(auth.includes('supabase.auth.refreshSession()'), true)
  assert.equal(auth.includes('登录状态已过期，请重新登录后再启用插件。'), true)
  assert.equal(auth.includes('CLOUD_AGENT_PLUGIN_IDS'), true)
  assert.equal(auth.includes('IMAI_CLOUD_AGENT_HOST_CREDENTIAL'), true)
  assert.equal(auth.includes('hostCredential: cachedHostCredential'), true)
  assert.equal(auth.includes('pluginId'), true)
  assert.equal(auth.includes('resetHostCredential = false'), true)
  assert.equal(auth.includes('resetHostCredential: forceReset'), true)
  assert.equal(auth.includes('function clearHostCredential'), false)
  assert.equal(auth.includes('shouldRetryCloudAgentHostCredentialIssuer'), false)
  assert.equal(auth.includes('forceSessionAuth'), false)
  assert.equal(auth.includes('Host Credential 已失效'), true)
  assert.equal(auth.includes('cloudAgentHostCredential'), true)
  assert.equal(auth.includes('isCloudAgentRuntimeIssuerUnavailableError'), true)
  assert.equal(auth.includes("pluginIds: ['uniopc-cloud-workspace']"), true)
  assert.equal(auth.includes('请先部署 Supabase Edge Function issue-agent-runtime-token'), true)
  assert.equal(auth.includes('Cloud Agent Host Credential 签发服务暂时不可用'), true)
  assert.equal(auth.includes('currentCloudWorkspaceAuthEnv'), false)
  assert.equal(auth.includes('return currentCloudWorkspaceAuthEnv()'), false)
  assert.equal(auth.includes('response.status !== 404'), false)
  assert.equal(admin.includes('cloudWorkspacePluginAuth'), false)
  assert.equal(detail.includes('currentCloudAgentRuntimeAuthEnv,'), true)
  assert.equal(detail.includes('isCloudAgentPluginId,'), true)
  assert.equal(detail.includes('replaceCloudAgentPluginCatalog,'), true)
  assert.equal(detail.includes("} from '../lib/cloudWorkspacePluginAuth'"), true)
  assert.equal(admin.includes("pluginIds: ['uniopc-cloud-workspace']"), false)
  assert.equal(detail.includes("pluginIds: ['uniopc-cloud-workspace']"), false)
  assert.equal(admin.includes('async function trySetCloudWorkspacePlugin(profileKey)'), false)
  assert.equal(detail.includes('async function trySetCloudWorkspacePlugin(profileKey)'), false)
  assert.equal(admin.includes("req: await cloudWorkspacePluginSetRequest(profileKey)"), false)
  assert.equal(detail.includes("req: await cloudWorkspacePluginSetRequest(profileKey)"), false)
  assert.equal(admin.includes('Cloud Agent runtime token 暂时不可用'), false)
  assert.equal(detail.includes('Cloud Agent runtime token 暂时不可用'), false)
  assert.equal(admin.includes("req: await cloudWorkspacePluginSetRequest(profile.openclawProfile)"), false)
  assert.equal(detail.includes("req: await cloudWorkspacePluginSetRequest(profile.openclawProfile)"), false)
  assert.equal(detail.includes("enabled && isCloudAgentPluginId(plugin.id) && ("), false)
  assert.equal(detail.includes('pluginIds: [plugin.id]'), true)
  assert.equal(detail.includes('运行凭证'), false)
  assert.equal(detail.includes('Runtime Token 只在 Host'), false)
  assert.equal(detail.includes('未就绪：请点击一键启用。'), true)
  assert.equal(hub.includes('currentCloudAgentRuntimeAuthEnv'), true)
  assert.equal(hub.includes('凭证管理'), false)
  assert.equal(hub.includes('刷新 Runtime Token'), false)
  assert.equal(hub.includes('autoRefreshCloudAgentRuntimeTokens'), false)
  assert.equal(hub.includes('isCloudAgentRuntimeIssuerUnavailableError'), false)
  assert.equal(hub.includes('engineClient.plugins.setProfile({'), true)
  assert.equal(hub.includes("invoke('openclaw_profile_plugin_set'"), false)
  assert.equal(rustPlugins.includes('UNIOPC_CLOUD_WORKSPACE_HOST_CREDENTIAL'), true)
  assert.equal(rustPlugins.includes('UNIOPC_SOCIALS_HOST_CREDENTIAL'), true)
  assert.equal(rustPlugins.includes('UNIOPC_PRIVATE_CONVERSION_HOST_CREDENTIAL'), true)
  assert.equal(rustPlugins.includes('pub cloud_agent_host_credential: Option<String>'), true)
  assert.equal(rustPlugins.includes('fn inject_cloud_workspace_auth_env(\n    patch: &mut Value'), true)
  assert.equal(rustPlugins.includes('host_credential.ok_or_else'), true)
})

test('agent-approved owner accounts auto-initialize organization from approved metadata', () => {
  const app = read('src/App.jsx')
  const profileHook = read('src/hooks/useActiveOpenClawProfile.jsx')
  const bootstrap = read('src/lib/workspaceBootstrap.js')
  const page = read('src/pages/CreateOrganization.jsx')
  const client = read('src/lib/cloudWorkspace.js')
  const settings = read('src/pages/Settings.jsx')

  assert.equal(app.includes('function WorkspaceBootstrap({ children, appMode })'), true)
  assert.equal(app.includes('function WorkspaceRoleGuard({ children, appMode'), true)
  assert.equal(
    app.indexOf('<WorkspaceBootstrap appMode={appMode}>') < app.indexOf('<WorkspaceRoleGuard appMode={appMode}>') &&
      app.indexOf('<WorkspaceRoleGuard appMode={appMode}>') < app.indexOf('<OpenClawGuard appMode={appMode}>'),
    true,
  )
  assert.equal(app.includes('path="/create-organization"'), true)
  assert.equal(app.includes('path="/setup/organization"'), true)
  assert.equal(app.includes('hostWorkspaceHomePath(workspaceProfile)'), true)
  assert.equal(bootstrap.includes('setup_required'), true)
  assert.equal(profileHook.includes('ActiveOpenClawProfileProvider'), true)
  assert.equal(profileHook.includes('loadWorkspaceProfileWithSetup'), true)
  assert.equal(bootstrap.includes('ensureOrganization'), true)
  assert.equal(bootstrap.includes('organizationSetupCompleted'), true)
  assert.equal(page.includes('ensureCloudOrganization'), true)
  // Organization creation needs no type: everyone auto-initializes, the
  // agent-approved opening request info is applied server-side when present.
  assert.equal(page.includes('正在为你创建组织空间'), true)
  assert.equal(page.includes('listCloudOrganizationTypes'), false)
  assert.equal(page.includes('行业类型'), false)
  assert.equal(client.includes('p_organization_type_id'), true)
  assert.equal(settings.includes('updateMyCloudOrganizationName'), true)
  assert.equal(settings.includes("id: 'organization'"), true)
  assert.equal(settings.includes('组织类型不可修改'), true)
})

test('owner-only organization page no longer manages member profile creation', () => {
  const source = read('src/pages/Admin.jsx')
  const detail = read('src/pages/AdminMemberDetail.jsx')

  assert.equal(source.includes("member.memberRole === 'owner' ? 'imai'"), false)
  assert.equal(source.includes('isOwnerDefaultProfile'), false)
  assert.equal(source.includes("invoke('openclaw_status')"), false)
  assert.equal(source.includes("invokeWithTimeout('openclaw_profile_provision'"), false)
  assert.equal(detail.includes("invokeWithTimeout('openclaw_profile_provision'"), false)
  assert.equal(source.includes("runtimeMode: 'member_local'"), false)
  assert.equal(detail.includes("runtimeMode: 'member_local'"), true)
})

test('owner-only organization page does not expose legacy member invitations', () => {
  const source = read('src/pages/Admin.jsx')

  assert.equal(source.includes('邀请成员'), false)
  assert.equal(source.includes('邀请组织成员'), false)
  assert.equal(source.includes('inviteCloudOrganizationMember'), false)
  assert.equal(source.includes('buildHumanInviteMailto'), false)
  assert.equal(source.includes('admin-invite-member-form'), false)
})

test('owner-only organization page does not detect member host state', () => {
  const source = read('src/pages/Admin.jsx')

  assert.equal(source.includes("invoke('openclaw_profile_status'"), false)
  assert.equal(source.includes('autoSyncProfileHosts'), false)
  assert.equal(source.includes('初始化'), false)
  assert.equal(source.includes('本机运行成员需要由成员自己的电脑完成 Uniopc 引擎 准备。'), false)
})

test('owner-only organization page does not expose member profile status controls', () => {
  const source = read('src/pages/Admin.jsx')

  assert.equal(source.includes('cloudProfileStatusLabel'), false)
  assert.equal(source.includes('localProfileStatusLabel'), false)
  assert.equal(source.includes('setProfileHostStatus'), false)
  assert.equal(source.includes('云端已登记'), false)
  assert.equal(source.includes('等待成员本机准备'), false)
  assert.equal(source.includes('创建并启动'), false)
  assert.equal(source.includes('Owner 本机'), false)
  assert.equal(source.includes('Owner Host 未上线'), false)
  assert.equal(source.includes("member.gatewayStatus !== 'online'"), false)
  assert.equal(source.includes('if (localGateway) return localGateway ==='), false)
})

testBackendSourceContract('owner admin does not manage member-owned gateway ports', () => {
  const source = read('src/pages/Admin.jsx')
  const detail = read('src/pages/AdminMemberDetail.jsx')
  const rustModel = read('src-tauri/src/commands/model/mod.rs')
  const migration = read('supabase/migrations/202606290001_member_runtime_modes.sql')

  for (const file of [source, detail]) {
    if (file === source) assert.equal(file.includes('managed_member_profile: isManagedMemberProfile'), false)
    assert.equal(file.includes('gateway_port: member.gatewayPort || null'), false)
    assert.equal(file.includes('gateway_port: profile.gatewayPort || null'), false)
    assert.equal(file.includes('gateway_port: targetMember.gatewayPort || null'), false)
  }
  assert.equal(detail.includes('gatewayUrl: configuredGatewayUrl,'), false)
  assert.equal(detail.includes('gatewayUrl: configuredGatewayUrl || undefined,'), false)
  assert.equal(rustModel.includes('managed_member_profile: bool'), true)
  assert.equal(rustModel.includes('profile_gateway_port_mismatch'), true)
  // Pure sidecar: the gateway is an app-owned child spawned by the supervisor;
  // the old daemon `gateway install` args helpers are gone.
  assert.equal(rustModel.includes('fn openclaw_gateway_install_args() ->'), false)
  assert.equal(rustModel.includes('openclaw_profile_gateway_install_args'), false)
  assert.match(rustModel, /GatewaySupervisor>\(\)[\s\S]*?\.ensure_running\(\)/)
  assert.equal(migration.includes('Owner host provision pending'), false)
  assert.equal(migration.includes("and v_member.user_id = v_user"), true)
  assert.equal(migration.includes('profile_key is distinct from excluded.profile_key'), true)
})

test('owner-only organization page has no member profile creation spinner', () => {
  const source = read('src/pages/Admin.jsx')
  const detail = read('src/pages/AdminMemberDetail.jsx')
  const cli = read('src-tauri/src/services/openclaw_cli.rs')

  assert.equal(source.includes("setCreatingProfileId('')"), false)
  assert.equal(detail.includes('setCreatingProfile(false)'), true)
  assert.equal(source.includes("invokeWithTimeout('openclaw_profile_provision'"), false)
  assert.equal(detail.includes("invokeWithTimeout('openclaw_profile_provision'"), false)

  assert.equal(cli.includes('owned_command::output(command, budget)'), true)
  assert.equal(cli.includes('spawn_blocking'), false)
})

test('legacy team detail routes redirect into personal conversations', () => {
  const app = read('src/App.jsx')

  assert.equal(app.includes("import Admin from './pages/Admin'"), false)
  assert.equal(app.includes("import AdminMemberDetail from './pages/AdminMemberDetail'"), false)
  assert.equal(app.includes('function AdminMemberRedirect'), false)
  assert.equal(app.includes('function WorkspaceAdminRoute'), false)
  assert.equal(app.includes('<Route path="/admin/member/:memberId" element={<Navigate to="/conversations" replace />} />'), true)
  assert.equal(app.includes('path="/profiles/:profileRef/team/member/:memberId" element={<ProfileWorkspaceRedirect childPath="conversations" />}'), true)
})

test('admin team and member detail do not expose member workspace or AI employee controls', () => {
  const admin = read('src/pages/Admin.jsx')
  const detail = read('src/pages/AdminMemberDetail.jsx')

  assert.equal(admin.includes('进入 Workspace'), false)
  assert.equal(detail.includes('assignMemberGateway'), false)
  assert.equal(detail.includes('grantMemberAgentPermission'), false)
  assert.equal(detail.includes('getMemberClientAdminSummary'), false)
  assert.equal(detail.includes('revokeMemberGatewayAssignment'), false)
  assert.equal(detail.includes('revokeMemberAgentPermission'), false)
  assert.equal(detail.includes("invoke('openclaw_agents_list'"), false)
  assert.equal(detail.includes('defaultOpenClawMainAgent'), false)
  assert.equal(detail.includes('mergeRuntimeAgentsWithDefault'), false)
  assert.equal(detail.includes("{ key: 'agents', label: 'AI 员工' }"), false)
  assert.equal(detail.includes("memberDetailSection === 'agents'"), false)
  assert.equal(detail.includes("label: '远程连接'"), false)
  assert.equal(detail.includes("memberDetailSection === 'remote'"), false)
  assert.equal(detail.includes('SSH tunnel'), false)
  assert.equal(detail.includes('sshTargetDraft'), false)
  assert.equal(detail.includes('p_ssh_target'), false)
  assert.equal(detail.includes('蒲公英/其他私有网络'), false)
  assert.equal(detail.includes('登记权限并生成授权'), false)
  assert.equal(detail.includes("const MEMBER_DETAIL_SECTION_KEYS = new Set(DETAIL_SECTIONS.map(section => section.key))"), true)
  assert.equal(detail.includes('Local Gateway'), false)
  assert.equal(detail.includes('Gateway auto-starts in local mode via launchd'), false)
  assert.equal(detail.includes('高级操作'), false)
  assert.equal(detail.includes('撤销连接'), false)
  assert.equal(detail.includes('Gateway 发现的 AI 员工'), false)
  assert.equal(detail.includes('默认 AI 员工'), false)
  assert.equal(detail.includes('已授权 AI 员工'), false)
  assert.equal(detail.includes('授权给成员'), false)
  assert.equal(detail.includes('撤销授权'), false)
  assert.equal(detail.includes('原始状态'), false)
})

test('admin member detail only enables plugins granted to the organization', () => {
  const detail = read('src/pages/AdminMemberDetail.jsx')

  assert.equal(detail.includes('listMyOrganizationPluginEntitlements'), true)
  assert.equal(detail.includes('organizationPluginEntitlements'), true)
  assert.equal(detail.includes('entitlementByPluginId'), true)
  assert.equal(detail.includes('canEnableProfilePlugin'), true)
  assert.equal(detail.includes('visibleProfilePlugins'), true)
  assert.equal(detail.includes('visibleProfilePlugins.map'), true)
  assert.equal(detail.includes('blockedByEntitlement'), false)
  assert.equal(detail.includes('组织尚未授权，不能分配给成员'), false)
})

test('admin member detail does not manage selected member AI employees', () => {
  const detail = read('src/pages/AdminMemberDetail.jsx')

  assert.equal(detail.includes('listMyCloudAiEmployeeRequests'), false)
  assert.equal(detail.includes('approveCloudAiEmployeeCreationRequest'), false)
  assert.equal(detail.includes('upsertCloudEmployee'), false)
  assert.equal(detail.includes('AI 员工创建申请'), false)
  assert.equal(detail.includes('批准创建'), false)
  assert.equal(detail.includes('重试创建'), false)
  assert.equal(detail.includes('读取 AI 员工'), false)
  assert.equal(detail.includes('尚未从 Gateway 发现 AI 员工'), false)
  assert.equal(detail.includes('visibleRuntimeAgents'), false)
  assert.equal(detail.includes('requestActionId'), false)
})

test('ordinary member operations page is removed with the member-client app', () => {
  const conversations = read('src/pages/Conversations.jsx')
  const client = read('src/lib/cloudWorkspace.js')
  const tauri = read('src-tauri/src/commands/conversations/mod.rs')

  assert.equal(exists('src/pages/EmployeeOperations.jsx'), false)
  assert.equal(exists('src/pages/EmployeeOperations.source.test.mjs'), false)
  assert.equal(client.includes('getMyOpenClawProfilePairingSetup'), true)
  assert.equal(conversations.includes('openclaw_profile_redeem_remote_setup'), false)
  assert.equal(conversations.includes('发现 Owner 授权的 Uniopc 引擎 Profile'), false)
  assert.equal(conversations.includes('canUseOwnerHostedOpenClawGateway'), false)
  assert.equal(conversations.includes('Owner 电脑上的专属 Uniopc 引擎 profile 尚未在线'), false)
  assert.equal(tauri.includes('bootstrapToken'), true)
  assert.equal(tauri.includes('deviceToken'), true)
})

test('host operations use the signed-in workspace active Uniopc 引擎 profile', () => {
  const operations = read('src/pages/Operations.jsx')
  const tauri = read('src-tauri/src/commands/conversations/mod.rs')

  assert.equal(operations.includes("import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'"), true)
  assert.equal(operations.includes("import { optionalCloudAgentRuntimeAuthEnv } from '../lib/cloudWorkspacePluginAuth'"), false)
  assert.equal(operations.includes("import { DEFAULT_OPENCLAW_PROFILE } from '../lib/openclawEmployees'"), false)
  assert.equal(operations.includes('const activeOpenClaw = useActiveOpenClawProfile()'), true)
  assert.equal(operations.includes('getOpenClawProfileRuntimeKey'), false)
  assert.equal(operations.includes('refreshOpenClawProfileStatus'), false)
  assert.equal(operations.includes('runtime.openClawProfiles.statuses[profileStatusKey]'), false)
  assert.equal(operations.includes("invoke('openclaw_profile_provision'"), false)
  assert.equal(operations.includes("invoke('openclaw_connection_start_local'"), false)
  assert.equal(operations.includes('const gatewayConnected = isGatewayConnectionReady(connectionSnapshot)'), true)
  assert.equal(operations.includes('profileRuntimeStatus?.gateway_running'), false)
  assert.equal(operations.includes('runtime.openClaw.status?.gateway_running'), false)
  assert.equal(operations.includes("invoke('openclaw_open_external_url'"), false)
  assert.equal(operations.includes("invoke('conversation_attempt_gateway_connect', { profile: activeProfile })"), false)
  assert.equal(operations.includes('profileRuntimeStatus?.dashboard_url'), false)
  assert.equal(operations.includes('Profile Gateway'), false)
  assert.equal(operations.includes("const FALLBACK_DASHBOARD_URL = 'http://127.0.0.1:18790/'"), false)
  assert.equal(read('src-tauri/src/commands/conversations/pairing.rs').includes('pub async fn conversation_attempt_gateway_connect(\n    app: AppHandle,\n    profile: Option<String>,'), true)
  assert.equal(tauri.includes('openclaw_gateway::config_metadata(profile_ref)'), true)
  assert.equal(tauri.includes('build_signed_connect_request(\n        &app,\n        &device_identity,\n        profile.as_deref(),'), true)
})

test('gateway connection writes the provisioned profile port to Uniopc 引擎 config', () => {
  const command = read('src-tauri/src/commands/openclaw_connection.rs')

  assert.equal(command.includes('let provision = model::openclaw_profile_provision'), true)
  assert.equal(command.includes('local_config_for_profile(&profile)'), true)
  assert.equal(command.includes('config.local_port = provision.gateway_port'), true)
  assert.equal(command.includes('local_openclaw_gateway_config_patch(&config.profile, config.local_port)'), true)
  assert.equal(command.includes('save_openclaw_gateway_config_patch('), true)
  assert.equal(command.includes('store.upsert(config.clone())'), false)
  // Pure sidecar: the supervisor already knows whether it holds a live gateway
  // child; start_local must never shell out to `openclaw gateway status` (a
  // 1-3s Node boot, serial on every cold start) just to learn "offline".
  assert.equal(command.includes('supervisor.running_profile()'), true)
  assert.equal(command.includes('engine_matches_profile'), true)
  assert.equal(command.includes('model::openclaw_profile_status'), false)
  assert.equal(command.includes('probe_effective_connection_snapshot'), true)
})

test('gateway connection snapshot health probe uses device identity auth', () => {
  const command = read('src-tauri/src/commands/openclaw_connection.rs')
  const service = read('src-tauri/src/services/openclaw_connection.rs')
  const gateway = read('src-tauri/src/services/openclaw_gateway.rs')

  assert.equal(command.includes('probe_effective_connection_snapshot(&app,'), true)
  assert.equal(service.includes('app: &tauri::AppHandle,'), true)
  assert.equal(service.includes('request_json_for_endpoint_with_device_auth('), true)
  assert.equal(gateway.includes('pub async fn request_json_for_endpoint_with_device_auth'), true)
})

test('gateway agents list uses device identity auth for runtime reads', () => {
  const agentsCommand = read('src-tauri/src/commands/openclaw_agents.rs')
  const modelCommand = read('src-tauri/src/commands/model/models.rs')
  const gateway = read('src-tauri/src/services/openclaw_gateway.rs')

  assert.equal(gateway.includes('pub async fn agents_list_json_with_device_auth'), true)
  assert.equal(gateway.includes('request_json_for_endpoint_with_device_auth(\n        app,\n        &endpoint,\n        "agents.list"'), true)
  assert.equal(agentsCommand.includes('openclaw_gateway::agents_list_json_with_device_auth(app, profile)'), true)
  assert.equal(agentsCommand.includes('openclaw_gateway_connection::refresh(app, profile).await'), true)
  assert.equal(agentsCommand.includes('load_openclaw_agents(&app,'), true)
  assert.equal(modelCommand.includes('openclaw_gateway::agents_list_json_with_device_auth(app, profile)'), true)
})

test('gateway connection no longer ships legacy openclaw-connections store schema', () => {
  const service = read('src-tauri/src/services/openclaw_connection.rs')
  const command = read('src-tauri/src/commands/openclaw_connection.rs')

  for (const source of [service, command]) {
    assert.equal(source.includes('openclaw-connections.json'), false)
    assert.equal(source.includes('GatewayConnectionStore'), false)
    assert.equal(source.includes('load_from_dir'), false)
    assert.equal(source.includes('save_to_dir'), false)
    assert.equal(source.includes('store.get('), false)
    assert.equal(source.includes('store.upsert'), false)
  }
})

test('operations no longer owns gateway connection management UI', () => {
  const operations = read('src/pages/Operations.jsx')
  const zh = read('src/locales/zh.json')
  const en = read('src/locales/en.json')

  assert.equal(operations.includes("import { useTranslation } from 'react-i18next'"), false)
  assert.equal(operations.includes('const { t } = useTranslation()'), false)
  assert.equal(operations.includes("t('operations.connection.title')"), false)
  assert.equal(operations.includes('Gateway 连接'), false)
  assert.equal(operations.includes('Gateway Connection 现在按 Uniopc 引擎 Profile 归属管理'), false)
  assert.equal(operations.includes('Gateway Connect 尝试'), false)
  assert.equal(operations.includes('conversation_attempt_gateway_connect'), false)
  assert.equal(operations.includes('当前 Profile 运行中心'), false)
  assert.equal(operations.includes('本机 Gateway”页签里处理'), false)
  assert.equal(operations.includes('核心运行链路'), false)
  assert.equal(operations.includes('openClawProviderReady'), false)
  assert.equal(operations.includes('provider 也已可用'), false)
  assert.equal(operations.includes('bg-[#171717]'), false)
  assert.equal(operations.includes('text-sm font-semibold text-white'), false)
  assert.equal(operations.includes('Gateway Connection 已更新'), false)
  assert.equal(operations.includes("t('operations.connection.messages.localStarted')"), false)
  assert.equal(operations.includes("t('operations.connection.notTested')"), false)
  assert.equal(zh.includes('"connection"'), false)
  assert.equal(en.includes('"connection"'), false)
  assert.equal(zh.includes('Gateway 连接'), false)
  assert.equal(en.includes('Gateway Connection'), false)
})

test('host desktop surfaces use the active local profile instead of member-client Gateway bootstrap', () => {
  const employees = read('src/pages/Employees.jsx')
  const conversations = read('src/pages/Conversations.jsx')

  assert.equal(exists('src/hooks/useMemberClientBootstrap.jsx'), false)
  assert.equal(employees.includes('useMemberClientBootstrap'), false)
  assert.equal(employees.includes('memberClient.agents'), false)
  assert.equal(conversations.includes('useMemberClientBootstrap'), false)
  assert.equal(conversations.includes('memberClient.agents'), false)
  assert.equal(conversations.includes('管理员尚未为你分配 Gateway'), false)
  assert.equal(employees.includes("activeOpenClaw.activeProfile || ''"), true)
  assert.equal(conversations.includes("activeOpenClaw.activeProfile || ''"), true)
})

test('member-client mobile target is removed from the desktop package', () => {
  const rootPackage = JSON.parse(read('package.json'))
  const packageJson = JSON.parse(read('package.json'))
  const viteConfig = read('vite.config.js')
  const app = read('src/App.jsx')
  const employees = read('src/pages/Employees.jsx')
  const conversations = read('src/pages/Conversations.jsx')
  const cargoToml = read('src-tauri/Cargo.toml')
  const rustLib = read('src-tauri/src/lib.rs')
  const generatedCapabilities = read('src-tauri/gen/schemas/capabilities.json')

  assert.equal(rootPackage.scripts['dev:imai-mobile'], undefined)
  assert.equal(rootPackage.scripts['build:imai-mobile'], undefined)
  assert.equal(packageJson.scripts['dev:mobile'], undefined)
  assert.equal(packageJson.scripts['build:mobile'], undefined)
  assert.equal(exists('src/MobileApp.jsx'), false)
  assert.equal(exists('src/mobile-main.jsx'), false)
  assert.equal(exists('mobile.html'), false)
  assert.equal(exists('dist-mobile'), false)
  assert.equal(exists('src-tauri/capabilities/mobile.json'), false)
  assert.equal(exists('src-tauri/gen/schemas/mobile-schema.json'), false)
  assert.equal(exists('src-tauri/gen/schemas/iOS-schema.json'), false)
  // src-tauri/icons/{android,ios} 是品牌图标资产（1c6cb6e 有意加回），不代表 mobile 构建目标
  assert.equal(exists('src-tauri/employee-icons/android'), false)
  assert.equal(exists('src-tauri/employee-icons/ios'), false)
  assert.equal(viteConfig.includes("'mobile'"), false)
  assert.equal(viteConfig.includes('mobileIndexFallback'), false)
  assert.equal(viteConfig.includes('dist-mobile'), false)
  assert.equal(cargoToml.includes('target_os = "android"'), false)
  assert.equal(cargoToml.includes('target_os = "ios"'), false)
  assert.equal(rustLib.includes('mobile_entry_point'), false)
  assert.equal(rustLib.includes('cfg(not(mobile))'), false)
  assert.equal(rustLib.includes('cfg(all(debug_assertions, not(mobile)))'), false)
  assert.equal(generatedCapabilities.includes('"mobile"'), false)
  assert.equal(generatedCapabilities.includes('"iOS"'), false)
  assert.equal(generatedCapabilities.includes('"android"'), false)
  assert.equal(app.includes('memberClientDeviceType'), false)
  assert.equal(employees.includes('memberClientDeviceType'), false)
  assert.equal(conversations.includes('memberClientDeviceType'), false)
})

test('project and task source modules are removed', () => {
  assert.equal(exists('src/pages/CloudWorkbench.jsx'), false)
  assert.equal(exists('src/pages/CloudProject.jsx'), false)
  assert.equal(exists('src/lib/cloudTasks.js'), false)
  assert.equal(exists('src/lib/projectEmployees.js'), false)
})

test('personal document list first paint is not blocked by project or member hydration', () => {
  const documents = read('src/pages/CloudDocuments.jsx')

  assert.equal(documents.includes('listCloudProjectMemberships'), false)
  assert.equal(documents.includes('listCloudProjects'), false)
  assert.equal(documents.includes('loadProjects('), false)
  assert.equal(documents.includes('loadDocuments()'), true)
})

test('setup gate rechecks Gateway Connection after startup settles', () => {
  const setupGate = read('src/pages/OpenClawSetupGate.jsx')
  const modelCommands = read('src-tauri/src/commands/model/mod.rs')
  const runtimeCommands = read('src-tauri/src/commands/model/runtime.rs')

  assert.equal(setupGate.includes('const GATEWAY_STARTUP_SLOW_MS = 180_000'), true)
  assert.equal(setupGate.includes('connectionSnapshot: nextConnectionSnapshot'), true)
  assert.equal(setupGate.includes('profileStatus: nextProfileStatus'), false)
  assert.equal(setupGate.includes('setupReady(nextStatus, nextConnectionSnapshot)'), true)
  assert.equal(setupGate.includes('isOpenClawAppReady(nextStatus)'), false)
  assert.equal(setupGate.includes('let keepPolling = false'), true)
  assert.equal(setupGate.includes('if (!keepPolling) setStartingGateway(false)'), true)
  assert.equal(setupGate.includes("setMessage('Gateway 已启动，正在等待连接稳定。')"), false)
  assert.equal(setupGate.includes('gatewayStartupState(startupSnapshot)'), true)
  assert.equal(setupGate.includes('setProgress(null)'), true)
  assert.equal(setupGate.includes("await refreshSetupStatus({ silent: true })\n      setMessage('Gateway 已启动，马上进入 Uniopc。')"), false)
  // Pure sidecar: onboard is best-effort; readiness is confirmed by spawning
  // the app-owned gateway child and waiting on the official RPC probe.
  assert.match(modelCommands, /app\.state::<GatewaySupervisor>\(\)[\s\S]*?\.ensure_running\(\)[\s\S]*?\.await/)
  assert.match(
    runtimeCommands,
    /fn ensure_openclaw_gateway_started[\s\S]*?openclaw_connection_start_local_for_runtime[\s\S]*?GatewayConnectionStatus::Connected/,
  )
})

test('Uniopc 引擎 setup gate does not block member-local entry on cloud connection sync', () => {
  const setup = read('src/pages/OpenClawSetupGate.jsx')

  assert.equal(setup.includes('registerOpenClawProfileHost'), false)
  assert.equal(setup.includes("runtimeMode === 'member_local'"), false)
  assert.equal(setup.includes('workspaceRuntimeMode'), false)
  assert.equal(setup.includes('syncMemberLocalHost'), false)
  assert.equal(setup.includes('cloudGatewayStatusFromConnectionSnapshot'), false)
  assert.equal(setup.includes('同步云端成员连接状态失败'), false)
  assert.equal(setup.includes("setMessage('Gateway 已启动，马上进入 Uniopc。')"), true)
  assert.match(setup, /const redirectTo = profileWorkspacePath\(\{ isCurrentMember: true \},\s*'conversations'\)/)
  assert.doesNotMatch(setup, /const redirectTo = location\.state\?\.from/)
  assert.match(setup, /navigate\(redirectTo,\s*\{ replace: true \}\)/)
})

testBackendSourceContract('member runtime mode migration enforces local-only member hosts', () => {
  const sql = read('supabase/migrations/202606290001_member_runtime_modes.sql')

  assert.equal(sql.includes("runtime_mode in ('member_local')"), true)
  assert.equal(sql.includes("select 'member_local'"), true)
  assert.equal(sql.includes('create or replace function public.register_owner_openclaw_profile_host'), false)
  assert.equal(sql.includes('drop function if exists public.register_owner_openclaw_profile_host'), true)
  assert.match(sql, /select \* into v_profile[\s\S]*from public\.cloud_openclaw_profiles[\s\S]*where id = p_openclaw_profile_id[\s\S]*for update/)
  assert.match(sql, /if v_member\.user_id is distinct from v_user then[\s\S]*raise exception 'forbidden'/)
  assert.match(sql, /where id = v_profile\.id[\s\S]*and runtime_mode = 'member_local'[\s\S]*and v_member\.user_id = v_user/)
  assert.equal(sql.includes('owner_hosted'), false)
  assert.equal(sql.includes('v_can_admin'), false)
})

test('host setup follows Uniopc 引擎 by not blocking entry on model provider auth', () => {
  const setupGate = read('src/pages/OpenClawSetupGate.jsx')
  const app = read('src/App.jsx')
  const runtimeStatus = read('src/lib/runtimeStatus.js')

  assert.equal(setupGate.includes("label: '配置大模型'"), false)
  assert.equal(setupGate.includes("setupStage === 'missing_provider'"), false)
  assert.equal(setupGate.includes('const providerReady'), false)
  assert.equal(setupGate.includes('nextProviderReady'), false)
  assert.equal(setupGate.includes('接入一个可用模型'), false)
  assert.equal(setupGate.includes('具体模型之后在 AI 员工里配置'), false)
  assert.equal(app.includes('profileProviderReady(profileStatus)'), false)
  assert.equal(app.includes('const defaultProviderReady'), false)
  assert.equal(runtimeStatus.includes("return Boolean(status?.installed && status?.provider_ready && isGatewayConnectionReady(connectionSnapshot))"), false)
  assert.equal(runtimeStatus.includes("if (!status?.provider_ready) return 'missing_provider'"), false)
})

test('host guard does not manage plugin policy while entering runtime workspace', () => {
  const app = read('src/App.jsx')

  assert.equal(app.includes('syncActiveWorkspacePluginPolicy'), false)
  assert.equal(app.includes('shouldSyncWorkspacePluginPolicy'), false)
  assert.equal(app.includes("setPluginPolicySync({ status: 'syncing'"), false)
  assert.equal(app.includes('正在同步插件授权'), false)
  assert.equal(app.includes('插件授权同步失败'), false)
  assert.equal(app.includes("label: '重试同步'"), false)
  assert.equal(app.includes('pluginPolicySyncReady'), false)
  assert.equal(app.includes('pluginPolicySyncFailed'), false)
  assert.equal(app.includes('return children'), true)
})

test('setup gate initializes the login-resolved Uniopc 引擎 profile', () => {
  const setupGate = read('src/pages/OpenClawSetupGate.jsx')

  assert.equal(setupGate.includes("import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'"), true)
  assert.equal(setupGate.includes("import { syncProfilePluginCapabilities } from '../lib/profileCapabilitySync'"), false)
  assert.equal(setupGate.includes('const activeOpenClaw = useActiveOpenClawProfile()'), true)
  assert.equal(setupGate.includes('useAuth'), false)
  assert.equal(setupGate.includes('const activeProfile = profileWorkspaceState?.targetOpenClawProfile || activeOpenClaw.activeProfile'), true)
  assert.equal(setupGate.includes('const hasConnectionProfile = Boolean(connectionProfile)'), true)
  assert.equal(setupGate.includes("setupStage === 'missing_profile'"), true)
  assert.equal(setupGate.includes('!hasConnectionProfile'), true)
  assert.equal(setupGate.includes('refreshGatewayConnectionSnapshot'), true)
  assert.equal(setupGate.includes('refreshOpenClawProfileStatus'), false)
  // Gateway startup is single-flighted through the shared warm-up module so
  // the guard's background kick-off and the gate's explicit start never race
  // competing provisions. The gate must not invoke start_local directly.
  assert.equal(setupGate.includes("import { warmUpLocalGateway } from '../lib/gatewayWarmup'"), true)
  assert.equal(setupGate.includes("invoke('openclaw_connection_start_local'"), false)
  assert.equal(setupGate.includes('const startupSnapshot = await warmUpLocalGateway({ profile: connectionProfile, gatewayPort: gatewayPort || null })'), true)
  assert.equal(setupGate.includes("...await currentCloudAgentRuntimeAuthEnv({"), false)
  assert.equal(setupGate.includes("invoke('openclaw_connection_snapshot'"), false)
  assert.equal(setupGate.includes("invoke('openclaw_profile_provision'"), false)
  assert.equal(setupGate.includes("invoke('openclaw_start_gateway'"), false)
  const gatewayWarmupForGate = read('src/lib/gatewayWarmup.js')
  assert.equal(gatewayWarmupForGate.includes("invoke('openclaw_connection_start_local'"), true)
  assert.equal(gatewayWarmupForGate.includes("...await optionalCloudAgentRuntimeAuthEnv({"), false)
  assert.equal(gatewayWarmupForGate.includes("pluginIds: ['uniopc-cloud-workspace']"), false)
  assert.equal(gatewayWarmupForGate.includes('gatewayPort: gatewayPort || null'), true)
  assert.equal(setupGate.includes('connectionReady'), true)
  assert.equal(setupGate.includes('isGatewayConnectionReady(connectionSnapshot)'), true)
  assert.equal(setupGate.includes('profileGatewayReady'), false)
  assert.equal(setupGate.includes('capabilitySyncReady'), false)
  assert.equal(setupGate.includes('PROFILE_CAPABILITY_SYNC_GATE_TIMEOUT_MS'), false)
  assert.equal(setupGate.includes('syncProfilePluginCapabilities({'), false)
  assert.equal(setupGate.includes("status: '正在同步组织授权能力'"), false)
  assert.equal(setupGate.includes('if (!checked || loading || !ready || error)'), true)
  assert.equal(setupGate.includes('Uniopc 引擎 Profile'), true)
})

test('local gateway startup is independent of Cloud Agent runtime auth', () => {
  const auth = read('src/lib/cloudWorkspacePluginAuth.js')
  const gatewayWarmup = read('src/lib/gatewayWarmup.js')
  const operations = read('src/pages/Operations.jsx')
  const detail = read('src/pages/AdminMemberDetail.jsx')

  assert.equal(auth.includes('export async function optionalCloudAgentRuntimeAuthEnv'), true)
  assert.equal(auth.includes('return await currentCloudAgentRuntimeAuthEnv(input)'), true)
  assert.equal(auth.includes('return {}'), true)
  // Explicit plugin actions own credentials; ordinary local startup never requests them.
  assert.equal(gatewayWarmup.includes('optionalCloudAgentRuntimeAuthEnv'), false)
  assert.equal(operations.includes('optionalCloudAgentRuntimeAuthEnv'), false)
  assert.equal(detail.includes('optionalCloudAgentRuntimeAuthEnv'), false)
})

test('host app enters the resolved profile without a session confirmation step', () => {
  const app = read('src/App.jsx')
  const login = read('src/pages/Login.jsx')
  const entry = read('src/lib/hostWorkspaceEntry.js')

  assert.equal(app.includes("import WorkspaceConfirm from './pages/WorkspaceConfirm'"), false)
  assert.equal(app.includes("import GatewayConnectionSetup from './pages/GatewayConnectionSetup'"), false)
  assert.equal(app.includes("shouldShowWorkspaceConfirm"), false)
  assert.equal(app.includes('function WorkspaceConfirmGuard'), false)
  assert.equal(app.includes('path="/setup/workspace-confirm"'), false)
  assert.equal(app.includes('path="/setup/gateway-connection"'), false)
  assert.equal(app.includes('<WorkspaceRoleGuard appMode={appMode}>'), true)
  assert.equal(app.includes('<OpenClawGuard appMode={appMode}>'), true)
  assert.equal(login.includes("navigate('/setup/workspace-confirm'"), false)
  assert.equal(login.includes("'/setup/workspace-confirm'"), false)
  assert.equal(entry.includes('WORKSPACE_CONFIRMATION_PREFIX'), false)
  assert.equal(entry.includes('sessionStorage'), false)
})

test('host openclaw guard uses active profile gateway readiness', () => {
  const app = read('src/App.jsx')

  assert.equal(app.includes("import { invoke } from '@tauri-apps/api/core'"), true)
  assert.equal(app.includes("import { fetchOpenClawEmployees } from './lib/openclawEmployees'"), true)
  assert.equal(app.includes('getOpenClawProfileRuntimeKey'), false)
  assert.equal(app.includes('refreshGatewayConnectionSnapshot'), true)
  assert.equal(app.includes('refreshOpenClawProfileStatus'), false)
  assert.equal(app.includes('runtime.openClawProfiles.statuses[profileStatusKey]'), false)
  assert.equal(app.includes('function isProfileOpenClawAppReady(status, connectionSnapshot)'), true)
  assert.equal(app.includes('isGatewayConnectionReady(connectionSnapshot)'), true)
  assert.equal(app.includes('profileProviderReady(profileStatus)'), false)
  assert.equal(app.includes('const useProfileGateway = Boolean(activeProfile && activeProfile !== DEFAULT_OPENCLAW_PROFILE)'), false)
  assert.equal(app.includes('profile: activeProfile'), true)
  assert.equal(app.includes('const openClawReady = isProfileOpenClawAppReady(runtime.openClaw.status, connectionSnapshot)'), true)
  // The guard no longer hard-redirects on generic not-ready: entry stays
  // open while startup proceeds quietly. Full-screen setup is reserved for
  // auth circuit-breaker and incompatible-runtime states only.
  assert.equal(app.includes('if (requiresLocalOpenClaw && !openClawReady && !shouldBypassGatewayGuardInDev(connectionSnapshot))'), false)
  assert.equal(app.includes('(engineAuthBlocked || engineUnsupported) &&'), true)
  assert.equal(app.includes('!shouldBypassGatewayGuardInDev(connectionSnapshot)'), true)
  assert.equal(app.includes("import EngineStatusStrip from './components/EngineStatusStrip'"), true)
  assert.equal(app.includes('正在检查运行环境'), false)
  assert.equal(app.includes('<LocalEngineBootstrap />'), true)
  assert.equal(app.includes('autoInstallOpenClawEngine()'), false)
})

test('cold startup has a dedicated launch route while the global strip remains for in-app recovery', () => {
  const app = read('src/App.jsx')
  const strip = read('src/components/EngineStatusStrip.jsx')
  const layout = read('src/components/Layout.jsx')

  assert.equal(app.includes('<SignedInRuntime appMode={appMode}>'), true)
  assert.equal(app.includes("key={user?.uid || 'signed-out'}"), true)
  assert.equal(app.includes('<LocalEngineBootstrap />'), true)
  assert.equal(app.includes('<OfficialModelBootstrap />'), true)
  assert.equal(layout.includes('<OfficialModelBootstrap />'), false)
  assert.equal(app.includes('<EngineStatusStrip />'), true)
  assert.equal(app.includes('LOCAL_ASSISTANT_LAUNCH_PATH'), true)
  assert.equal(app.includes('<LocalAssistantLaunch />'), true)
  assert.equal(strip.includes('runtime.gatewayConnection.startupErrors[activeProfile]'), true)
  assert.equal(strip.includes('location.pathname === LOCAL_ASSISTANT_LAUNCH_PATH'), true)
  assert.equal(strip.includes('(!error && !preparing)'), true)
  assert.equal(strip.includes('查看诊断与重试'), true)
})

test('host openclaw guard cannot hang forever on active profile status checks', () => {
  const app = read('src/App.jsx')

  assert.equal(app.includes('OPENCLAW_GUARD_PROFILE_STATUS_TIMEOUT_MS'), true)
  assert.equal(app.includes('profileStatusTimedOut'), false)
  assert.equal(app.includes('withOpenClawGuardTimeout('), true)
  assert.equal(app.includes('setProfileStatusTimedOut(true)'), false)
  assert.equal(app.includes('isOpenClawAppReady(runtime.openClaw.status)'), false)
})

test('profile status checks Gateway health before CLI status to avoid stale CLI lock hangs', () => {
  const model = read('src-tauri/src/commands/model/mod.rs')
  const healthProbe = 'let gateway_health_probe = timeout('
  const cliProbe = 'openclaw_output_for_profile(&app, &profile, &["gateway", "status", "--json"])'

  assert.equal(model.includes('OPENCLAW_PROFILE_STATUS_HEALTH_TIMEOUT_SECS'), true)
  assert.equal(model.includes(healthProbe), true)
  assert.equal(model.includes('gateway_status_from_profile_health'), true)
  assert.equal(model.indexOf(healthProbe) < model.indexOf(cliProbe), true)
})

test('host openclaw guard leaves cloud plugin policy to member detail management', () => {
  const app = read('src/App.jsx')

  assert.equal(app.includes('syncActiveWorkspacePluginPolicy'), false)
  assert.equal(app.includes('shouldSyncWorkspacePluginPolicy'), false)
  assert.equal(app.includes('subscribeWorkspacePolicyVersion'), false)
  assert.equal(app.includes('currentCloudAgentRuntimeAuthEnv'), false)
  assert.equal(app.includes('正在同步插件授权'), false)
  assert.equal(app.includes("label: '重试同步'"), false)
  assert.equal(app.includes('pluginPolicySync.status,\n    pluginPolicySyncKey'), false)
  assert.equal(app.includes('pluginPolicySync.key,\n    pluginPolicySync.status'), false)
  assert.equal(app.includes('workspaceProfile,\n  ]'), false)
  assert.equal(app.includes('const workspaceProfileStatus = workspaceProfile?.profileStatus'), true)
})

testBackendSourceContract('host openclaw guard syncs Gateway agents to cloud after readiness', () => {
  const app = read('src/App.jsx')
  const workspace = read('src/lib/cloudWorkspace.js')
  const employees = read('src/lib/openclawEmployees.js')
  const migration = read('supabase/migrations/202605250003_sync_cloud_ai_employees.sql')

  assert.equal(app.includes('fetchOpenClawEmployees'), true)
  assert.equal(app.includes('syncMyCloudAiEmployees'), true)
  assert.equal(app.includes('agentDirectorySyncInFlight'), true)
  assert.equal(app.includes('!openClawReady'), true)
  assert.equal(workspace.includes('syncMyCloudAiEmployees'), true)
  assert.equal(employees.includes('syncCloudEmployees(normalized)'), true)
  assert.equal(migration.includes('where public.cloud_employees.organization_id is distinct from excluded.organization_id'), true)
})

test('app center does not expose onchain data as a first-level category', () => {
  const layout = read('src/components/Layout.jsx')
  const app = read('src/App.jsx')
  const zh = read('src/locales/zh.json')
  const en = read('src/locales/en.json')

  assert.equal(exists('src/pages/Workbench/OnchainData.jsx'), false)
  assert.equal(exists('src/pages/Workbench/OnchainWalletWatch.jsx'), false)
  assert.equal(layout.includes("workbench/onchain"), false)
  assert.equal(layout.includes("t('nav.onchainData')"), false)
  assert.equal(app.includes("OnchainData"), false)
  assert.equal(app.includes("OnchainWalletWatch"), false)
  assert.equal(app.includes('/workbench/onchain'), false)
  assert.equal(zh.includes('"onchainData"'), false)
  assert.equal(en.includes('"onchainData"'), false)
})

// 侧边栏顺序与"进入 App 落在哪一页"是同一个产品决定的两半：先看项目，再进文档/对话。
// 这两处分别写在 Layout 的 navGroups 和四个 *HomePath 里，改一处忘另一处就会出现
// "第一项是项目、打开却落在对话"的错位，所以一起钉。
test('sidebar and entry both lead into the personal workspace', () => {
  const layout = read('src/components/Layout.jsx')
  const app = read('src/App.jsx')
  const hostEntry = read('src/lib/hostWorkspaceEntry.js')
  const profileWorkspace = read('src/lib/profileWorkspace.js')

  // 个人工作区：对话 → 文档 → 插件 → 应用 → 移动端。
  const order = [
    "to: profileRoutePath('conversations')",
    "to: profileRoutePath('cloud-documents')",
    "to: '/plugins'",
    "to: '/apps'",
    "to: profileRoutePath('mobile')",
  ].map(marker => {
    const at = layout.indexOf(marker)
    assert.notEqual(at, -1, `Layout 里找不到导航项 ${marker}`)
    return at
  })
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i] > order[i - 1], '侧边栏顺序必须是 对话/文档/插件/应用/移动端')
  }

  assert.equal(hostEntry.includes("'/profiles/me/conversations'"), true)
  assert.equal(profileWorkspace.includes("profileWorkspacePath(input, 'conversations')"), true)
  assert.equal(profileWorkspace.includes("'/profiles/me/conversations'"), true)
  assert.equal(app.includes('/profiles/me/conversations'), true)
  assert.equal(layout.includes("profileRoutePath('cloud-workbench')"), false)
})

test('app center does not expose social media as a first-level category', () => {
  const layout = read('src/components/Layout.jsx')
  const app = read('src/App.jsx')
  const zh = read('src/locales/zh.json')
  const en = read('src/locales/en.json')

  assert.equal(exists('src/pages/Workbench/SocialMedia.jsx'), false)
  assert.equal(layout.includes("workbench/social-media"), false)
  assert.equal(layout.includes("t('nav.socialMedia')"), false)
  assert.equal(app.includes('SocialMedia'), false)
  assert.equal(app.includes('/workbench/social-media'), false)
  assert.equal(zh.includes('"socialMedia"'), false)
  assert.equal(en.includes('"socialMedia"'), false)
})

// 这三个应用（超级IP / 公域流量 / 私域转化）曾经以 `pages/Workbench/*` + `pages/SuperIP/*`
// 的形态活在桌面端，被整体删掉、只留小程序一份。现在它们按小程序的形态重新回到桌面端，
// 挂在侧边栏「插件」下面的「应用」入口（`/apps/*`，pages/Apps.jsx + pages/apps/*）。
// 这条测试因此改成守两件事：
//   1. 旧那套目录结构、旧路由、旧 lib 不许复活（它们和小程序的 action 契约已经对不上）；
//   2. 新那套必须是唯一实现，且共用 lib/appsBackend.js 这一个后端接入层。
test('the super-ip / public-traffic / private-conversion apps live under /apps, not the old workbench tree', () => {
  const layout = read('src/components/Layout.jsx')
  const app = read('src/App.jsx')
  const zh = read('src/locales/zh.json')
  const en = read('src/locales/en.json')

  // 旧的页面 UI 和它们专属的数据层不许回来。
  const removedFiles = [
    'src/pages/SuperIP/index.jsx',
    'src/pages/PrivateConversion/VideoChannel.jsx',
    'src/pages/PrivateConversion/LiveChannel.jsx',
    'src/pages/Workbench/PublicTraffic.jsx',
    'src/pages/Workbench/index.jsx',
    'src/pages/Workbench/products.js',
    'src/pages/Studio/Socials/Transcript.jsx',
    'src/lib/superIpCloud.js',
    'src/lib/privateConversionCloud.js',
    'src/lib/privateConversionStorage.js',
    'src/lib/socialsCloud.js',
  ]
  for (const file of removedFiles) {
    assert.equal(exists(file), false, `${file} should not exist`)
  }

  // 旧的侧边栏分组和旧路由不许回来。
  assert.equal(layout.includes("t('nav.groupApps')"), false)
  assert.equal(layout.includes("t('nav.superIp')"), false)
  assert.equal(layout.includes("t('nav.publicTraffic')"), false)
  assert.equal(layout.includes("t('nav.privateConversion')"), false)
  assert.equal(app.includes('/workbench/super-ip'), false)
  assert.equal(app.includes('/workbench/public'), false)
  assert.equal(app.includes('/workbench/private-conversion'), false)
  assert.equal(app.includes('/workbench/socials'), false)
  assert.equal(app.includes('/studio/socials'), false)
  assert.equal(app.includes('<SuperIP '), false)
  assert.equal(app.includes('PrivateVideoChannel'), false)

  // 旧的 locale key 不许回来（新入口用的是 nav.applications）。
  for (const key of ['"superIp"', '"publicTraffic"', '"privateConversion"', '"groupApps"']) {
    assert.equal(zh.includes(key), false, `zh.json should not contain ${key}`)
    assert.equal(en.includes(key), false, `en.json should not contain ${key}`)
  }

  // 新入口：侧边栏一个「应用」项 + /apps 下的四条路由。
  assert.equal(layout.includes("t('nav.applications')"), true)
  assert.equal(layout.includes("to: '/apps'"), true)
  assert.equal(zh.includes('"applications"'), true)
  assert.equal(en.includes('"applications"'), true)
  for (const route of [
    'path="/apps"',
    'path="/apps/super-ip"',
    'path="/apps/public-traffic/:mode"',
    'path="/apps/private-conversion"',
    'path="/apps/private-conversion/:channelId"',
  ]) {
    assert.equal(app.includes(route), true, `App.jsx should route ${route}`)
  }
  for (const file of [
    'src/pages/Apps.jsx',
    'src/pages/apps/SuperIpApp.jsx',
    'src/pages/apps/PublicTrafficApp.jsx',
    'src/pages/apps/PrivateConversionApp.jsx',
    'src/lib/appsBackend.js',
    'src/lib/appsVideoParse.js',
  ]) {
    assert.equal(exists(file), true, `${file} should exist`)
  }

  // 三个应用都只经由 appsBackend 说话，不许各自再长一个 Edge Function 客户端。
  for (const page of ['SuperIpApp', 'PublicTrafficApp', 'PrivateConversionApp']) {
    const source = read(`src/pages/apps/${page}.jsx`)
    assert.equal(source.includes("from '../../lib/appsBackend'"), true, `${page} should import appsBackend`)
    assert.equal(source.includes('functions/v1'), false, `${page} should not build function URLs itself`)
  }
  const backend = read('src/lib/appsBackend.js')
  // action 名必须和小程序 utils/privateConversion.js 打的是同一批，否则「1:1」就只是看起来像。
  for (const action of [
    'private-conversion',
    'socials',
    'super-ip',
    'operator_prepare_storage_upload',
    'operator_create_media_asset',
  ]) {
    assert.equal(backend.includes(action), true, `appsBackend should reference ${action}`)
  }
  // 素材存储在 media 函数（阿里云 OSS），不在 private-conversion 单体（Supabase Storage）。
  // 两边 action 同名，只有函数名能区分，所以这里盯的是「谁被 callMedia 调用」。
  assert.match(backend, /callMedia\('operator_prepare_storage_upload'/)
  assert.match(backend, /callMedia\('operator_create_media_asset'/)
  assert.equal(backend.includes("callPrivateConversion('operator_prepare_storage_upload'"), false)
  assert.equal(backend.includes("callPrivateConversion('operator_create_media_asset'"), false)
  // 素材直传打的是 OSS 域名，不在 http 插件的 allow 里就会在发请求前被 scope 拦掉，
  // 表现是「上传失败」而不是网络错误 —— 极难从报错反推，所以钉在这里。
  // OSS only：上传不再保留写回 Supabase Storage 的退路。留着它的后果是服务端 OSS
  // 配置一坏，上传会「成功」但悄悄写回 Supabase，把双存储又劈开一次且无人察觉。
  assert.equal(backend.includes('/storage/v1/object/'), false)
  const httpScope = JSON.parse(read('src-tauri/capabilities/default.json'))
    .permissions.find(item => item?.identifier === 'http:default')
  assert.ok(
    httpScope?.allow?.some(rule => String(rule?.url || '').includes('aliyuncs.com')),
    'http:default must allow the Aliyun OSS host used for media uploads',
  )
  const privateConversionPage = read('src/pages/apps/PrivateConversionApp.jsx')
  for (const action of [
    'operator_list_org_channels',
    'operator_create_org_channel',
    'operator_update_org_channel',
    'operator_create_post',
    'operator_schedule_live_session',
  ]) {
    assert.equal(privateConversionPage.includes(action), true, `PrivateConversionApp should call ${action}`)
  }
  // 互动数据（评论、直播弹幕、点赞收藏转发）只能由 AI 员工带私域插件生成。客户端自己调这些
  // action 是历史做法：模板文案贴不住视频内容，而且 desktopGenerateLiveTimelineEvents 会
  // 无条件删掉该场次所有 ai_script 事件，把 agent 已发布的时间轴一起清掉。别再引回来。
  for (const action of [
    'operator_generate_seed_comments',
    'operator_generate_live_timeline_events',
    'operator_update_post_display_stats',
  ]) {
    assert.equal(privateConversionPage.includes(action), false, `PrivateConversionApp must not call ${action}`)
  }
})

test('Apps copy recovery owns the exact failed topic without unmounting either content surface', () => {
  const apps = read('src/pages/Apps.jsx')
  const asyncActionState = read('src/components/AsyncActionState.jsx')

  assert.equal(apps.includes("import { AsyncActionState } from '../components/AsyncActionState'"), true)
  assert.match(apps, /setCopyFailure\(\{ topic,[^}]*detail:/)
  assert.equal(apps.includes('onRetry={() => copyTopic(copyFailure.topic)}'), true)
  const feedbackStart = apps.indexOf('<AsyncActionState')
  const feedbackEnd = apps.indexOf('</AsyncActionState>', feedbackStart)
  const topics = apps.indexOf('PLAZA_TOPIC_ROWS.map', feedbackStart)
  const appCards = apps.indexOf('APPS.map', feedbackStart)
  assert.ok(feedbackStart >= 0 && feedbackEnd > feedbackStart, 'Apps should render its recovery boundary')
  assert.ok(topics > feedbackStart && topics < feedbackEnd, 'topic rows should remain inside the recovery boundary')
  assert.ok(appCards > feedbackStart && appCards < feedbackEnd, 'app cards should remain inside the recovery boundary')

  assert.match(asyncActionState, /className\s*=\s*''/)
  assert.match(asyncActionState, /<FeedbackCard[^>]*className=\{className\}/)
})

test('Private Conversion channel-data recovery clears stale paired feedback before every repeat', () => {
  const source = read('src/pages/apps/PrivateConversionApp.jsx')
  const loadStart = source.indexOf('const loadChannelData = useCallback(async id => {')
  const loadEnd = source.indexOf('\n\n  useEffect(() => {', loadStart)
  const loadChannelData = source.slice(loadStart, loadEnd)
  const validId = loadChannelData.indexOf('if (!id) return')
  const clear = loadChannelData.indexOf('clearError()')
  const request = loadChannelData.indexOf('try {')

  assert.ok(loadStart >= 0 && loadEnd > loadStart, 'loadChannelData action should be found')
  assert.ok(validId >= 0 && clear > validId && clear < request, 'a channel-data repeat should clear error and retry ownership before requesting')
  assert.match(loadChannelData, /setPosts\([\s\S]*setMediaAssets\(/)
  assert.match(loadChannelData, /catch \(loadError\) \{[\s\S]*showError\([\s\S]*\(\) => loadChannelData\(id\)\)[\s\S]*\}/)
})

test('MCP connector actions clear stale paired feedback for global and connector-local repeats', () => {
  const source = read('src/pages/McpHub.jsx')
  const connectStart = source.indexOf('async function connectOauthConnector(preset, connector) {')
  const disconnectStart = source.indexOf('async function disconnectOauthConnector(preset, connector) {', connectStart)
  const disconnectEnd = source.indexOf('\n  const filteredServers', disconnectStart)
  const connect = source.slice(connectStart, disconnectStart)
  const disconnect = source.slice(disconnectStart, disconnectEnd)

  for (const [label, action] of [['connect', connect], ['disconnect', disconnect]]) {
    const key = action.indexOf('const key =')
    const clear = action.indexOf('clearError()')
    const request = action.indexOf('try {')
    const success = action.indexOf('setMessage(')
    assert.ok(key >= 0 && clear > key && clear < request, `${label} should clear error and retry ownership at action start`)
    assert.ok(success > request && action.indexOf('clearError()', success) === -1, `${label} success feedback should remain after recovery`)
  }
  assert.match(connect, /catch \(err\) \{[\s\S]*showError\([\s\S]*\(\) => connectOauthConnector\(preset, connector\)\)[\s\S]*\}/)
  assert.match(disconnect, /catch \(err\) \{[\s\S]*showError\([\s\S]*\(\) => disconnectOauthConnector\(preset, connector\)\)[\s\S]*\}/)
})

test('WeChat-store uniqueness conflicts are validation-only while transient save failures stay retryable', () => {
  const source = read('src/pages/apps/PrivateConversionApp.jsx')
  const saveStart = source.indexOf('async function saveWechatStoreBinding() {')
  const saveEnd = source.indexOf('\n\n  // ── 素材上传', saveStart)
  const saveBinding = source.slice(saveStart, saveEnd)
  const conflictStart = saveBinding.indexOf('if (/duplicate|unique|wechat_store_already/i.test(message)) {')
  const transientStart = saveBinding.indexOf('} else {', conflictStart)
  const conflictBranch = saveBinding.slice(conflictStart, transientStart)
  const transientBranch = saveBinding.slice(transientStart)

  assert.ok(conflictStart >= 0 && transientStart > conflictStart, 'recognized binding conflicts should have their own validation branch')
  assert.match(conflictBranch, /showError\('这个微信小店已绑定到其他私域频道'\)/)
  assert.equal(conflictBranch.includes('saveWechatStoreBinding'), false, 'an unchanged uniqueness conflict must not expose retry')
  assert.match(transientBranch, /showError\(message, saveWechatStoreBinding\)/)
})

test('MCP and Private Conversion feedback stays additive to tabs, grids, forms, and retained results', () => {
  const hub = read('src/pages/McpHub.jsx')
  const privateConversion = read('src/pages/apps/PrivateConversionApp.jsx')

  assert.equal(hub.includes("import { AsyncActionState } from '../components/AsyncActionState'"), true)
  assert.equal(hub.includes("state={error && errorRetry ? 'error' : null}"), true)
  assert.equal(hub.includes('onRetry={errorRetry || undefined}'), true)
  assert.equal(hub.includes('onRetry={cloudPluginCatalogError?.retryable ? loadCloudPluginCatalog : undefined}'), true)
  assert.equal(hub.includes('onRetry={refreshProfilePluginStatusFromLocal}'), true)
  assert.equal(hub.includes("error\n            ? 'border-rose-400/20 bg-rose-500/10 text-rose-500'"), false)
  const hubRender = hub.slice(hub.indexOf('  const createActionLabel ='))
  const hubFeedbackStart = hubRender.indexOf('<AsyncActionState')
  const hubFeedbackEnd = hubRender.indexOf('</AsyncActionState>', hubFeedbackStart)
  const hubTabs = hubRender.indexOf('{visibleTabs', hubFeedbackEnd)
  const hubGrid = hubRender.indexOf('<PluginCatalogGrid', hubTabs)
  const hubSelectedDetail = hubRender.indexOf('open={Boolean(marketDetailModal)}', hubGrid)
  assert.ok(hubFeedbackStart >= 0 && hubFeedbackEnd > hubFeedbackStart, 'MCP feedback boundary should be found')
  assert.ok(hubTabs > hubFeedbackEnd && hubGrid > hubTabs && hubSelectedDetail > hubGrid, 'MCP tabs, catalog grids, and selected detail should remain mounted after feedback')
  assert.doesNotMatch(hubRender, /if\s*\(\s*error\s*\)\s*return/)

  assert.equal(privateConversion.includes("import { AsyncActionState } from '../../components/AsyncActionState'"), true)
  assert.equal(privateConversion.includes("state={error && errorRetry ? 'error' : null}"), true)
  assert.equal(privateConversion.includes('onRetry={errorRetry || undefined}'), true)
  assert.equal(privateConversion.includes("message={error && !errorRetry ? error : ''}"), true)
  assert.equal(privateConversion.includes('onRetry={() => loadAnalytics(analytics.post)}'), true)
  assert.equal(privateConversion.includes('onRetry={parseRetry || undefined}'), true)
  assert.equal(privateConversion.includes('>{analyticsError}</div>'), false)
  assert.equal(privateConversion.includes('>{parseError}</div>'), false)
  const renderSource = privateConversion.slice(privateConversion.indexOf('  // ── 渲染'))
  assert.doesNotMatch(renderSource, /if\s*\(\s*error\s*\)\s*return/)
  const editorStart = renderSource.indexOf('if (editorMode) {')
  const channelListStart = renderSource.indexOf('if (!channelId) {', editorStart)
  const mainStart = renderSource.indexOf('const channel = selectedChannel || {}', channelListStart)
  const editor = renderSource.slice(editorStart, channelListStart)
  const channelList = renderSource.slice(channelListStart, mainStart)
  const main = renderSource.slice(mainStart)
  assert.ok(editor.indexOf('{feedback}') >= 0 && editor.indexOf('profileForm.displayName') > editor.indexOf('{feedback}'), 'editor fields should remain mounted with feedback')
  assert.ok(channelList.indexOf('{feedback}') >= 0 && channelList.indexOf('channels.map') > channelList.indexOf('{feedback}'), 'channel cards should remain mounted with feedback')
  assert.ok(main.indexOf('{feedback}') >= 0 && main.indexOf('<TabBar') > main.indexOf('{feedback}') && main.indexOf('<VideoTile') > main.indexOf('<TabBar'), 'selected-channel tabs and cards should remain mounted with feedback')

  const analyticsStart = main.indexOf('<AsyncActionState\n              state={analyticsError')
  const analyticsEnd = main.indexOf('</AsyncActionState>', analyticsStart)
  const analyticsRows = main.indexOf('analytics[analyticsTab].map', analyticsStart)
  assert.ok(analyticsStart >= 0 && analyticsRows > analyticsStart && analyticsRows < analyticsEnd, 'retained analytics rows should stay inside their recovery boundary')
  const parseStart = main.indexOf('<AsyncActionState\n            state={parseError')
  const parseEnd = main.indexOf('</AsyncActionState>', parseStart)
  const transcript = main.indexOf('{parseTranscript}', parseStart)
  const fragments = main.indexOf('parseFragments.map', parseStart)
  assert.ok(parseStart >= 0 && transcript > parseStart && transcript < parseEnd, 'retained transcript should stay inside its recovery boundary')
  assert.ok(fragments > parseStart && fragments < parseEnd, 'retained parse fragments should stay inside their recovery boundary')
})

test('smart montage stays in Apps and uses the mini-program cloud workflow', () => {
  const app = read('src/App.jsx')
  const apps = read('src/pages/Apps.jsx')
  const montage = read('src/pages/apps/MontageApp.jsx')
  const backend = read('src/lib/appsBackend.js')

  assert.equal(app.includes('path="/apps/montage" element={<MontageApp />}'), true)
  assert.equal(apps.includes("title: '智能混剪'"), true)
  assert.equal(montage.includes("from '../../lib/montageFuncs'"), true)
  assert.equal(montage.includes('smartMontageFuncs'), true)
  assert.equal(montage.includes('callMontage'), true)
  assert.equal(montage.includes('client().planMontage'), true)
  assert.equal(montage.includes('client().createJob({'), true)
  assert.equal(montage.includes('captionIdempotencyKey(master.id, captionRequest)'), true)
  assert.equal(montage.includes("invoke('montage_local_render_start'"), false)
  assert.equal(montage.includes('FFmpeg/Remotion'), false)
})

test('app center does not expose smart trading as a first-level category', () => {
  const layout = read('src/components/Layout.jsx')
  const app = read('src/App.jsx')
  const zh = read('src/locales/zh.json')
  const en = read('src/locales/en.json')

  assert.equal(exists('src/pages/Workbench/SmartTrading.jsx'), false)
  assert.equal(layout.includes("workbench/trading"), false)
  assert.equal(layout.includes("t('nav.smartTrading')"), false)
  assert.equal(app.includes("SmartTrading"), false)
  assert.equal(app.includes('/workbench/trading'), false)
  assert.equal(zh.includes('"smartTrading"'), false)
  assert.equal(en.includes('"smartTrading"'), false)
})

test('authenticated app routes fall back to home instead of blanking on removed pages', () => {
  const app = read('src/App.jsx')

  assert.equal(app.includes('<Route path="*" element={<HostHomeRedirect />} />'), true)
})

test('BlockSuite Vite pipeline handles legacy WebKit, vanilla-extract styles, and singleton web components', () => {
  const viteConfig = read('vite.config.js')
  const blocksCompat = read('src/lib/blocksuiteBlocksCompat.js')
  const rootPackage = JSON.parse(read('package.json'))

  assert.equal(viteConfig.includes("from '@vanilla-extract/vite-plugin'"), true)
  assert.equal(viteConfig.includes('vanillaExtractPlugin(command'), true)
  assert.equal(viteConfig.includes("unstable_mode: 'transform'"), true)
  assert.equal(viteConfig.includes("const [validId] = id.split('?')"), true)
  assert.equal(viteConfig.includes("validId.endsWith('.css.ts')"), true)
  assert.equal(viteConfig.includes("transformWithEsbuild(code, validId"), true)
  assert.equal(viteConfig.includes('blocksuiteLegacyWebkitCompat'), true)
  assert.equal(viteConfig.includes("target: 'safari15'"), true)
  assert.equal(viteConfig.includes("target: 'es2021'"), false)
  assert.equal(viteConfig.includes("target: 'es2022'"), false)
  assert.equal(viteConfig.includes('legacyWebkitRegexCompat'), true)
  assert.equal(viteConfig.includes('mdast-util-gfm-autolink-literal/lib/index.js'), true)
  assert.equal(viteConfig.includes("code.replace('(?<=^|\\\\s|\\\\p{P}|\\\\p{S})', '')"), true)
  assert.equal(viteConfig.includes("'remark-gfm'"), true)
  assert.equal(viteConfig.includes("'mdast-util-gfm-autolink-literal'"), true)
  assert.equal(viteConfig.includes('useDefineForClassFields: false'), true)
  assert.equal(viteConfig.includes('blocksuiteAffineShared'), true)
  assert.equal(viteConfig.includes('blocksuiteAffineSharedExports'), true)
  assert.equal(viteConfig.includes('blocksuiteAffineComponents'), true)
  assert.equal(viteConfig.includes('blocksuiteAffineBlockSurface'), true)
  assert.equal(viteConfig.includes('blocksuiteComponentAliases'), true)
  assert.equal(viteConfig.includes('blocksuiteSurfaceAliases'), true)
  assert.equal(blocksCompat.includes('BlocksUtils'), true)
  assert.equal(blocksCompat.includes('DualLinkIcon16'), true)
  assert.equal(blocksCompat.includes('EdgelessEditorBlockSpecs'), true)
  assert.equal(blocksCompat.includes('EdgelessRootService'), true)
  assert.equal(blocksCompat.includes('PageEditorBlockSpecs'), true)
  assert.equal(blocksCompat.includes('scrollbarStyle'), true)
  assert.equal(viteConfig.includes("find: /^@blocksuite\\/affine-components$/"), true)
  assert.equal(viteConfig.includes("find: /^@blocksuite\\/affine-components\\/(.+)$/"), true)
  assert.equal(viteConfig.includes("find: /^@blocksuite\\/affine-block-surface$/"), true)
  assert.equal(viteConfig.includes("find: /^@blocksuite\\/affine-block-surface\\/(.+)$/"), true)
  assert.equal(viteConfig.includes("'@blocksuite/affine-shared/services': `${blocksuiteAffineShared}/src/services/index.ts`"), true)
  assert.equal(viteConfig.includes("'@blocksuite/affine-shared': `${blocksuiteAffineShared}/src/index.ts`"), true)
  assert.equal(viteConfig.includes('...Object.entries(blocksuiteAffineSharedExports).map'), true)
  assert.equal(viteConfig.includes("find: '@lottiefiles/dotlottie-wc'"), true)
  assert.equal(viteConfig.includes('const blocksuiteSingletonDeps = ['), true)
  assert.equal(viteConfig.includes('dedupe: blocksuiteSingletonDeps'), true)
  assert.equal(viteConfig.includes('optimizeDeps'), true)
  for (const dependency of [
    'lodash.chunk',
    'lodash.clonedeep',
    'lodash.ismatch',
    'lodash.merge',
    'lodash.mergewith',
    'extend',
    'debug',
    'picocolors',
    'deepmerge',
  ]) {
    assert.equal(viteConfig.includes(`'${dependency}'`), true)
  }
  for (const dependency of [
    '@blocksuite/affine-block-surface',
    '@blocksuite/affine-components',
    '@blocksuite/block-std',
    '@blocksuite/blocks',
    '@blocksuite/data-view',
    '@blocksuite/global',
    '@blocksuite/inline',
    '@blocksuite/presets',
    '@blocksuite/std',
    '@lit/reactive-element',
    'lit-html',
    'yjs',
  ]) {
    assert.equal(viteConfig.includes(`'${dependency}'`), true)
  }
  assert.equal(viteConfig.includes('include: blocksuiteCommonJsDeps'), true)
  assert.equal(viteConfig.includes('needsInterop: blocksuiteCommonJsDeps'), true)
  assert.equal(viteConfig.includes("'@blocksuite/affine/extensions/view'"), true)
  assert.equal(viteConfig.includes("'@blocksuite/affine-block-surface'"), true)
  assert.equal(viteConfig.includes("'@blocksuite/affine-components'"), true)
  assert.equal(rootPackage.devDependencies['@vanilla-extract/vite-plugin'], '^5.2.2')
})

test('desktop packaging no longer builds or bundles the legacy Uniopc agent CLI', () => {
  const packageJson = JSON.parse(read('package.json'))
  const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'))

  assert.equal(packageJson.scripts['build:agent-cli'], undefined)
  assert.equal(packageJson.scripts['build:agent-cli:release'], undefined)
  assert.equal(
    packageJson.scripts['tauri:dev'],
    'npm run prepare:bundled-plugins && npm run build:openclaw-runtime -- --unsigned-local && tauri dev',
  )
  assert.equal(packageJson.scripts['tauri:build'], 'tauri build')
  assert.equal(tauriConfig.bundle.resources['target/release/imai-agent'], undefined)
  // cloud-workspace is now cloud-distributed like every other official plugin,
  // so it is no longer shipped inside the app bundle.
  assert.equal(
    tauriConfig.bundle.resources['../plugins/uniopc/uniopc-cloud-workspace'],
    undefined,
  )
})

test('desktop package keeps only the Host app target', () => {
  const rootPackage = JSON.parse(read('package.json'))
  const packageJson = JSON.parse(read('package.json'))
  const viteConfig = read('vite.config.js')
  const app = read('src/App.jsx')
  const login = read('src/pages/Login.jsx')
  const conversations = read('src/pages/Conversations.jsx')
  const layout = read('src/components/Layout.jsx')
  const mcpHub = read('src/pages/McpHub.jsx')
  const settings = read('src/pages/Settings.jsx')

  assert.equal(Object.hasOwn(rootPackage, 'workspaces'), false)
  assert.equal(rootPackage.scripts['dev:imai-employee'], undefined)
  assert.equal(rootPackage.scripts['build:imai-employee'], undefined)
  assert.equal(packageJson.scripts['dev:employee'], undefined)
  assert.equal(packageJson.scripts['build:employee'], undefined)
  assert.equal(packageJson.scripts['tauri:dev:employee'], undefined)
  assert.equal(packageJson.scripts['tauri:build:employee'], undefined)
  assert.equal(exists('src/EmployeeApp.jsx'), false)
  assert.equal(exists('src/MemberClientApp.jsx'), false)
  assert.equal(exists('src/employee-main.jsx'), false)
  assert.equal(exists('employee.html'), false)
  assert.equal(exists('src-tauri/tauri.employee.conf.json'), false)
  assert.equal(viteConfig.includes('IMAI_APP_TARGET'), false)
  assert.equal(viteConfig.includes('employeeIndexFallback'), false)
  assert.equal(viteConfig.includes('dist-employee'), false)
  assert.equal(app.includes('appMode = APP_MODES.HOST'), true)
  assert.equal(app.includes('isMemberClientApp'), false)
  assert.equal(app.includes('<Route path="/login" element={<Login appMode={appMode} />} />'), true)
  assert.equal(app.includes('<Route path="/settings/:section" element={<Settings />} />'), true)
  assert.equal(app.includes('requiresLocalOpenClaw = shouldRequireLocalOpenClawSetup(workspaceProfile, { appMode })'), true)
  assert.equal(app.includes('<Conversations />'), true)
  assert.equal(app.includes('<Employees />'), true)
  assert.equal(app.includes('<CloudWorkbench />'), false)
  assert.equal(app.includes('MemberClientRoutes'), false)
  assert.equal(app.includes('function WorkspaceAdminRoute({ children })'), false)
  assert.equal(app.includes('normalizeWorkspaceRole(activeOpenClaw.workspaceProfile) === \'member\''), false)
  assert.equal(app.includes('<Route path="/admin" element={<Navigate to="/conversations" replace />} />'), true)
  assert.equal(app.includes('path="/profiles/:profileRef/team" element={<ProfileWorkspaceRedirect childPath="conversations" />}'), true)
  assert.equal(app.includes('<Route path="/admin" element={isMemberClientApp'), false)
  assert.equal(app.includes('<Route path="/operations" element={isMemberClientApp'), false)
  assert.equal(app.includes('<Route path="/models" element={isMemberClientApp'), false)
  assert.equal(app.includes('<Route path="/plugins" element={<McpHub mode="plugins" />}'), true)
  assert.equal(app.includes('<Route path="/mcphub" element={<McpHub mode="mcp" />}'), true)
  assert.equal(app.includes('<Route path="/mcphub" element={isMemberClientApp'), false)
  assert.equal(layout.includes('isMemberClientApp'), false)
  // System-management nav (运行环境 / 本机权限) lives in Settings, so Layout
  // no longer reads the active OpenClaw profile or builds a system group.
  assert.equal(layout.includes("import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'"), false)
  assert.equal(layout.includes("const isWorkspaceMember = normalizeWorkspaceRole(activeOpenClaw.workspaceProfile) === 'member'"), false)
  assert.equal(settings.includes("const isWorkspaceMember = workspaceRole === 'member'"), false)
  assert.equal(layout.includes('const organizationItems = ['), false)
  assert.equal(layout.includes('const supportItems = ['), false)
  assert.equal(layout.includes('const runtimeItems = ['), false)
  assert.equal(layout.includes('const workspaceSystemItems = ['), false)
  assert.equal(settings.includes("title: '系统管理'"), true)
  assert.equal(layout.includes("to: '/admin'"), false)
  assert.equal(layout.includes("to: profileRoutePath('environment')"), false)
  assert.equal(layout.includes("to: profileRoutePath('openclaw-runtime')"), false)
  assert.equal(layout.includes("to: profileRoutePath('host-permissions')"), false)
  assert.equal(layout.includes("to: profileRoutePath('operations')"), false)
  assert.equal(layout.includes("to: profileRoutePath('models')"), false)
  assert.equal(layout.includes("to: '/mcphub'"), false)
  assert.equal(layout.includes("pathname.startsWith('/mcphub')"), true)
  assert.equal(layout.includes("to: profileRoutePath('mcphub')"), false)
  assert.equal(mcpHub.includes("export default function McpHub({ appMode = APP_MODES.HOST, mode = 'plugins' })"), true)
  assert.equal(mcpHub.includes('const canManageMcpServers = isHostAppMode(appMode)'), true)
  assert.equal(mcpHub.includes('if (!canManageMcpServers)'), true)
  assert.equal(settings.includes('export default function Settings()'), true)
  assert.equal(settings.includes("const updateChannel = 'stable'"), true)
  assert.equal(settings.includes('getAppUpdateStatus({ channel: updateChannel })'), true)
  assert.equal(settings.includes('返回应用'), false)
  assert.equal(settings.includes("navigate('/cloud-workbench')"), false)
  assert.equal(login.includes('export default function Login({ appMode = APP_MODES.HOST })'), true)
  assert.equal(login.includes('const isHostApp = isHostAppMode(appMode)'), true)
  assert.equal(login.includes('Host 版本'), true)
  assert.equal(login.includes('{isHostApp &&'), true)
  assert.equal(conversations.includes('export default function Conversations()'), true)
  assert.equal(conversations.includes('isMemberClientApp'), false)
  assert.equal(conversations.includes("navigate(rateLimitError ? '/models' : '/operations')"), false)
  assert.equal(conversations.includes('模型账号冷却、鉴权失败或额度异常'), true)
  assert.equal(conversations.includes("normalized.includes('billing error')"), true)
  assert.equal(conversations.includes("normalized.includes('insufficient balance')"), true)
})

test('tauri runtime registers the Host command set only', () => {
  const packageJson = JSON.parse(read('package.json'))
  const lib = read('src-tauri/src/lib.rs')

  assert.equal(
    packageJson.scripts['tauri:dev'],
    'npm run prepare:bundled-plugins && npm run build:openclaw-runtime -- --unsigned-local && tauri dev',
  )
  assert.equal(packageJson.scripts['tauri:build'], 'tauri build')
  assert.equal(packageJson.scripts['tauri:dev:employee'], undefined)
  assert.equal(packageJson.scripts['tauri:build:employee'], undefined)
  assert.equal(lib.includes('fn run_employee_app()'), false)
  assert.equal(lib.includes('fn run_admin_host_app()'), true)
  assert.equal(lib.includes('std::env::var("IMAI_APP_TARGET")'), false)
  const adminSection = lib.slice(lib.indexOf('fn run_admin_host_app()'))

  for (const command of [
    'commands::conversations::turns::conversation_send_turn',
    'commands::conversations::history::conversation_load_history',
    'commands::conversations::pairing::openclaw_profile_redeem_remote_setup',
    'commands::conversations::pairing::openclaw_profile_pairing_status',
    'commands::model::profiles::openclaw_profile_status',
    'commands::openclaw_agents::openclaw_skillhub_snapshot',
    'commands::openclaw_agents::openclaw_agent_skills_set',
    'commands::openclaw_channels::openclaw_open_external_url',
  ]) {
    assert.equal(adminSection.includes(command), true, `${command} should be available in host`)
  }

  for (const command of [
    'commands::organizations::list_organizations',
    'commands::dashboard::get_dashboard_stats',
  ]) {
    assert.equal(adminSection.includes(command), false, `${command} should be removed from host`)
  }

  for (const command of [
    'commands::model::runtime::openclaw_install',
    'commands::model::runtime::openclaw_update',
    'commands::model::runtime::openclaw_uninstall',
    'commands::model::models::openclaw_use_provider_api_key_model',
    'commands::model::models::openclaw_login_openai_codex',
    'commands::openclaw_mcp::openclaw_mcp_server_set',
    'commands::openclaw_channels::openclaw_feishu_save_account',
    'commands::openclaw_channels::openclaw_wechat_install_plugin',
    'commands::openclaw_agents::openclaw_agents_create',
    'commands::openclaw_agents::openclaw_agents_delete',
  ]) {
    assert.equal(adminSection.includes(command), true, `${command} should remain in admin host`)
  }
})

test('conversation gateway commands are split by responsibility', () => {
  const lib = read('src-tauri/src/lib.rs')
  const commandsMod = read('src-tauri/src/commands/mod.rs')
  const conversationMod = read('src-tauri/src/commands/conversations/mod.rs')
  const sessions = read('src-tauri/src/commands/conversations/sessions.rs')
  const history = read('src-tauri/src/commands/conversations/history.rs')
  const turns = read('src-tauri/src/commands/conversations/turns.rs')
  const pairing = read('src-tauri/src/commands/conversations/pairing.rs')

  assert.equal(exists('src-tauri/src/commands/conversations.rs'), false)
  assert.equal(commandsMod.includes('pub mod conversations;'), true)

  for (const moduleName of ['pairing', 'sessions', 'history', 'turns']) {
    assert.equal(conversationMod.includes(`pub mod ${moduleName};`), true, `${moduleName} should be a conversation submodule`)
  }

  for (const command of [
    'conversation_list_sessions',
    'conversation_create_session',
    'conversation_rename_session',
  ]) {
    assert.equal(sessions.includes(`pub async fn ${command}`), true)
    assert.equal(lib.includes(`commands::conversations::sessions::${command}`), true)
  }

  assert.equal(history.includes('pub async fn conversation_load_history'), true)
  assert.equal(lib.includes('commands::conversations::history::conversation_load_history'), true)

  for (const command of [
    'conversation_send_turn',
    'conversation_abort_turn',
    'conversation_subscribe_session',
  ]) {
    assert.equal(turns.includes(`pub async fn ${command}`), true)
    assert.equal(lib.includes(`commands::conversations::turns::${command}`), true)
  }

  for (const command of [
    'conversation_bridge_status',
    'conversation_attempt_gateway_connect',
    'conversation_gateway_approve_latest_pairing',
    'conversation_gateway_pairing_status',
    'conversation_prepare_gateway_connect_preview',
    'openclaw_profile_approve_latest_pairing',
    'openclaw_profile_pairing_status',
    'openclaw_profile_redeem_remote_setup',
    'openclaw_profile_remote_setup_code',
  ]) {
    assert.equal(pairing.includes(`pub async fn ${command}`), true)
    assert.equal(lib.includes(`commands::conversations::pairing::${command}`), true)
  }
  assert.equal(turns.includes('super::conversation_send_turn_impl(app, req).await'), true)
})

test('local document implementation is removed in favor of cloud documents', () => {
  const app = read('src/App.jsx')
  const layout = read('src/components/Layout.jsx')
  const commandsMod = read('src-tauri/src/commands/mod.rs')
  const servicesMod = read('src-tauri/src/services/mod.rs')
  const lib = read('src-tauri/src/lib.rs')

  assert.equal(exists('src/pages/CloudDocuments.jsx'), true)
  assert.equal(app.includes("const CloudDocuments = lazyPage(() => import('./pages/CloudDocuments'))"), true)
  assert.equal(app.includes('<Route path="/cloud-documents" element={<CloudDocuments />} />'), true)
  assert.equal(layout.includes("to: profileRoutePath('cloud-documents')"), true)

  for (const removedFile of [
    'src/pages/Knowledge.jsx',
    'src/components/BlockSuiteDocumentEditor.jsx',
    'src/lib/knowledgeDocuments.js',
    'src/lib/knowledgeDocuments.test.mjs',
    'src/lib/blockDocumentAiEdit.js',
    'src/lib/blockDocumentAiEdit.test.mjs',
    'src/lib/blocksuiteRuntime.js',
    'src/lib/blocksuiteRuntime.source.test.mjs',
    'src-tauri/src/commands/knowledge.rs',
    'src-tauri/src/services/documents.rs',
    'plugins/uniopc/imai-documents/openclaw.plugin.json',
    'plugins/uniopc/imai-workbench/openclaw.plugin.json',
  ]) {
    assert.equal(exists(removedFile), false, `${removedFile} should not exist`)
  }

  assert.equal(app.includes("import('./pages/Knowledge')"), false)
  assert.equal(app.includes('/knowledge'), false)
  assert.equal(layout.includes("t('nav.companyKnowledge')"), false)
  assert.equal(commandsMod.includes('pub mod knowledge'), false)
  assert.equal(servicesMod.includes('pub mod documents'), false)
  assert.equal(lib.includes('commands::knowledge::'), false)
})

test('legacy project and task workbench routes redirect into personal conversations', () => {
  const app = read('src/App.jsx')
  const layout = read('src/components/Layout.jsx')
  const lib = read('src-tauri/src/lib.rs')
  const mcpConfig = read('src/lib/mcpConfig.js')

  assert.equal(exists('src/pages/Dashboard.jsx'), false)
  assert.equal(exists('src/pages/Project.jsx'), false)
  assert.equal(app.includes("import Dashboard from './pages/Dashboard'"), false)
  assert.equal(app.includes("import Project from './pages/Project'"), false)
  assert.equal(app.includes('<Route path="/workbench" element={<Navigate to="/conversations" replace />} />'), true)
  assert.equal(app.includes('<Route path="/project" element={<Navigate to="/conversations" replace />} />'), true)
  assert.equal(app.includes("import CloudWorkbench from './pages/CloudWorkbench'"), false)
  assert.equal(layout.includes("invoke('list_projects'"), false)
  assert.equal(layout.includes('uniopc:open-project-create'), false)
  assert.equal(lib.includes('commands::projects::list_projects'), false)
  assert.equal(lib.includes('commands::projects::create_project'), false)
  assert.equal(lib.includes('commands::projects::update_project'), false)
  assert.equal(lib.includes('commands::projects::delete_project'), false)
  assert.equal(lib.includes('commands::projects::list_project_members'), false)
  assert.equal(lib.includes('commands::projects::list_project_assignees'), false)
  assert.equal(lib.includes('commands::tasks::'), false)
  assert.equal(mcpConfig.includes("id: 'imai-workbench'"), false)
  assert.equal(exists('plugins/uniopc/imai-workbench'), false)
})

test('desktop retires the legacy product database while retaining encrypted local documents', () => {
  const cargoToml = read('src-tauri/Cargo.toml')
  const desktopPackage = JSON.parse(read('package.json'))
  const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'))
  const commandsMod = read('src-tauri/src/commands/mod.rs')
  const servicesMod = read('src-tauri/src/services/mod.rs')
  const lib = read('src-tauri/src/lib.rs')
  const modelCommand = read('src-tauri/src/commands/model/mod.rs')
  const conversationsClient = read('src/lib/conversations/client.js')
  const conversationsPage = read('src/pages/Conversations.jsx')
  const openclawAgents = read('src-tauri/src/commands/openclaw_agents.rs')

  // The retired product backend stored workspace entities locally. Personal
  // documents are intentionally different: they use a profile-isolated
  // SQLCipher database and are the only permitted local persistence here.
  assert.equal(cargoToml.includes(['rusq', 'lite'].join('')), true)
  assert.equal(cargoToml.includes('bundled-sqlcipher'), true)
  assert.equal(exists('src-tauri/src/db.rs'), false)
  assert.equal(exists('src-tauri/src/models.rs'), false)
  assert.equal(exists('src-tauri/src/bin/imai-agent.rs'), false)
  assert.equal(desktopPackage.scripts['build:agent-cli'], undefined)
  assert.equal(desktopPackage.scripts['build:agent-cli:release'], undefined)
  assert.equal(desktopPackage.scripts['tauri:dev'].includes('build:agent-cli'), false)
  assert.equal(desktopPackage.scripts['tauri:build'].includes('build:agent-cli'), false)
  assert.equal(tauriConfig.bundle.resources['target/release/imai-agent'], undefined)

  for (const moduleName of [
    'auth',
    'dashboard',
    'employees',
    'organizations',
    'project_snapshot',
    'projects',
    'tasks',
  ]) {
    assert.equal(commandsMod.includes(`pub mod ${moduleName};`), false)
  }

  for (const moduleName of [
    'agent_context',
    'agent_interface',
    'dashboard',
    'employees',
    'knowledge',
    'organizations',
    'projects',
    'tasks',
  ]) {
    assert.equal(servicesMod.includes(`pub mod ${moduleName};`), false)
  }
  assert.equal(servicesMod.includes('pub mod local_documents;'), true)
  assert.equal(commandsMod.includes('pub mod local_documents;'), true)

  assert.equal(lib.includes(['db::init_', 'db'].join('')), false)
  assert.equal(lib.includes(['Db', 'Pool'].join('')), false)
  assert.equal(lib.includes('conversation_load_cached_history'), false)
  assert.equal(lib.includes('openclaw_agents_local_list'), false)
  assert.equal(lib.includes('openclaw_agent_documents_cached_'), false)
  assert.equal(modelCommand.includes('tauri::State'), false)
  assert.equal(conversationsClient.includes('loadCachedConversationHistory'), false)
  assert.equal(conversationsClient.includes('conversation_load_cached_history'), false)
  assert.equal(conversationsPage.includes('loadCachedConversationHistory'), false)
  assert.equal(openclawAgents.includes('sync_openclaw_employees'), false)
  assert.equal(openclawAgents.includes('load_local_openclaw_employees'), false)
  assert.equal(openclawAgents.includes('EmployeeUpsertInput'), false)
})

test('desktop docs and test fixtures no longer mention the retired local database backend', () => {
  const retiredBackendPattern = new RegExp(['sql', 'ite|rusq', 'lite|Db', 'Pool|init_', 'db'].join(''), 'i')
  const checkedPaths = [
    'AGENTS.md',
    'README.md',
    'docs/migration-local-first.md',
    'docs/uniopc-vs-multica.md',
    'docs/superpowers/plans/2026-05-09-blocksuite-documents-migration.md',
    'docs/superpowers/plans/2026-05-09-openclaw-runtime-stability.md',
    'docs/superpowers/plans/2026-05-13-task-orchestration-hard-loop.md',
    'docs/superpowers/plans/2026-05-16-blocksuite-pageeditor-source.md',
    'src/lib/conversationStore.test.mjs',
    'src/lib/employeeDirectory.test.mjs',
  ]

  for (const filePath of checkedPaths) {
    if (!exists(filePath)) continue
    assert.equal(retiredBackendPattern.test(read(filePath)), false, `${filePath} should not mention the retired backend`)
  }
})

test('gateway readiness is centralized on GatewayConnectionSnapshot', () => {
  const runtimeStatus = read('src/lib/runtimeStatus.js')
  const app = read('src/App.jsx')
  const mcpHub = read('src/pages/McpHub.jsx')
  const modelSettings = read('src/pages/ModelSettings.jsx')
  const setupGate = read('src/pages/OpenClawSetupGate.jsx')
  const operations = read('src/pages/Operations.jsx')
  const gatewayClient = read('src/lib/conversations/gatewayClient.js')
  const conversationClient = read('src/lib/conversations/client.js')
  const conversationsRs = read('src-tauri/src/commands/conversations/mod.rs')
  const gatewayRuntimeRs = read('src-tauri/src/services/openclaw_gateway_connection.rs')
  const servicesMod = read('src-tauri/src/services/mod.rs')

  assert.equal(runtimeStatus.includes('status?.gateway_running'), false)
  assert.equal(runtimeStatus.includes('missing_gateway'), false)
  assert.equal(runtimeStatus.includes('getGatewayConnectionSnapshot'), true)
  assert.equal(runtimeStatus.includes('getGatewayConnectionRuntimeKey'), true)
  assert.equal(runtimeStatus.includes('gatewayPortFromSnapshot'), true)
  assert.equal(runtimeStatus.includes('isGatewayConnectionReady'), true)
  assert.equal(runtimeStatus.includes('runtimeState.gatewayConnection.snapshots[profile]'), false)

  assert.equal(app.includes("connectionSnapshot?.status === 'connected'"), false)
  assert.equal(app.includes('isGatewayConnectionReady(connectionSnapshot)'), true)
  assert.equal(mcpHub.includes("connectionSnapshot?.status === 'connected'"), false)
  assert.equal(mcpHub.includes('isGatewayConnectionReady(connectionSnapshot)'), true)
  assert.equal(modelSettings.includes('status?.gateway_running'), false)
  assert.equal(modelSettings.includes('getGatewayConnectionSnapshot(activeProfile, gatewayPort)'), true)
  assert.equal(modelSettings.includes('runtime.gatewayConnection.snapshots[activeProfile]'), false)
  assert.equal(modelSettings.includes("invoke('openclaw_start_gateway')"), false)
  assert.equal(modelSettings.includes("invoke('openclaw_stop_gateway')"), false)
  assert.equal(modelSettings.includes('refreshGatewayConnectionSnapshot'), true)
  assert.equal(modelSettings.includes('openclaw_connection_start_local'), true)
  assert.equal(modelSettings.includes('openclaw_connection_stop_local'), true)
  assert.equal(modelSettings.includes("invoke('openclaw_models_snapshot', { profile: activeProfile })"), false)
  assert.equal(modelSettings.includes('engineClient.models.snapshot({ profile: activeProfile })'), true)
  assert.equal(modelSettings.includes("invoke('openclaw_login_openai_codex'"), false)
  assert.equal(modelSettings.includes("invoke('openclaw_models_snapshot')"), false)
  assert.equal(modelSettings.includes('statusFromActiveModelSnapshot(modelSnapshot, openClawStatus)'), true)
  assert.equal(modelSettings.includes('providerReadyFromAuthProfiles,'), true)
  assert.equal(setupGate.includes('getGatewayConnectionSnapshot(connectionProfile, gatewayPort)'), true)
  assert.equal(setupGate.includes('runtime.gatewayConnection.snapshots[connectionProfile]'), false)
  assert.equal(setupGate.includes('profileRuntimeStatus?.gateway_running'), false)
  assert.equal(setupGate.includes('profileRuntimeStatus?.gatewayRunning'), false)
  assert.equal(setupGate.includes('profileRuntimeStatus?.gateway_rpc_ok'), false)
  assert.equal(setupGate.includes('profileRuntimeStatus?.gatewayRpcOk'), false)
  assert.equal(operations.includes('getGatewayConnectionSnapshot(activeProfile, gatewayPort)'), true)
  assert.equal(operations.includes('runtime.gatewayConnection.snapshots[activeProfile]'), false)
  assert.equal(operations.includes("invoke('openclaw_stop_gateway')"), false)
  assert.equal(operations.includes('openclaw_connection_stop_local'), false)
  assert.equal(operations.includes('const gatewayConnected = isGatewayConnectionReady(connectionSnapshot)'), true)
  assert.equal(operations.includes('const currentUrl = connectionDashboardUrl ||'), false)
  assert.equal(operations.includes('Gateway 的启动、停止、连接检测都在成员详情的“本机 Gateway”页签里处理。'), false)
  assert.equal(operations.includes('核心运行链路'), false)
  assert.equal(operations.includes('对话数据面'), false)

  assert.equal(gatewayClient.includes('openClawStatus?.gateway_running'), false)
  assert.equal(gatewayClient.includes('connectionSnapshot'), true)
  assert.equal(gatewayClient.includes('isGatewayConnectionReady'), true)
  assert.equal(conversationClient.includes('getConversationRuntimeStatus(openClawStatus = null, connectionSnapshot = null)'), true)

  assert.equal(conversationsRs.includes('if status.gateway_running'), false)
  assert.equal(conversationsRs.includes('ensure_conversation_gateway_ready'), true)
  assert.equal(conversationsRs.includes('openclaw_gateway_connection::request'), true)
  assert.equal(conversationsRs.includes('openclaw_gateway_connection::subscribe_session'), true)
  assert.equal(conversationsRs.includes('openclaw_gateway_stream::GatewayStreamManager'), false)
  assert.equal(conversationsRs.includes('openclaw_connection_start_local('), false)
  assert.equal(conversationsRs.includes('openclaw_connection_test_remote('), false)
  assert.equal(gatewayRuntimeRs.includes('GatewayRecoveryAction::StartLocal'), true)
  assert.equal(gatewayRuntimeRs.includes('GatewayRecoveryAction::RestartRemoteSshTunnel'), true)
  assert.equal(servicesMod.includes('pub mod openclaw_gateway_connection;'), true)
  assert.equal(read('src-tauri/src/commands/conversations/pairing.rs').includes('conversation_bridge_status(\n    app: AppHandle,\n    profile: Option<String>,'), true)
})

test('gateway connection UI lives on profile detail instead of operations', () => {
  const operations = read('src/pages/Operations.jsx')
  const detail = read('src/pages/AdminMemberDetail.jsx')

  assert.equal(operations.includes("const requiresLocalOpenClaw = shouldRequireLocalOpenClawSetup(workspaceProfile)"), true)
  assert.equal(operations.includes("const isMemberRemoteGateway = !requiresLocalOpenClaw"), false)
  assert.equal(operations.includes("const [remoteTransportDraft, setRemoteTransportDraft] = useState(null)"), false)
  assert.equal(operations.includes("const enforcedGatewayLocation = requiresLocalOpenClaw ? 'local' : 'remote'"), false)
  assert.equal(operations.includes('const gatewayLocation = enforcedGatewayLocation'), false)
  assert.equal(operations.includes("const remoteTransportMode = remoteTransportDraft ||"), false)
  assert.equal(operations.includes('async function setGatewayLocation(location)'), false)
  assert.equal(operations.includes("function setRemoteTransportMode(mode)"), false)
  assert.equal(operations.includes('const isRemoteDirectConnectionMode = connectionMode === \'remote_direct\''), false)
  assert.equal(operations.includes('const isRemoteSshConnectionMode = connectionMode === \'remote_ssh_tunnel\''), false)
  assert.equal(operations.includes('async function saveRemoteDirect()'), false)
  assert.equal(operations.includes('async function saveRemoteSsh()'), false)
  assert.equal(operations.includes("invoke('openclaw_connection_save_remote_direct'"), false)
  assert.equal(operations.includes("invoke('openclaw_connection_save_remote_ssh'"), false)
  assert.equal(operations.includes("invoke('openclaw_tailscale_status'"), false)
  assert.equal(operations.includes("invoke('openclaw_tailscale_apply'"), false)
  assert.equal(operations.includes('Member 固定使用 Owner 分配的远程 Gateway'), false)
  assert.equal(operations.includes('Owner/Admin 固定使用这台 Mac 上的本机 Gateway'), false)
  assert.equal(operations.includes("value={gatewayLocation}"), false)
  assert.equal(operations.includes('onChange={(event) => setGatewayLocation(event.target.value)}'), false)
  assert.equal(operations.includes('<option value="local">'), false)
  assert.equal(operations.includes('<option value="remote">'), false)
  assert.equal(operations.includes('CONNECTION_MODES.map'), false)
  assert.equal(operations.includes('Remote Access Transport'), false)
  assert.equal(detail.includes('Remote Access'), false)
  assert.equal(detail.includes('Member 端优先使用官方 setup code / openclaw://gateway'), false)
  assert.equal(detail.includes('Local Gateway'), false)
  assert.equal(detail.includes('Tailscale (Gateway access)'), false)
  assert.equal(operations.includes('xl:grid-cols-3'), false)
  assert.equal(operations.includes('{gatewayLocation === \'local\' && ('), false)
  assert.equal(operations.includes('{gatewayLocation === \'remote\' && ('), false)
  assert.equal(operations.includes("{gatewayLocation === 'remote' && remoteTransportMode === 'remote_direct' && ("), false)
  assert.equal(operations.includes("{gatewayLocation === 'remote' && remoteTransportMode === 'remote_ssh_tunnel' && ("), false)
  assert.equal(operations.includes('visibleConnectionError'), false)
})

test('owner-hosted tailscale gateway access controls are removed from member detail', () => {
  const detail = read('src/pages/AdminMemberDetail.jsx')
  const commands = read('src-tauri/src/commands/mod.rs')
  const lib = read('src-tauri/src/lib.rs')
  const service = read('src-tauri/src/services/mod.rs')

  assert.equal(detail.includes("invoke('openclaw_tailscale_status'"), false)
  assert.equal(detail.includes("invoke('openclaw_tailscale_apply'"), false)
  assert.equal(detail.includes('Tailscale (Gateway access)'), false)
  assert.equal(detail.includes('Tailnet (Serve)'), false)
  assert.equal(detail.includes('Public (Funnel)'), false)
  assert.equal(detail.includes('Require Gateway access password'), false)
  assert.equal(detail.includes('ownerTailscalePasswordAlreadySet'), false)
  assert.equal(detail.includes('已设置，留空保持不变，输入新密码覆盖'), false)
  assert.equal(detail.includes('Gateway access password configured'), false)
  assert.equal(detail.includes("setOwnerTailscalePassword('')"), false)
  assert.equal(detail.includes('Member remote setup'), false)
  assert.equal(detail.includes('Gateway endpoint'), false)
  assert.equal(detail.includes('Gateway access password'), false)
  assert.equal(detail.includes('use the password set on Host'), false)
  assert.equal(detail.includes('Member 端使用这里的 endpoint 和 Gateway 访问密码连接'), false)
  assert.equal(detail.includes('Gateway 访问密码填这里设置的同一个密码'), false)
  assert.equal(detail.includes('Member 端按官方 remote 模式使用 token/pairing'), false)
  assert.equal(detail.includes('复制 setup code'), false)
  assert.equal(detail.includes("ownerTailscaleMode === 'serve'"), false)
  assert.equal(detail.includes("ownerTailscaleMode === 'funnel'"), false)
  // The tailscale/discovery backend modules are fully removed (dead code, no UI
  // caller); forbid them from coming back without a deliberate decision.
  assert.equal(commands.includes('pub mod openclaw_tailscale;'), false)
  assert.equal(service.includes('pub mod openclaw_tailscale;'), false)
  assert.equal(lib.includes('commands::openclaw_tailscale::'), false)
  assert.equal(commands.includes('pub mod openclaw_gateway_discovery;'), false)
  assert.equal(service.includes('pub mod openclaw_gateway_discovery;'), false)
  assert.equal(lib.includes('commands::openclaw_gateway_discovery::'), false)
})

test('model and operations UI is clearly scoped to the current profile', () => {
  const zh = read('src/locales/zh.json')
  const en = read('src/locales/en.json')
  const modelSettings = read('src/pages/ModelSettings.jsx')
  const operations = read('src/pages/Operations.jsx')
  const admin = read('src/pages/Admin.jsx')

  assert.equal(zh.includes('"support": "当前 Profile"'), false)
  assert.equal(zh.includes('"organization": "组织"'), true)
  assert.equal(zh.includes('"system": "系统管理"'), true)
  assert.equal(zh.includes('"operations": "Profile 运行中心"'), true)
  assert.equal(zh.includes('"models": "Profile 模型与能力"'), true)
  assert.equal(en.includes('"support": "Current Profile"'), false)
  assert.equal(en.includes('"organization": "Organization"'), true)
  assert.equal(en.includes('"system": "System"'), true)
  assert.equal(en.includes('"operations": "Profile Operations"'), true)
  assert.equal(en.includes('"models": "Profile Models & Capabilities"'), true)
  assert.equal(modelSettings.includes('<h1 className={HEADING.page}>Profile 模型与能力</h1>'), true)
  assert.equal(modelSettings.includes('当前 Uniopc 引擎 Profile'), true)
  assert.equal(modelSettings.includes('每个 profile 的官方模型与媒体能力配置独立保存'), true)
  assert.equal(operations.includes('当前 Profile 运行中心'), false)
  assert.equal(operations.includes('模型配置属于当前 profile，不属于组织全局设置'), false)
  assert.equal(operations.includes('Profile 模型'), true)
  assert.equal(admin.includes("{ key: 'models', label: '模型策略' }"), false)
  assert.equal(admin.includes('这里只定义组织允许的 provider 和默认策略，不保存任何 profile 的模型登录态。'), false)
  assert.equal(admin.includes("profileWorkspacePath(member, 'models')"), false)
  assert.equal(admin.includes("navigate('/models')"), false)
})

test('auth bootstrap does not directly query profiles table', () => {
  const auth = read('src/hooks/useAuth.jsx')

  assert.equal(auth.includes(".from('profiles')"), false)
  assert.equal(auth.includes('buildProfileFromAuthUser'), true)
})

test('shared gateway runtime owns remote ssh recovery without conversation fallback', () => {
  const connectionCommands = read('src-tauri/src/commands/openclaw_connection.rs')
  const conversationsRs = read('src-tauri/src/commands/conversations/mod.rs')
  const gatewayRuntimeRs = read('src-tauri/src/services/openclaw_gateway_connection.rs')

  assert.equal(connectionCommands.includes('ensure_remote_ssh_tunnel_if_needed(&app, &effective_config).await?'), true)
  assert.equal(connectionCommands.includes('async fn ensure_remote_ssh_tunnel_if_needed'), true)
  assert.equal(conversationsRs.includes('should_attempt_remote_ssh_tunnel_recovery(&snapshot)'), false)
  assert.equal(conversationsRs.includes('openclaw_connection_test_remote('), false)
  assert.equal(gatewayRuntimeRs.includes('GatewayRecoveryAction::RestartRemoteSshTunnel'), true)
  assert.equal(gatewayRuntimeRs.includes('openclaw_connection_test_remote_for_runtime'), true)
})
