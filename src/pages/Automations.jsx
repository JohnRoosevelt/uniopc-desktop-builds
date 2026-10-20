import { useCallback, useEffect, useMemo, useState } from 'react'
import Modal from '../components/Modal'
import { fetchOpenClawEmployees } from '../lib/openclawEmployees'
import {
  PAYLOAD_KIND_LABELS,
  SCHEDULE_MODES,
  SESSION_TARGETS,
  STATUS,
  STATUS_LABELS,
  STATUS_TONES,
  RUN_STATUS_LABELS,
  WEEKDAYS,
  createAutomation,
  defaultScheduleForm,
  deriveStatus,
  describeDiagnosticSource,
  describeErrorReason,
  describePayload,
  describeSchedule,
  describeSessionTarget,
  employeeLabel,
  employeeName,
  formatRunAt,
  groupJobsByEmployee,
  isAgentCreated,
  isContentEditable,
  isHighFrequency,
  listAutomationRuns,
  listAutomations,
  localTimeZone,
  payloadKind,
  removeAutomation,
  runAutomationNow,
  sessionTargetValue,
  setAutomationEnabled,
  updateAutomation,
} from '../lib/automations'

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '运行中' },
  { id: 'paused', label: '已暂停' },
  { id: 'attention', label: '需修复' },
]

const SCHEDULE_TABS = [
  { id: SCHEDULE_MODES.once, label: '单次' },
  { id: SCHEDULE_MODES.daily, label: '每天' },
  { id: SCHEDULE_MODES.weekly, label: '每周' },
  { id: SCHEDULE_MODES.interval, label: '每隔' },
  { id: SCHEDULE_MODES.expr, label: '高级' },
]

const INTERVAL_UNITS = [
  { id: 'minutes', label: '分钟' },
  { id: 'hours', label: '小时' },
  { id: 'days', label: '天' },
]

const SESSION_TARGET_OPTIONS = [
  {
    id: SESSION_TARGETS.isolated,
    label: '独立运行',
    hint: '每次都是全新会话，不会打扰你正在进行的对话。',
  },
  {
    id: SESSION_TARGETS.sticky,
    label: '持续在一个会话里',
    hint: '首次运行自动建一个专属会话，之后在该会话里持续积累上下文。',
  },
]

function toDatetimeLocal(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now())
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fromDatetimeLocal(value) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime()
}

function sectionLabel(text) {
  return <div className="mb-1.5 text-xs font-medium text-secondary">{text}</div>
}

function StatusTag({ status }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs ${STATUS_TONES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  )
}

export default function Automations() {
  const [jobs, setJobs] = useState([])
  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [groupMode, setGroupMode] = useState('agent')
  const [busyId, setBusyId] = useState('')

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [historyJob, setHistoryJob] = useState(null)

  const reload = useCallback(async () => {
    setError('')
    try {
      const payload = await listAutomations(null, {})
      setJobs(Array.isArray(payload?.jobs) ? payload.jobs : [])
    } catch (loadError) {
      setError(String(loadError?.message || loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload()
    fetchOpenClawEmployees({})
      .then(items => setEmployees(Array.isArray(items) ? items : []))
      .catch(() => setEmployees([]))
  }, [reload])

  const decorated = useMemo(
    () => jobs.map(job => ({ ...job, status: deriveStatus(job) })),
    [jobs],
  )

  const visible = useMemo(() => {
    switch (filter) {
      case 'active':
        return decorated.filter(job => job.status === STATUS.active)
      case 'paused':
        return decorated.filter(job => job.status === STATUS.paused || job.status === STATUS.completed)
      case 'attention':
        return decorated.filter(
          job => job.status === STATUS.needsFix || job.status === STATUS.autoDisabled,
        )
      default:
        return decorated
    }
  }, [decorated, filter])

  const attentionCount = useMemo(
    () =>
      decorated.filter(job => job.status === STATUS.needsFix || job.status === STATUS.autoDisabled)
        .length,
    [decorated],
  )

  const groups = useMemo(() => {
    if (groupMode === 'agent') return groupJobsByEmployee(visible, employees)
    const order = [STATUS.needsFix, STATUS.autoDisabled, STATUS.active, STATUS.paused, STATUS.completed]
    return order
      .map(status => ({
        agentId: status,
        label: STATUS_LABELS[status],
        jobs: visible.filter(job => job.status === status),
      }))
      .filter(group => group.jobs.length > 0)
  }, [visible, groupMode, employees])

  const withBusy = useCallback(
    async (id, action) => {
      setBusyId(id)
      setError('')
      try {
        await action()
        await reload()
      } catch (actionError) {
        setError(String(actionError?.message || actionError))
      } finally {
        setBusyId('')
      }
    },
    [reload],
  )

  const openCreate = () => {
    setEditing(null)
    setEditorOpen(true)
  }

  const openEdit = job => {
    setEditing(job)
    setEditorOpen(true)
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      <EngineReachStrip />

      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-primary">定时任务</h1>
          <p className="mt-1 text-sm text-secondary">
            给 AI 员工排班。这里汇总本账号下的全部任务，包括你手动新建的，以及员工在对话里自己创建的。
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="rounded-lg bg-brand px-3.5 py-2 text-sm font-medium text-on-brand transition-colors hover:bg-brand-hover"
        >
          新建任务
        </button>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map(entry => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setFilter(entry.id)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              filter === entry.id
                ? 'border-brand/40 bg-state-selected text-accent-text'
                : 'border-subtle text-secondary hover:bg-surface-overlay'
            }`}
          >
            {entry.label}
            {entry.id === 'attention' && attentionCount > 0 ? ` ${attentionCount}` : ''}
          </button>
        ))}
        <span className="ml-auto text-xs text-secondary">分组</span>
        <button
          type="button"
          onClick={() => setGroupMode(groupMode === 'agent' ? 'status' : 'agent')}
          className="rounded-full border border-subtle px-3 py-1 text-xs text-secondary transition-colors hover:bg-surface-overlay"
        >
          {groupMode === 'agent' ? '按员工' : '按状态'}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-subtle bg-danger-surface px-3 py-2 text-sm text-danger-text">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-sm text-secondary">加载定时任务中…</div>
      ) : visible.length === 0 ? (
        <EmptyState onCreate={openCreate} filtered={filter !== 'all'} />
      ) : (
        <div className="space-y-6">
          {groups.map(group => (
            <section key={group.agentId}>
              <h2 className="mb-2 text-sm font-medium text-secondary">
                {group.label}
                <span className="ml-2 text-xs text-secondary">{group.jobs.length}</span>
              </h2>
              <div className="space-y-2">
                {group.jobs.map(job => (
                  <AutomationCard
                    key={job.id}
                    job={job}
                    employees={employees}
                    busy={busyId === job.id}
                    onToggle={() =>
                      withBusy(job.id, () => setAutomationEnabled(null, job.id, !job.enabled))
                    }
                    onRunNow={() => withBusy(job.id, () => runAutomationNow(null, job.id))}
                    onHistory={() => setHistoryJob(job)}
                    onEdit={() => openEdit(job)}
                    onDelete={() => {
                      if (!window.confirm(`确定要删除定时任务「${job.name || job.id}」吗？`)) return
                      withBusy(job.id, () => removeAutomation(null, job.id))
                    }}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <AutomationEditor
        open={editorOpen}
        job={editing}
        employees={employees}
        onClose={() => setEditorOpen(false)}
        onSaved={async () => {
          setEditorOpen(false)
          await reload()
        }}
      />

      <RunHistoryModal job={historyJob} onClose={() => setHistoryJob(null)} />
    </div>
  )
}

/**
 * The honest constraint: the engine's scheduler lives in the gateway process,
 * so a local engine simply does not fire while the machine is asleep or off.
 * Hiding that turns every missed run into a support ticket.
 */
function EngineReachStrip() {
  return (
    <div className="mb-4 rounded-lg border border-subtle bg-info-surface px-3 py-2 text-xs text-info-text">
      定时任务由 Uniopc 引擎执行。使用本机引擎时，电脑关机或休眠期间任务不会运行；
      需要 7×24 执行请在「Uniopc 引擎」里连接远程主机。
    </div>
  )
}

function EmptyState({ onCreate, filtered }) {
  return (
    <div className="rounded-xl border border-dashed border-subtle px-6 py-14 text-center">
      <p className="text-sm text-secondary">{filtered ? '当前筛选下没有任务。' : '还没有定时任务。'}</p>
      {!filtered && (
        <button
          type="button"
          onClick={onCreate}
          className="mt-3 rounded-lg border border-subtle px-3 py-1.5 text-sm text-primary transition-colors hover:bg-surface-overlay"
        >
          新建第一个任务
        </button>
      )}
    </div>
  )
}

function AutomationCard({ job, employees, busy, onToggle, onRunNow, onHistory, onEdit, onDelete }) {
  const state = job.state || {}
  const attention = job.status === STATUS.needsFix || job.status === STATUS.autoDisabled
  const reason = attention ? describeErrorReason(job) : ''
  const kind = payloadKind(job)
  const readOnly = !isContentEditable(job)

  return (
    <div className="rounded-xl border border-subtle bg-surface-raised p-3.5">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-primary">{job.name || job.id}</span>
            <StatusTag status={job.status} />
            {readOnly && (
              <span className="inline-flex items-center rounded-full border border-subtle px-2 py-0.5 text-xs text-secondary">
                {PAYLOAD_KIND_LABELS[kind]}
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-xs text-secondary">{describePayload(job)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-secondary">
            <span className="text-primary">{describeSchedule(job.scheduleForm)}</span>
            <span>{employeeLabel(employees, job.agentId)}</span>
            <span>{describeSessionTarget(job)}</span>
            <span>创建者：{isAgentCreated(job) ? employeeLabel(employees, job.agentId) : '你'}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-secondary">
            <span>下次 {formatRunAt(state.nextRunAtMs)}</span>
            <span>
              上次 {formatRunAt(state.lastRunAtMs)}
              {state.lastRunStatus ? ` · ${RUN_STATUS_LABELS[state.lastRunStatus] || state.lastRunStatus}` : ''}
            </span>
          </div>
        </div>

        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-secondary">
          {/* A native checkbox already exposes its checked state; adding
              role="switch" without aria-checked makes screen readers announce
              a paused job as "on". */}
          <input
            type="checkbox"
            checked={Boolean(job.enabled)}
            disabled={busy}
            onChange={onToggle}
            aria-label={`${job.name || job.id} 运行开关`}
            className="h-4 w-4 accent-[var(--ui-brand)]"
          />
          {job.enabled ? '运行中' : '已暂停'}
        </label>
      </div>

      {attention && (
        <div className="mt-2.5 rounded-lg border border-subtle bg-warning-surface px-2.5 py-2 text-xs text-warning-text">
          {job.status === STATUS.autoDisabled && (
            <div className="font-medium">连续失败 10 次，引擎已自动停用该任务。</div>
          )}
          {reason && <div className={job.status === STATUS.autoDisabled ? 'mt-0.5' : ''}>{reason}</div>}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap gap-2">
        <CardAction disabled={busy} onClick={onRunNow}>立即运行</CardAction>
        <CardAction onClick={onHistory}>运行历史</CardAction>
        <CardAction onClick={onEdit}>{readOnly ? '查看' : '编辑'}</CardAction>
        <CardAction disabled={busy} onClick={onDelete} tone="danger">删除</CardAction>
      </div>
    </div>
  )
}

function CardAction({ children, onClick, disabled, tone }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border border-subtle px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
        tone === 'danger' ? 'text-danger-text hover:bg-danger-surface' : 'text-secondary hover:bg-surface-overlay'
      }`}
    >
      {children}
    </button>
  )
}

function AutomationEditor({ open, job, employees, onClose, onSaved }) {
  const [form, setForm] = useState(() => defaultScheduleForm())
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [agentId, setAgentId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [sessionKind, setSessionKind] = useState(SESSION_TARGETS.isolated)
  const [deleteAfterRun, setDeleteAfterRun] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const readOnly = Boolean(job) && !isContentEditable(job)

  useEffect(() => {
    if (!open) return
    setError('')
    if (job) {
      setForm({ ...defaultScheduleForm(), ...(job.scheduleForm || {}), tz: job.scheduleForm?.tz || localTimeZone() })
      setName(job.name || '')
      setDescription(job.description || '')
      setAgentId(job.agentId || '')
      setPrompt(job.payload?.message || '')
      setSessionKind(
        String(job.sessionTarget || '').startsWith('session:')
          ? SESSION_TARGETS.sticky
          : SESSION_TARGETS.isolated,
      )
      setDeleteAfterRun(Boolean(job.deleteAfterRun))
      return
    }
    setForm(defaultScheduleForm())
    setName('')
    setDescription('')
    setAgentId(employees[0]?.id || '')
    setPrompt('')
    setSessionKind(SESSION_TARGETS.isolated)
    setDeleteAfterRun(false)
  }, [open, job, employees])

  const patchForm = patch => setForm(previous => ({ ...previous, ...patch }))

  const toggleDay = day =>
    patchForm({
      days: form.days.includes(day)
        ? form.days.filter(entry => entry !== day)
        : [...form.days, day].sort((a, b) => a - b),
    })

  const save = async () => {
    setError('')
    if (!name.trim()) {
      setError('请填写任务名称。')
      return
    }
    if (!readOnly) {
      if (!agentId.trim()) {
        setError('请选择要排班的 AI 员工。')
        return
      }
      if (!prompt.trim()) {
        setError('请填写要让员工做什么。')
        return
      }
    }
    if (isHighFrequency(form)) {
      const proceed = window.confirm(
        '当前任务间隔不足 30 分钟，会消耗较多额度。确定要保存吗？',
      )
      if (!proceed) return
    }

    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        enabled: job ? Boolean(job.enabled) : true,
        deleteAfterRun: form.mode === SCHEDULE_MODES.once ? deleteAfterRun : false,
      }
      if (!readOnly) {
        payload.agentId = agentId.trim()
        payload.sessionTarget = sessionTargetValue(sessionKind, job?.id)
        payload.wakeMode = 'now'
        payload.payload = { kind: 'agentTurn', message: prompt.trim() }
      }
      if (job) {
        await updateAutomation(null, job.id, form, payload)
      } else {
        await createAutomation(null, form, payload)
      }
      await onSaved()
    } catch (saveError) {
      setError(String(saveError?.message || saveError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="2xl"
      title={job ? (readOnly ? '查看定时任务' : '编辑定时任务') : '新建定时任务'}
      description={
        readOnly
          ? `类型：${PAYLOAD_KIND_LABELS[payloadKind(job)]}（此处仅可编辑名称、描述和调度）`
          : undefined
      }
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-subtle px-3 py-1.5 text-sm text-secondary transition-colors hover:bg-surface-overlay"
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-brand px-3.5 py-1.5 text-sm font-medium text-on-brand transition-colors hover:bg-brand-hover disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg border border-subtle bg-danger-surface px-3 py-2 text-sm text-danger-text">
            {error}
          </div>
        )}

        <div>
          {sectionLabel('名称')}
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="例如：晨间简报"
            className="w-full rounded-lg border border-subtle bg-surface px-3 py-2 text-sm text-primary"
          />
        </div>

        <div>
          {sectionLabel('描述（可选）')}
          <input
            value={description}
            onChange={event => setDescription(event.target.value)}
            className="w-full rounded-lg border border-subtle bg-surface px-3 py-2 text-sm text-primary"
          />
        </div>

        {!readOnly && (
          <>
            <div>
              {sectionLabel('由哪位 AI 员工执行')}
              <select
                value={agentId}
                onChange={event => setAgentId(event.target.value)}
                className="w-full rounded-lg border border-subtle bg-surface px-3 py-2 text-sm text-primary"
              >
                <option value="">请选择员工</option>
                {employees.map(employee => (
                  <option key={employee.id} value={employee.id}>
                    {employeeName(employee)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              {sectionLabel('要做什么')}
              <textarea
                value={prompt}
                onChange={event => setPrompt(event.target.value)}
                rows={4}
                placeholder="例如：汇总今天的私域转化数据，给出三条改进建议。"
                className="w-full rounded-lg border border-subtle bg-surface px-3 py-2 text-sm text-primary"
              />
            </div>
          </>
        )}

        <div>
          {sectionLabel('什么时候运行')}
          <div className="mb-2 flex flex-wrap gap-1.5">
            {SCHEDULE_TABS.map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => patchForm({ mode: tab.id })}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  form.mode === tab.id
                    ? 'border-brand/40 bg-state-selected text-accent-text'
                    : 'border-subtle text-secondary hover:bg-surface-overlay'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {form.mode === SCHEDULE_MODES.once && (
            <div className="space-y-2">
              <input
                type="datetime-local"
                value={toDatetimeLocal(form.onceAtMs)}
                onChange={event => patchForm({ onceAtMs: fromDatetimeLocal(event.target.value) })}
                className="w-full rounded-lg border border-subtle bg-surface px-3 py-2 text-sm text-primary"
              />
              <label className="flex items-center gap-2 text-xs text-secondary">
                <input
                  type="checkbox"
                  checked={deleteAfterRun}
                  onChange={event => setDeleteAfterRun(event.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--ui-brand)]"
                />
                运行成功后自动删除该任务
              </label>
            </div>
          )}

          {(form.mode === SCHEDULE_MODES.daily || form.mode === SCHEDULE_MODES.weekly) && (
            <div className="space-y-2">
              <input
                type="time"
                value={String(form.time || '09:00').slice(0, 5)}
                onChange={event => patchForm({ time: event.target.value })}
                className="rounded-lg border border-subtle bg-surface px-3 py-2 text-sm text-primary"
              />
              {form.mode === SCHEDULE_MODES.weekly && (
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAYS.map(entry => (
                    <button
                      key={entry.day}
                      type="button"
                      onClick={() => toggleDay(entry.day)}
                      aria-pressed={form.days.includes(entry.day)}
                      aria-label={`周${entry.label}`}
                      className={`h-8 w-8 rounded-full border text-xs transition-colors ${
                        form.days.includes(entry.day)
                          ? 'border-brand/40 bg-state-selected text-accent-text'
                          : 'border-subtle text-secondary hover:bg-surface-overlay'
                      }`}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {form.mode === SCHEDULE_MODES.interval && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-secondary">每隔</span>
              <input
                type="number"
                min={1}
                value={form.everyValue}
                onChange={event => patchForm({ everyValue: Number(event.target.value) || 1 })}
                className="w-20 rounded-lg border border-subtle bg-surface px-3 py-2 text-sm text-primary"
              />
              <select
                value={form.everyUnit}
                onChange={event => patchForm({ everyUnit: event.target.value })}
                className="rounded-lg border border-subtle bg-surface px-3 py-2 text-sm text-primary"
              >
                {INTERVAL_UNITS.map(unit => (
                  <option key={unit.id} value={unit.id}>{unit.label}</option>
                ))}
              </select>
            </div>
          )}

          {form.mode === SCHEDULE_MODES.expr && (
            <input
              value={form.expr}
              onChange={event => patchForm({ expr: event.target.value })}
              placeholder="0 9 * * 1-5"
              className="w-full rounded-lg border border-subtle bg-surface px-3 py-2 font-mono text-sm text-primary"
            />
          )}

          <p className="mt-1.5 text-xs text-secondary">时区：{form.tz || localTimeZone()}</p>
          {isHighFrequency(form) && (
            <p className="mt-1 text-xs text-warning-text">高频任务会消耗较多额度，请谨慎设置。</p>
          )}
        </div>

        {!readOnly && (
          <div>
            {sectionLabel('结果放在哪里')}
            <div className="space-y-1.5">
              {SESSION_TARGET_OPTIONS.map(option => (
                <label
                  key={option.id}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-subtle px-3 py-2"
                >
                  <input
                    type="radio"
                    name="session-target"
                    checked={sessionKind === option.id}
                    onChange={() => setSessionKind(option.id)}
                    className="mt-0.5 accent-[var(--ui-brand)]"
                  />
                  <span>
                    <span className="block text-sm text-primary">{option.label}</span>
                    <span className="block text-xs text-secondary">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * The run detail is the differentiator: the engine already tags every
 * diagnostic with the stage that produced it (准备 / 模型 / 执行 / 工具 / 投递),
 * so "it failed" becomes "it failed at delivery".
 */
function RunHistoryModal({ job, onClose }) {
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!job) return
    setLoading(true)
    setError('')
    listAutomationRuns(null, job.id, 50)
      .then(payload => setRuns(Array.isArray(payload?.runs) ? payload.runs : []))
      .catch(loadError => setError(String(loadError?.message || loadError)))
      .finally(() => setLoading(false))
  }, [job])

  const diagnostics = job?.state?.lastDiagnostics?.entries || []

  return (
    <Modal open={Boolean(job)} onClose={onClose} size="2xl" title="运行历史记录" description={job?.name}>
      {loading ? (
        <div className="py-10 text-center text-sm text-secondary">加载运行历史中…</div>
      ) : (
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg border border-subtle bg-danger-surface px-3 py-2 text-sm text-danger-text">
              {error}
            </div>
          )}

          {diagnostics.length > 0 && (
            <div>
              {sectionLabel('最近一次运行的分段诊断')}
              <ol className="space-y-1.5">
                {diagnostics.map((entry, index) => (
                  <li
                    key={`${entry.ts}-${index}`}
                    className="flex gap-2 rounded-lg border border-subtle px-2.5 py-1.5 text-xs"
                  >
                    <span className="shrink-0 font-medium text-primary">
                      {describeDiagnosticSource(entry.source)}
                    </span>
                    <span
                      className={
                        entry.severity === 'error'
                          ? 'text-danger-text'
                          : entry.severity === 'warn'
                            ? 'text-warning-text'
                            : 'text-secondary'
                      }
                    >
                      {entry.message}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {runs.length === 0 ? (
            <div className="py-8 text-center text-sm text-secondary">暂无运行历史</div>
          ) : (
            <div>
              {sectionLabel('历史运行')}
              <ul className="space-y-1.5">
                {runs.map((run, index) => (
                  <li
                    key={run.runId || index}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-subtle px-2.5 py-2 text-xs"
                  >
                    <span className="text-primary">{formatRunAt(run.startedAtMs || run.ts)}</span>
                    <span className="text-secondary">
                      {RUN_STATUS_LABELS[run.status] || run.status || '--'}
                    </span>
                    {Number.isFinite(Number(run.durationMs)) && (
                      <span className="text-secondary">{Math.round(Number(run.durationMs) / 1000)}s</span>
                    )}
                    {run.error && <span className="text-danger-text">{run.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
