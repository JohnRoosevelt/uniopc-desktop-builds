import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AUTO_DISABLED_ERROR_THRESHOLD,
  SCHEDULE_MODES,
  SESSION_TARGETS,
  STATUS,
  deriveStatus,
  describeDiagnosticSource,
  describeErrorReason,
  describePayload,
  describeSchedule,
  describeSessionTarget,
  employeeLabel,
  employeeName,
  groupJobsByEmployee,
  isAgentCreated,
  isContentEditable,
  isHighFrequency,
  sessionTargetValue,
} from './automations.js'

test('工作日 five-day selection reads as 工作日, not a weekday list', () => {
  const label = describeSchedule({
    mode: SCHEDULE_MODES.weekly,
    time: '08:00',
    days: [1, 2, 3, 4, 5],
  })
  assert.equal(label, '工作日 08:00')
})

test('partial weekday selection lists the days in Chinese', () => {
  const label = describeSchedule({
    mode: SCHEDULE_MODES.weekly,
    time: '18:30',
    days: [5, 1, 3],
  })
  assert.equal(label, '周一、周三、周五 18:30')
})

test('a weekly form covering all seven days reads as 每天', () => {
  const label = describeSchedule({
    mode: SCHEDULE_MODES.weekly,
    time: '07:00',
    days: [1, 2, 3, 4, 5, 6, 7],
  })
  assert.equal(label, '每天 07:00')
})

test('interval and advanced modes have their own summaries', () => {
  assert.equal(
    describeSchedule({ mode: SCHEDULE_MODES.interval, everyValue: 2, everyUnit: 'hours' }),
    '每隔 2 小时',
  )
  assert.equal(
    describeSchedule({ mode: SCHEDULE_MODES.expr, expr: '0 9 1 * *' }),
    '自定义计划 0 9 1 * *',
  )
})

// The engine disables a job by itself after 10 consecutive failures. If that
// collapses into a plain 已暂停, the user sees a task that just went quiet.
test('a job the engine auto-disabled is distinguished from one a human paused', () => {
  const autoDisabled = {
    enabled: false,
    state: { consecutiveErrors: AUTO_DISABLED_ERROR_THRESHOLD },
  }
  const humanPaused = { enabled: false, state: { consecutiveErrors: 2 } }
  assert.equal(deriveStatus(autoDisabled), STATUS.autoDisabled)
  assert.equal(deriveStatus(humanPaused), STATUS.paused)
})

test('a finished one-shot job reads as 已完成 rather than 已暂停', () => {
  const job = {
    enabled: false,
    scheduleForm: { mode: SCHEDULE_MODES.once },
    state: { lastRunAtMs: 1_785_000_000_000 },
  }
  assert.equal(deriveStatus(job), STATUS.completed)
})

test('an enabled job whose last run errored needs fixing', () => {
  assert.equal(deriveStatus({ enabled: true, state: { lastRunStatus: 'error' } }), STATUS.needsFix)
  assert.equal(deriveStatus({ enabled: true, state: { lastRunStatus: 'ok' } }), STATUS.active)
})

test('engine error reasons are translated, never shown raw', () => {
  assert.equal(
    describeErrorReason({ state: { lastErrorReason: 'auth_permanent' } }),
    '凭据已失效且无法自动恢复，请重新授权',
  )
  assert.equal(describeErrorReason({ state: { lastErrorReason: 'billing' } }), '账号额度不足，请充值后重试')
  // Unknown classifications fall back to the engine text rather than vanishing.
  assert.equal(
    describeErrorReason({ state: { lastErrorReason: 'brand_new_code', lastError: 'boom' } }),
    'boom',
  )
})

test('diagnostic stages are labelled so a failure points at a stage', () => {
  assert.equal(describeDiagnosticSource('delivery'), '投递')
  assert.equal(describeDiagnosticSource('model-preflight'), '模型')
  assert.equal(describeDiagnosticSource('cron-preflight'), '准备')
  assert.equal(describeDiagnosticSource('something-new'), 'something-new')
})

// A GUI that can author shell payloads is a real security surface; command and
// script jobs stay read-only, matching the official macOS app's own curation.
test('only agentTurn jobs are content-editable', () => {
  assert.equal(isContentEditable({ payload: { kind: 'agentTurn' } }), true)
  assert.equal(isContentEditable({ payload: { kind: 'command' } }), false)
  assert.equal(isContentEditable({ payload: { kind: 'script' } }), false)
})

test('payload summaries cover every engine payload kind', () => {
  assert.equal(describePayload({ payload: { kind: 'agentTurn', message: '汇总日报' } }), '汇总日报')
  assert.equal(describePayload({ payload: { kind: 'command', argv: ['npm', 'test'] } }), 'npm test')
  assert.equal(describePayload({ payload: { kind: 'script' } }), '脚本任务')
})

// owner.sessionKey is only stamped when the engine created the job from an
// agent tool call, so it is what separates 员工排的班 from 人排的班.
test('agent-created jobs are identified by the owner session key', () => {
  assert.equal(isAgentCreated({ owner: { agentId: 'sales', sessionKey: 'agent:sales' } }), true)
  assert.equal(isAgentCreated({ owner: { agentId: 'sales' } }), false)
  assert.equal(isAgentCreated({}), false)
})

test('session targets are translated and never expose the engine main lane', () => {
  assert.equal(describeSessionTarget({ sessionTarget: 'isolated' }), '独立运行')
  assert.equal(describeSessionTarget({ sessionTarget: 'session:cron-abc' }), '持续在一个会话里')
  assert.equal(describeSessionTarget({ sessionTarget: 'current' }), '当前对话')
})

test('sticky session keys are stable per job and fall back before an id exists', () => {
  assert.equal(sessionTargetValue(SESSION_TARGETS.sticky, 'abc'), 'session:cron-abc')
  assert.equal(sessionTargetValue(SESSION_TARGETS.sticky, null), 'isolated')
  assert.equal(sessionTargetValue(SESSION_TARGETS.isolated, 'abc'), 'isolated')
})

// We resell tokens, and an employee can create a recurring job from inside a
// chat — so the sub-30-minute gate is a cost control, not a nicety.
test('sub-30-minute intervals trip the high-frequency gate', () => {
  assert.equal(isHighFrequency({ mode: SCHEDULE_MODES.interval, everyValue: 5, everyUnit: 'minutes' }), true)
  assert.equal(isHighFrequency({ mode: SCHEDULE_MODES.interval, everyValue: 30, everyUnit: 'minutes' }), false)
  assert.equal(isHighFrequency({ mode: SCHEDULE_MODES.interval, everyValue: 1, everyUnit: 'hours' }), false)
  // A daily job is never high-frequency however early it runs.
  assert.equal(isHighFrequency({ mode: SCHEDULE_MODES.daily, time: '00:05' }), false)
})

// agents.list often returns the agent id as `name`; the real employee name is
// resolved from that agent's IDENTITY.md into identityName.
test('employee display names prefer identityName over the agent id', () => {
  assert.equal(employeeName({ id: 'sales', name: 'sales', identityName: '张明' }), '张明')
  assert.equal(employeeName({ id: 'sales', name: 'sales' }), 'sales')
  assert.equal(employeeLabel([{ id: 'sales', identityName: '张明' }], 'sales'), '张明')
  assert.equal(employeeLabel([], 'ghost'), 'ghost')
})

test('grouping by employee keeps unassigned jobs under the default agent', () => {
  const groups = groupJobsByEmployee(
    [{ id: '1', agentId: 'sales' }, { id: '2' }, { id: '3', agentId: 'sales' }],
    [{ id: 'sales', identityName: '张明' }],
  )
  const byAgent = Object.fromEntries(groups.map(group => [group.agentId, group.jobs.length]))
  assert.equal(byAgent.sales, 2)
  assert.equal(byAgent.main, 1)
})
