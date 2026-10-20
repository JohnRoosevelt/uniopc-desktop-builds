import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const page = readFileSync(fileURLToPath(new URL('./Automations.jsx', import.meta.url)), 'utf8')
const layout = readFileSync(fileURLToPath(new URL('../components/Layout.jsx', import.meta.url)), 'utf8')
const app = readFileSync(fileURLToPath(new URL('../App.jsx', import.meta.url)), 'utf8')

test('定时任务 is a first-class sidebar entry, profile-scoped like the rest of the account data', () => {
  assert.equal(layout.includes("to: profileRoutePath('automations')"), true)
  assert.equal(layout.includes("label: t('nav.automations')"), true)
  assert.equal(app.includes('<Route path="/automations" element={<Automations />} />'), true)
  assert.equal(
    app.includes('<Route path="/profiles/:profileRef/automations" element={profileWorkspaceElement(<Automations />)} />'),
    true,
  )
})

// The scheduler runs inside the gateway process, so a local engine does not
// fire while the machine sleeps. Dropping this strip turns every missed run
// into a support ticket.
test('the page states plainly that a local engine does not run while asleep', () => {
  assert.equal(page.includes('function EngineReachStrip'), true)
  assert.equal(page.includes('<EngineReachStrip />'), true)
  assert.equal(page.includes('电脑关机或休眠期间任务不会运行'), true)
})

// Jobs are owned by an agent at the engine level (there is no ownerless job),
// so the employee is the organising unit — not an optional sort order.
test('grouping defaults to 按员工', () => {
  assert.equal(page.includes("useState('agent')"), true)
})

test('the editor requires an employee and a prompt before saving', () => {
  assert.equal(page.includes('请选择要排班的 AI 员工。'), true)
  assert.equal(page.includes('请填写要让员工做什么。'), true)
})

// The engine auto-disables a job after 10 consecutive failures; showing it as
// a plain 已暂停 hides the fact that it stopped on its own.
test('auto-disabled jobs explain themselves on the card', () => {
  assert.equal(page.includes('连续失败 10 次，引擎已自动停用该任务。'), true)
})

// The differentiator over both the official macOS app and Accio: the engine
// tags each diagnostic with the stage that produced it.
test('run history renders the engine per-stage diagnostics', () => {
  assert.equal(page.includes('describeDiagnosticSource'), true)
  assert.equal(page.includes('lastDiagnostics'), true)
})

// tz defaults to the GATEWAY HOST's zone, which is wrong the moment the engine
// is a remote 7x24 box — so the editor always shows which zone is in effect.
test('the editor surfaces the timezone the schedule will use', () => {
  assert.equal(page.includes('时区：'), true)
  assert.equal(page.includes('localTimeZone'), true)
})

test('command and script jobs stay read-only in the UI', () => {
  assert.equal(page.includes('isContentEditable'), true)
  assert.equal(page.includes('（此处仅可编辑名称、描述和调度）'), true)
})

// A GUI able to author shell payloads is a real security surface. The editor
// only ever writes agentTurn.
test('the editor never constructs a command or script payload', () => {
  assert.equal(page.includes("kind: 'agentTurn'"), true)
  assert.equal(page.includes("kind: 'command'"), false)
  assert.equal(page.includes("kind: 'script'"), false)
})

// Re-encoding a reduced schedule during an unrelated toggle is how a
// 高级表达式 job would silently lose its expression.
test('enable/disable goes through the schedule-free patch path', () => {
  assert.equal(page.includes('setAutomationEnabled'), true)
  assert.equal(page.includes('updateAutomation(null, job.id, form'), true)
})
