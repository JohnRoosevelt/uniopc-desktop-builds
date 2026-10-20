import { invoke } from '@tauri-apps/api/core'

// 定时任务 = 给 AI 员工排班。
//
// The engine owns the schedule store (`cron_jobs` / `cron_run_logs`); nothing
// here is mirrored to Supabase. An AI employee can create jobs for itself
// through the engine's `cron` agent tool, so the cloud copy would drift the
// moment it existed — and the desktop connects as an *operator*, which means
// `cron.list` already returns every employee's jobs without us aggregating.
//
// The schedule shape (`scheduleForm`) is produced and consumed by Rust
// (`commands/openclaw_cron.rs`) so the lossy cron-expression reduction has a
// single tested implementation. Everything in this file is presentation only.

export const SCHEDULE_MODES = {
  once: 'once',
  daily: 'daily',
  weekly: 'weekly',
  interval: 'interval',
  expr: 'expr',
}

// ISO weekdays, matching both the engine's croner numbering (1=Mon…7=Sun,
// where 7 and 0 are both Sunday) and the Rust form.
export const WEEKDAYS = [
  { day: 1, label: '一' },
  { day: 2, label: '二' },
  { day: 3, label: '三' },
  { day: 4, label: '四' },
  { day: 5, label: '五' },
  { day: 6, label: '六' },
  { day: 7, label: '日' },
]

const WORKDAYS = [1, 2, 3, 4, 5]

export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

export function defaultScheduleForm() {
  return {
    mode: SCHEDULE_MODES.daily,
    onceAtMs: Date.now() + 60 * 60 * 1000,
    time: '09:00',
    days: [...WORKDAYS],
    everyValue: 1,
    everyUnit: 'hours',
    expr: '',
    tz: localTimeZone(),
  }
}

const INTERVAL_UNIT_LABELS = {
  seconds: '秒',
  minutes: '分钟',
  hours: '小时',
  days: '天',
}

function sameDays(days, expected) {
  if (!Array.isArray(days) || days.length !== expected.length) return false
  return expected.every((day, index) => days[index] === day)
}

function formatDateTime(ms) {
  if (!Number.isFinite(ms)) return '--'
  const date = new Date(ms)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatRunAt(ms) {
  return formatDateTime(Number(ms))
}

/** 运行计划 —— the one-line human summary shown on every card. */
export function describeSchedule(form) {
  if (!form || typeof form !== 'object') return '自定义计划'
  const time = String(form.time || '').slice(0, 5)
  switch (form.mode) {
    case SCHEDULE_MODES.once:
      return `单次 ${formatDateTime(Number(form.onceAtMs))}`
    case SCHEDULE_MODES.daily:
      return `每天 ${time}`
    case SCHEDULE_MODES.weekly: {
      const days = Array.isArray(form.days) ? [...form.days].sort((a, b) => a - b) : []
      if (sameDays(days, WORKDAYS)) return `工作日 ${time}`
      if (days.length === 7) return `每天 ${time}`
      const names = days
        .map(day => WEEKDAYS.find(entry => entry.day === day)?.label)
        .filter(Boolean)
        .map(label => `周${label}`)
      return names.length > 0 ? `${names.join('、')} ${time}` : '自定义计划'
    }
    case SCHEDULE_MODES.interval: {
      const unit = INTERVAL_UNIT_LABELS[form.everyUnit] || INTERVAL_UNIT_LABELS.minutes
      return `每隔 ${form.everyValue || 1} ${unit}`
    }
    case SCHEDULE_MODES.expr:
      return form.expr ? `自定义计划 ${form.expr}` : '自定义计划'
    default:
      return '自定义计划'
  }
}

// The engine disables a job on its own after 10 consecutive execution failures
// (or 3 schedule-computation failures). Without a distinct status for that, the
// job just goes quiet and the user has no idea it stopped — so this is the one
// state that must never collapse into a plain "已暂停".
export const AUTO_DISABLED_ERROR_THRESHOLD = 10

export const STATUS = {
  active: 'active',
  paused: 'paused',
  completed: 'completed',
  autoDisabled: 'autoDisabled',
  needsFix: 'needsFix',
}

export const STATUS_LABELS = {
  [STATUS.active]: '运行中',
  [STATUS.paused]: '已暂停',
  [STATUS.completed]: '已完成',
  [STATUS.autoDisabled]: '已自动停用',
  [STATUS.needsFix]: '需修复',
}

export const STATUS_TONES = {
  [STATUS.active]: 'border-subtle bg-success-surface text-success-text',
  [STATUS.paused]: 'border-subtle bg-surface-overlay text-secondary',
  [STATUS.completed]: 'border-subtle bg-info-surface text-info-text',
  [STATUS.autoDisabled]: 'border-subtle bg-danger-surface text-danger-text',
  [STATUS.needsFix]: 'border-subtle bg-warning-surface text-warning-text',
}

function jobState(job) {
  return (job && typeof job.state === 'object' && job.state) || {}
}

export function isOnceJob(job) {
  return job?.scheduleForm?.mode === SCHEDULE_MODES.once
}

export function deriveStatus(job) {
  if (!job) return STATUS.paused
  const state = jobState(job)
  const consecutiveErrors = Number(state.consecutiveErrors || 0)
  if (!job.enabled) {
    if (consecutiveErrors >= AUTO_DISABLED_ERROR_THRESHOLD) return STATUS.autoDisabled
    // A one-shot job that already ran is finished, not paused by anyone.
    if (isOnceJob(job) && Number(state.lastRunAtMs || 0) > 0) return STATUS.completed
    return STATUS.paused
  }
  if (state.lastRunStatus === 'error') return STATUS.needsFix
  return STATUS.active
}

// Engine error classification → business language. Leaving `lastErrorReason`
// untranslated is how "auth_permanent" ends up in front of a sales manager.
const ERROR_REASON_HINTS = {
  auth: '凭据已失效，请重新授权',
  auth_permanent: '凭据已失效且无法自动恢复，请重新授权',
  billing: '账号额度不足，请充值后重试',
  rate_limit: '上游限流，稍后会自动重试',
  overloaded: '上游服务繁忙，稍后会自动重试',
  server_error: '上游服务异常，稍后会自动重试',
  timeout: '执行超时，可在高级设置里调高超时时间',
  context_overflow: '上下文过长，建议改用「独立运行」',
  model_not_found: '任务配置的模型不可用，请重新选择模型',
  session_expired: '绑定会话已失效，请重新选择会话',
  empty_response: '模型没有返回内容',
  no_error_details: '执行失败，但引擎没有给出更多信息',
  unclassified: '执行失败，原因未分类',
  unknown: '执行失败，原因未知',
}

export function describeErrorReason(job) {
  const state = jobState(job)
  const reason = state.lastErrorReason
  if (reason && ERROR_REASON_HINTS[reason]) return ERROR_REASON_HINTS[reason]
  return state.lastError || state.lastDiagnosticSummary || ''
}

// Diagnostics arrive tagged by the stage that produced them. Grouping the run
// detail this way is the whole point of the history screen: the useful question
// is not "did it fail" but "which stage failed".
export const DIAGNOSTIC_SOURCE_LABELS = {
  'cron-preflight': '准备',
  'cron-setup': '准备',
  'model-preflight': '模型',
  'agent-run': '执行',
  tool: '工具',
  exec: '命令',
  delivery: '投递',
}

export function describeDiagnosticSource(source) {
  return DIAGNOSTIC_SOURCE_LABELS[source] || source || '其它'
}

export const RUN_STATUS_LABELS = {
  ok: '成功',
  error: '失败',
  skipped: '已跳过',
  cancelled: '已中断',
}

/**
 * Only 智能体任务 (agentTurn) is editable in the UI. `command` / `script` jobs
 * are created by employees through the agent tool or by advanced users on the
 * host — a GUI that can author shell payloads is a real security surface, and
 * the official macOS app curates the same way. Their name/schedule/toggle stay
 * editable so a human can still control *when* they run.
 */
export const PAYLOAD_KINDS = {
  agentTurn: 'agentTurn',
  command: 'command',
  script: 'script',
  systemEvent: 'systemEvent',
}

export function payloadKind(job) {
  return job?.payload?.kind || PAYLOAD_KINDS.agentTurn
}

export function isContentEditable(job) {
  return payloadKind(job) === PAYLOAD_KINDS.agentTurn
}

export function describePayload(job) {
  const payload = job?.payload
  if (!payload || typeof payload !== 'object') return '--'
  switch (payload.kind) {
    case PAYLOAD_KINDS.agentTurn:
      return String(payload.message || '').slice(0, 120) || '--'
    case PAYLOAD_KINDS.command: {
      const argv = Array.isArray(payload.argv) ? payload.argv.join(' ') : ''
      return argv.slice(0, 120) || '--'
    }
    case PAYLOAD_KINDS.script:
      return '脚本任务'
    case PAYLOAD_KINDS.systemEvent:
      return String(payload.text || '').slice(0, 120) || '--'
    default:
      return '--'
  }
}

export const PAYLOAD_KIND_LABELS = {
  [PAYLOAD_KINDS.agentTurn]: '员工任务',
  [PAYLOAD_KINDS.command]: '命令',
  [PAYLOAD_KINDS.script]: '脚本',
  [PAYLOAD_KINDS.systemEvent]: '系统事件',
}

/**
 * `owner.sessionKey` is only set when the engine stamped the job from an agent
 * tool call, so its presence is what distinguishes 员工自己排的班 from 人排的班.
 */
export function isAgentCreated(job) {
  return Boolean(job?.owner?.sessionKey)
}

// 会话归属, translated. `main` is the engine's internal automation lane
// (systemEvent only) and is never offered.
export const SESSION_TARGETS = {
  isolated: 'isolated',
  sticky: 'sticky',
  current: 'current',
}

export function describeSessionTarget(job) {
  const target = String(job?.sessionTarget || '')
  if (target.startsWith('session:')) return '持续在一个会话里'
  if (target === 'current') return '当前对话'
  if (target === 'main') return '主会话'
  return '独立运行'
}

export function sessionTargetValue(kind, jobId) {
  if (kind === SESSION_TARGETS.sticky) {
    // A stable per-job key so context accumulates across runs and the user can
    // open the conversation. Falls back to isolated until the job has an id.
    return jobId ? `session:cron-${jobId}` : 'isolated'
  }
  if (kind === SESSION_TARGETS.current) return 'current'
  return 'isolated'
}

/**
 * 高频任务 gate. We resell tokens, so an every-few-minutes recurring job is a
 * direct cost surface — and an employee can create one from inside a chat.
 */
export const HIGH_FREQUENCY_THRESHOLD_MS = 30 * 60 * 1000

const UNIT_MS = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 }

export function isHighFrequency(form) {
  if (!form || form.mode !== SCHEDULE_MODES.interval) return false
  const unitMs = UNIT_MS[form.everyUnit] || UNIT_MS.minutes
  return Math.max(1, Number(form.everyValue) || 1) * unitMs < HIGH_FREQUENCY_THRESHOLD_MS
}

export function employeeName(employee) {
  if (!employee) return ''
  // agents.list `name` is often just the agent id; the real employee name lives
  // in that agent's IDENTITY.md, which Rust already resolves into identityName.
  return String(employee.identityName || employee.name || employee.id || '').trim()
}

export function employeeLabel(employees, agentId) {
  const id = String(agentId || '').trim()
  if (!id) return '默认员工'
  const match = (employees || []).find(entry => entry.id === id)
  return employeeName(match) || id
}

export function groupJobsByEmployee(jobs, employees) {
  const groups = new Map()
  for (const job of jobs || []) {
    const agentId = String(job.agentId || '').trim() || 'main'
    if (!groups.has(agentId)) {
      groups.set(agentId, { agentId, label: employeeLabel(employees, agentId), jobs: [] })
    }
    groups.get(agentId).jobs.push(job)
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
}

export async function listAutomations(profile, params = {}) {
  return invoke('openclaw_cron_list', { profile: profile || null, params })
}

export async function getAutomation(profile, id) {
  return invoke('openclaw_cron_get', { profile: profile || null, id })
}

export async function createAutomation(profile, schedule, job) {
  return invoke('openclaw_cron_add', { request: { profile: profile || null, schedule, job } })
}

export async function updateAutomation(profile, id, schedule, job) {
  return invoke('openclaw_cron_update', { request: { profile: profile || null, id, schedule, job } })
}

/**
 * Single-field edits (enable/disable) deliberately skip the schedule round-trip:
 * re-encoding a reduced schedule on an unrelated toggle is how a 高级表达式 job
 * would silently lose its expression.
 */
export async function patchAutomation(profile, id, patch) {
  return invoke('openclaw_cron_patch', { profile: profile || null, id, patch })
}

export async function setAutomationEnabled(profile, id, enabled) {
  return patchAutomation(profile, id, { enabled })
}

export async function removeAutomation(profile, id) {
  return invoke('openclaw_cron_remove', { profile: profile || null, id })
}

export async function runAutomationNow(profile, id) {
  return invoke('openclaw_cron_run', { profile: profile || null, id })
}

export async function listAutomationRuns(profile, id, limit = 50) {
  return invoke('openclaw_cron_runs', { profile: profile || null, id, limit })
}

export async function automationStatus(profile) {
  return invoke('openclaw_cron_status', { profile: profile || null })
}
