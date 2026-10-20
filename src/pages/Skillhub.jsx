import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useNavigate } from 'react-router-dom'
import EmployeeAvatar from '../components/EmployeeAvatar'
import Modal from '../components/Modal'
import { ACTION, HEADING, LAYOUT, SURFACE, TEXT } from '../lib/theme'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import {
  buildSkillAssignmentIndex,
  describeSkillAssignment,
  getAgentSkillNames,
  isSkillAssignable,
  setSkillPresence,
  skillStatus,
  sourceLabel,
} from '../lib/skillAssignments'

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'available', label: '可用' },
  { id: 'assigned', label: '已分配' },
  { id: 'unassigned', label: '未分配' },
  { id: 'missing', label: '缺依赖' },
  { id: 'disabled', label: '已禁用' },
]

function matchesFilter(skill, filterId, assignment) {
  if (filterId === 'available') return isSkillAssignable(skill)
  if (filterId === 'assigned') return assignment.assigned > 0
  if (filterId === 'unassigned') return assignment.assigned === 0
  if (filterId === 'missing') return skillStatus(skill).key === 'missing'
  if (filterId === 'disabled') return skillStatus(skill).key === 'disabled'
  return true
}

function mergeUpdatedAgents(currentAgents, updatedAgents) {
  const map = new Map(currentAgents.map(agent => [agent.id, agent]))
  for (const agent of updatedAgents) {
    if (agent?.id) map.set(agent.id, agent)
  }
  return currentAgents.map(agent => map.get(agent.id) || agent)
}

export default function Skillhub() {
  const navigate = useNavigate()
  const activeOpenClaw = useActiveOpenClawProfile()
  const [skills, setSkills] = useState([])
  const [agents, setAgents] = useState([])
  const [selectedSkillName, setSelectedSkillName] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [savingKey, setSavingKey] = useState('')
  const [menuSkillName, setMenuSkillName] = useState('')
  const [assignSkillName, setAssignSkillName] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const activeProfile = activeOpenClaw.activeProfile || ''
  const assignmentIndex = useMemo(() => buildSkillAssignmentIndex(agents), [agents])
  const selectedSkill = skills.find(skill => skill.name === selectedSkillName) || null
  const selectedAssignment = selectedSkill
    ? describeSkillAssignment(selectedSkill.name, agents)
    : { assigned: 0, total: agents.length, label: '未选择', allAssigned: false }
  const selectedStatus = selectedSkill ? skillStatus(selectedSkill) : null
  const selectedCanAssign = selectedSkill ? isSkillAssignable(selectedSkill) : false
  const assignSkill = skills.find(skill => skill.name === assignSkillName) || null
  const assignStatus = assignSkill ? skillStatus(assignSkill) : null
  const assignAssignment = assignSkill
    ? describeSkillAssignment(assignSkill.name, agents)
    : { assigned: 0, total: agents.length, label: '未选择', allAssigned: false }
  const assignCanAssign = assignSkill ? isSkillAssignable(assignSkill) : false

  const filteredSkills = skills.filter(skill => {
    const needle = query.trim().toLowerCase()
    const assignment = describeSkillAssignment(skill.name, agents)
    if (!matchesFilter(skill, filter, assignment)) return false
    if (!needle) return true
    return `${skill.name} ${skill.description || ''} ${sourceLabel(skill)}`.toLowerCase().includes(needle)
  })

  useEffect(() => {
    if (activeOpenClaw.loading || !activeProfile) return
    loadSnapshot(activeProfile)
  }, [activeOpenClaw.loading, activeProfile])

  async function loadSnapshot(profileArg = activeProfile) {
    setLoading(true)
    setError('')
    try {
      const snapshot = await invoke('openclaw_skillhub_snapshot', {
        profile: profileArg,
      })
      const nextSkills = Array.isArray(snapshot?.skills) ? snapshot.skills : []
      const nextAgents = Array.isArray(snapshot?.agents) ? snapshot.agents : []
      setSkills(nextSkills)
      setAgents(nextAgents)
      setSelectedSkillName(prev => {
        if (prev && nextSkills.some(skill => skill.name === prev)) return prev
        return nextSkills[0]?.name || ''
      })
    } catch (err) {
      setError(String(err || '读取技能市场失败'))
      setSkills([])
      setAgents([])
    } finally {
      setLoading(false)
    }
  }

  async function setAgentSkill(agent, skillName, enabled) {
    if (!agent || !skillName || savingKey) return
    const targetSkill = skills.find(skill => skill.name === skillName)
    if (enabled && targetSkill && !isSkillAssignable(targetSkill)) {
      setError('这个 Skill 目前不可用，请先处理依赖或启用后再分配。')
      return
    }

    const nextSkills = setSkillPresence(agent.skills, skillName, enabled)
    setSavingKey(`${agent.id}:${skillName}`)
    setError('')
    setMessage('')
    setAgents(prev => prev.map(item => (
      item.id === agent.id ? { ...item, skills: nextSkills } : item
    )))

    try {
      const updated = await invoke('openclaw_agent_skills_set', {
        req: {
          profile: activeProfile,
          agentId: agent.id,
          skills: nextSkills,
        },
      })
      setAgents(prev => prev.map(item => (
        item.id === updated.id ? updated : item
      )))
      setMessage(enabled ? `已为 ${agent.name} 启用 ${skillName}` : `已从 ${agent.name} 移除 ${skillName}`)
    } catch (err) {
      setError(String(err || '保存 Skill 分配失败'))
      await loadSnapshot(activeProfile)
    } finally {
      setSavingKey('')
    }
  }

  async function setSkillForAllAgents(enabled) {
    const targetSkill = assignSkill || selectedSkill
    if (!targetSkill || savingKey) return
    if (enabled && !isSkillAssignable(targetSkill)) {
      setError('这个 Skill 目前不可用，请先处理依赖或启用后再分配。')
      return
    }
    if (agents.length === 0) return

    const skillName = targetSkill.name
    const nextAgents = agents.map(agent => ({
      ...agent,
      skills: setSkillPresence(agent.skills, skillName, enabled),
    }))
    setSavingKey(`all:${skillName}`)
    setError('')
    setMessage('')
    setAgents(nextAgents)

    try {
      const updatedAgents = await Promise.all(nextAgents.map(agent => (
        invoke('openclaw_agent_skills_set', {
          req: {
            profile: activeProfile,
            agentId: agent.id,
            skills: agent.skills,
          },
        })
      )))
      setAgents(prev => mergeUpdatedAgents(prev, updatedAgents))
      setMessage(enabled ? `已为全部员工启用 ${skillName}` : `已从全部员工移除 ${skillName}`)
    } catch (err) {
      setError(String(err || '批量保存 Skill 分配失败'))
      await loadSnapshot(activeProfile)
    } finally {
      setSavingKey('')
    }
  }

  return (
    <div className={`${LAYOUT.board} min-h-full space-y-5`}>
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-subtle bg-surface-overlay text-secondary">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 5.5A2.5 2.5 0 017.5 3H20v16H7.5A2.5 2.5 0 005 21.5v-16z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 5.5A2.5 2.5 0 002.5 3H2v16h.5A2.5 2.5 0 015 21.5" />
            </svg>
          </div>
          <div>
            <h2 className={HEADING.page}>技能市场</h2>
            <p className={`mt-1 text-sm ${TEXT.secondary}`}>
              管理当前工作空间的 Uniopc 引擎 Skills，并分配给 AI 员工。
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden rounded-lg border border-subtle bg-surface-overlay px-3 py-2 text-xs text-tertiary md:block">
            云端工作台 · {activeProfile}
          </div>
          <button type="button" onClick={() => loadSnapshot(activeProfile)} disabled={loading || Boolean(savingKey)} className={ACTION.secondary}>
            {loading ? '刷新中' : '刷新'}
          </button>
          <button type="button" disabled title="后续支持创建自定义 Skill" className={ACTION.primary}>
            + New skill
          </button>
        </div>
      </div>

      {(error || message) && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${
          error
            ? 'border-rose-400/20 bg-rose-500/10 text-rose-500'
            : 'border-emerald-400/20 bg-emerald-500/10 text-emerald-500'
        }`}>
          {error || message}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <section className={`${SURFACE.panel} overflow-hidden`}>
          <div className="border-b border-subtle px-5 py-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-primary">Skill Library</h3>
                <p className={`mt-1 text-sm ${TEXT.secondary}`}>
                  {skills.length} 个可发现 Skill，{assignmentIndex.size} 个已分配
                </p>
              </div>
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索 Skill..."
                className="h-10 w-full rounded-lg border border-subtle bg-surface-overlay px-3 text-sm text-primary outline-none placeholder:text-tertiary focus:border-violet-400/40 lg:w-[280px]"
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {FILTERS.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFilter(item.id)}
                  className={`h-8 rounded-full border px-3 text-xs font-medium transition-colors ${
                    filter === item.id
                      ? 'border-violet-400/30 bg-violet-400/12 text-violet-500'
                      : 'border-subtle bg-surface-overlay text-secondary hover:border-violet-400/20 hover:text-violet-500'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-[calc(100vh-315px)] min-h-[430px] overflow-y-auto p-5">
            {loading ? (
              <div className="flex h-72 items-center justify-center text-sm text-tertiary">正在读取 Skills</div>
            ) : skills.length === 0 ? (
              <div className="flex h-72 flex-col items-center justify-center text-center">
                <div className="text-lg font-semibold text-primary">No skills yet</div>
                <p className="mt-2 max-w-md text-sm leading-6 text-tertiary">
                  Uniopc 引擎 还没有返回可用 Skill。后续可以在这里创建、导入或从运行时同步 Skill。
                </p>
              </div>
            ) : filteredSkills.length === 0 ? (
              <div className="flex h-72 items-center justify-center text-sm text-tertiary">没有匹配的 Skill</div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                {filteredSkills.map(skill => {
                  const status = skillStatus(skill)
                  const assignment = describeSkillAssignment(skill.name, agents)
                  return (
                    <div
                      key={skill.name}
                      className={`relative rounded-xl border p-4 transition-all ${
                        selectedSkillName === skill.name
                          ? 'border-violet-400/40 bg-violet-400/[0.08]'
                          : 'border-subtle bg-surface-overlay hover:border-violet-400/20 hover:bg-surface-raised'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedSkillName(skill.name)}
                        className="block w-full text-left"
                      >
                        <div className="flex items-start justify-between gap-3 pr-8">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              {skill.emoji && <span className="text-base">{skill.emoji}</span>}
                              <span className="truncate text-sm font-semibold text-primary">{skill.name}</span>
                            </div>
                            <p className="mt-2 line-clamp-3 text-sm leading-6 text-tertiary">{skill.description || '没有描述'}</p>
                          </div>
                          <span className={`mt-0.5 shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${status.className}`}>
                            {status.label}
                          </span>
                        </div>
                        <div className="mt-4 flex items-center justify-between gap-3">
                          <span className="rounded-full border border-subtle bg-surface-raised px-2.5 py-1 text-xs text-secondary">
                            {sourceLabel(skill)}
                          </span>
                          <span className={`text-xs font-medium ${assignment.assigned > 0 ? 'text-violet-500' : 'text-tertiary'}`}>
                            {assignment.label}
                          </span>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={event => {
                          event.stopPropagation()
                          setMenuSkillName(prev => prev === skill.name ? '' : skill.name)
                        }}
                        className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-tertiary transition-colors hover:border-subtle hover:bg-surface-raised hover:text-primary"
                        aria-label={`${skill.name} 更多操作`}
                      >
                        <span className="text-lg leading-none">...</span>
                      </button>
                      {menuSkillName === skill.name && (
                        <div className="absolute right-3 top-12 z-20 w-40 rounded-xl border border-subtle bg-surface-raised p-1.5 shadow-xl">
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation()
                              setSelectedSkillName(skill.name)
                              setAssignSkillName(skill.name)
                              setMenuSkillName('')
                            }}
                            className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-primary transition-colors hover:bg-violet-400/[0.08] hover:text-violet-500"
                          >
                            <span>分配给员工</span>
                            <span className="text-xs text-tertiary">{assignment.assigned}</span>
                          </button>
                          <button
                            type="button"
                            disabled
                            className="mt-1 flex w-full cursor-not-allowed items-center rounded-lg px-3 py-2 text-left text-sm text-tertiary opacity-60"
                          >
                            其他操作
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </section>

        <aside className={`${SURFACE.panel} overflow-hidden`}>
          <div className="border-b border-subtle px-5 py-4">
            <h3 className="text-sm font-semibold text-primary">Skill 详情</h3>
            <p className={`mt-1 text-sm ${TEXT.secondary}`}>
              {selectedSkill ? selectedSkill.name : '选择一个 Skill'}
            </p>
          </div>
          <div className="max-h-[calc(100vh-255px)] overflow-y-auto p-5">
            {!selectedSkill ? (
              <div className="rounded-xl border border-dashed border-subtle px-4 py-10 text-center text-sm text-tertiary">
                选择一个 Skill 后，在这里查看状态并分配给员工。
              </div>
            ) : (
              <>
                <div className="rounded-xl border border-subtle bg-surface-overlay p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {selectedSkill.emoji && <span>{selectedSkill.emoji}</span>}
                        <div className="truncate text-sm font-semibold text-primary">{selectedSkill.name}</div>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-tertiary">{selectedSkill.description || '没有描述'}</p>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${selectedStatus.className}`}>
                      {selectedStatus.label}
                    </span>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg border border-subtle bg-surface-raised px-3 py-2">
                      <div className="text-tertiary">来源</div>
                      <div className="mt-1 font-medium text-primary">{sourceLabel(selectedSkill)}</div>
                    </div>
                    <div className="rounded-lg border border-subtle bg-surface-raised px-3 py-2">
                      <div className="text-tertiary">员工覆盖</div>
                      <div className="mt-1 font-medium text-primary">{selectedAssignment.label}</div>
                    </div>
                  </div>
                  {!selectedCanAssign && (
                    <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs leading-5 text-amber-500">
                      这个 Skill 当前不可分配。请先在运行环境中启用它，或补齐缺失依赖。
                    </div>
                  )}
                </div>

                <div className="mt-4 rounded-xl border border-subtle bg-surface-overlay p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-primary">分配入口</div>
                      <div className="mt-1 text-xs leading-5 text-tertiary">
                        Skill 安装状态来自当前 profile/Gateway；这里仅管理员工分配。
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setAssignSkillName(selectedSkill.name)}
                      disabled={Boolean(savingKey)}
                      className={ACTION.secondary}
                    >
                      打开分配
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </aside>
      </div>

      <Modal
        open={Boolean(assignSkill)}
        onClose={() => setAssignSkillName('')}
        title={assignSkill ? `分配 ${assignSkill.name}` : '分配 Skill'}
        description="选择这个 Skill 要启用给哪些 AI 员工。"
        size="2xl"
        bodyClassName="space-y-4"
        footer={assignSkill && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => navigate('/employees')}
              className="inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium text-violet-500 transition-colors hover:bg-violet-400/[0.08]"
            >
              查看员工能力视图
            </button>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setAssignSkillName('')} className={ACTION.secondary}>
                完成
              </button>
            </div>
          </div>
        )}
      >
        {assignSkill && (
          <>
            <div className="rounded-xl border border-subtle bg-surface-overlay p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {assignSkill.emoji && <span>{assignSkill.emoji}</span>}
                    <div className="truncate text-sm font-semibold text-primary">{assignSkill.name}</div>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-tertiary">{assignSkill.description || '没有描述'}</p>
                </div>
                <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${assignStatus.className}`}>
                  {assignStatus.label}
                </span>
              </div>
              <div className="mt-4 grid gap-2 text-xs sm:grid-cols-3">
                <div className="rounded-lg border border-subtle bg-surface-raised px-3 py-2">
                  <div className="text-tertiary">来源</div>
                  <div className="mt-1 font-medium text-primary">{sourceLabel(assignSkill)}</div>
                </div>
                <div className="rounded-lg border border-subtle bg-surface-raised px-3 py-2">
                  <div className="text-tertiary">员工覆盖</div>
                  <div className="mt-1 font-medium text-primary">{assignAssignment.label}</div>
                </div>
                <div className="rounded-lg border border-subtle bg-surface-raised px-3 py-2">
                  <div className="text-tertiary">Profile</div>
                  <div className="mt-1 truncate font-medium text-primary">{activeProfile}</div>
                </div>
              </div>
              {!assignCanAssign && (
                <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs leading-5 text-amber-500">
                  这个 Skill 当前不可分配。请先在运行环境中启用它，或补齐缺失依赖。
                </div>
              )}
            </div>

            <div className="rounded-xl border border-subtle bg-surface-overlay p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-sm font-semibold text-primary">应用到全部员工</div>
                  <div className="mt-1 text-xs leading-5 text-tertiary">
                    一键批量更新当前员工名单。之后仍可在员工页单独调整。
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSkillForAllAgents(!assignAssignment.allAssigned)}
                  disabled={Boolean(savingKey) || agents.length === 0 || (!assignAssignment.allAssigned && !assignCanAssign)}
                  className={assignAssignment.allAssigned ? ACTION.secondary : ACTION.primary}
                >
                  {assignAssignment.allAssigned ? '移除全部' : '启用全部'}
                </button>
              </div>
            </div>

            <div className="divide-y divide-subtle rounded-xl border border-subtle">
              {agents.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-tertiary">没有可分配的员工</div>
              ) : agents.map(agent => {
                const active = getAgentSkillNames(agent).includes(assignSkill.name)
                const saving = savingKey === `${agent.id}:${assignSkill.name}` || savingKey === `all:${assignSkill.name}`
                const disabled = saving || (Boolean(savingKey) && !saving) || (!active && !assignCanAssign)
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => setAgentSkill(agent, assignSkill.name, !active)}
                    disabled={disabled}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-violet-400/[0.04] disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    <EmployeeAvatar kind="ai" name={agent.name} emoji={agent.emoji} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-primary">{agent.name}</div>
                      <div className="truncate text-xs text-tertiary">{agent.role || (agent.isDefault ? '默认员工' : 'AI 员工')}</div>
                    </div>
                    <span className={`h-5 w-9 rounded-full border p-0.5 transition-colors ${
                      active ? 'border-violet-400/30 bg-violet-400/20' : 'border-subtle bg-surface-raised'
                    }`}>
                      <span className={`block h-4 w-4 rounded-full transition-transform ${
                        active ? 'translate-x-4 bg-violet-300' : 'bg-tertiary'
                      }`} />
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}
