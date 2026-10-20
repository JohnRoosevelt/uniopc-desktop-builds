import { useEffect, useState } from 'react'
import { displayEmployeeName } from '../../lib/employeeDisplay'
import { engineClient } from '../../lib/engine/client.js'
import {
  isSkillAssignable,
  setSkillPresence,
  skillStatus,
  sourceLabel,
} from '../../lib/skillAssignments'
import { ACTION } from '../../lib/theme'

function formatStatusLabel(status) {
  if (!status || status === 'active') return '活跃'
  if (status === 'inactive') return '离线'
  if (status === 'offline') return '离线'
  if (status === 'unregistered') return '未注册'
  if (status === 'activating') return '创建中'
  if (status === 'activation_failed') return '创建失败'
  if (status === 'disabled') return '已停用'
  return status
}

function InlineDetailRow({ label, value }) {
  return (
    <div className="rounded-xl border border-subtle bg-surface-raised px-4 py-3">
      <div className="text-xs text-tertiary">{label}</div>
      <div className="mt-1 truncate text-base font-medium text-primary">{value || '—'}</div>
    </div>
  )
}

export default function InlineEmployeeSettingsPanel({
  employee,
  activeProfile,
  canManageSkillAssignments = true,
  onClose,
  onSkillsChanged,
}) {
  const [tab, setTab] = useState('overview')
  const [skills, setSkills] = useState([])
  const [skillAgents, setSkillAgents] = useState([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState('')
  const [skillsMessage, setSkillsMessage] = useState('')
  const [skillQuery, setSkillQuery] = useState('')
  const [skillListMode, setSkillListMode] = useState('assigned')
  const [savingSkillName, setSavingSkillName] = useState('')
  const targetName = employee ? displayEmployeeName(employee) : ''
  const employeeAgentId = employee?.openclawAgentId || employee?.id || ''
  const selectedSkillAgent = skillAgents.find(agent => agent.id === employeeAgentId) || null
  const selectedSkillNames = Array.isArray(selectedSkillAgent?.skills) ? selectedSkillAgent.skills : []
  const selectedSkills = selectedSkillNames.map(name => (
    skills.find(skill => skill.name === name) || { name, description: '', eligible: true, disabled: false, bundled: false, source: 'Gateway' }
  ))
  const selectedUnavailableSkillCount = selectedSkills.filter(skill => !isSkillAssignable(skill)).length
  const matchesSkillQuery = skill => {
    const needle = skillQuery.trim().toLowerCase()
    if (!needle) return true
    return `${skill.name} ${skill.description || ''} ${sourceLabel(skill)}`.toLowerCase().includes(needle)
  }
  const filteredSelectedSkills = selectedSkills.filter(matchesSkillQuery)
  const filteredSkills = skills.filter(skill => {
    return matchesSkillQuery(skill)
  })
  const visibleSkills = skillListMode === 'assigned' ? filteredSelectedSkills : filteredSkills
  const tabs = [
    { id: 'overview', label: '概览' },
    { id: 'identity', label: '身份' },
    { id: 'skills', label: 'Skills' },
    { id: 'runtime', label: '运行' },
    { id: 'workspace', label: '工作区' },
    { id: 'channels', label: '渠道' },
    { id: 'activity', label: '活动' },
  ]

  async function loadInlineSkillhubSnapshot() {
    if (!employee || !activeProfile) {
      setSkills([])
      setSkillAgents([])
      setSkillsError(activeProfile ? '' : '当前没有可用的 Uniopc 引擎 profile，无法读取 Skills。')
      return
    }
    setSkillsLoading(true)
    setSkillsError('')
    setSkillsMessage('')
    try {
      const snapshot = await engineClient.agents.skillhubSnapshot({ profile: activeProfile })
      setSkills(Array.isArray(snapshot?.skills) ? snapshot.skills : [])
      setSkillAgents(Array.isArray(snapshot?.agents) ? snapshot.agents : [])
    } catch (err) {
      setSkills([])
      setSkillAgents([])
      setSkillsError(String(err?.message || err || '读取 Skills 失败'))
    } finally {
      setSkillsLoading(false)
    }
  }

  async function toggleInlineSkill(skillName) {
    if (!employee || !employeeAgentId || !skillName || savingSkillName) return
    if (!activeProfile) {
      setSkillsError('当前没有可用的 Uniopc 引擎 profile，无法保存 Skill 分配。')
      return
    }
    if (!canManageSkillAssignments) {
      setSkillsError('Skill 分配属于 Profile 员工管理动作，需要 Owner/Admin 在员工管理侧操作。')
      return
    }
    const skill = skills.find(item => item.name === skillName)
    const hasSkill = selectedSkillNames.includes(skillName)
    if (!hasSkill && skill && !isSkillAssignable(skill)) {
      setSkillsError('这个 Skill 当前不可用，请先处理依赖或启用后再分配。')
      return
    }
    const nextSkills = setSkillPresence(selectedSkillNames, skillName, !hasSkill)
    const previousAgents = skillAgents
    setSkillsError('')
    setSkillsMessage('')
    setSavingSkillName(skillName)
    setSkillAgents(prev => {
      const exists = prev.some(agent => agent.id === employeeAgentId)
      const nextAgent = {
        id: employeeAgentId,
        name: targetName,
        role: employee.role || 'AI 员工',
        emoji: employee.emoji,
        isDefault: Boolean(employee.isDefault),
        skills: nextSkills,
      }
      if (!exists) return [...prev, nextAgent]
      return prev.map(agent => agent.id === employeeAgentId ? { ...agent, skills: nextSkills } : agent)
    })
    try {
      const updated = await engineClient.agents.setSkills({
        req: {
          profile: activeProfile,
          agentId: employeeAgentId,
          skills: nextSkills,
        },
      })
      setSkillAgents(prev => prev.map(agent => (
        agent.id === employeeAgentId ? { ...agent, ...updated, skills: updated?.skills || nextSkills } : agent
      )))
      setSkillsMessage(hasSkill ? `已移除 ${skillName}` : `已启用 ${skillName}`)
      onSkillsChanged?.()
    } catch (err) {
      setSkillAgents(previousAgents)
      setSkillsError(String(err?.message || err || '保存 Skill 分配失败'))
      await loadInlineSkillhubSnapshot()
    } finally {
      setSavingSkillName('')
    }
  }

  useEffect(() => {
    if (tab !== 'skills') return
    loadInlineSkillhubSnapshot()
  }, [tab, activeProfile, employeeAgentId])

  if (!employee) {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center text-center">
        <div>
          <div className="text-2xl font-semibold tracking-[-0.02em] text-primary">选择一位员工</div>
          <div className="mt-2 text-base text-tertiary">从左侧挑一位，查看和调整设置</div>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-5 py-4">
        <div className="flex h-12 items-center justify-between gap-3 border-b border-subtle pb-4">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-base font-semibold text-primary">员工设置</div>
            <span className="rounded-md border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 text-2xs font-medium text-success-text">
              {formatStatusLabel(employee.status)}
            </span>
          </div>
          <button type="button" onClick={onClose} className={ACTION.secondary}>
            对话
          </button>
        </div>

        <div className="mt-4 border-b border-subtle">
          <div className="flex flex-wrap gap-1">
            {tabs.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium transition-colors ${
                  tab === item.id
                    ? 'bg-white text-[#171717]'
                    : 'text-secondary hover:bg-state-hover hover:text-primary'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="py-5">
          {tab === 'overview' && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <InlineDetailRow label="状态" value={formatStatusLabel(employee.status)} />
              <InlineDetailRow label="模型" value={employee.model || employee.defaultModel || 'OpenAI Codex 订阅 · gpt-5.5'} />
              <InlineDetailRow label="渠道" value="未连接" />
              <InlineDetailRow label="连接" value={activeProfile} />
            </div>
          )}

          {tab === 'identity' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <InlineDetailRow label="员工 ID" value={employee.id} />
              <InlineDetailRow label="名称" value={targetName} />
              <InlineDetailRow label="角色" value={employee.role || 'AI 员工'} />
              <InlineDetailRow label="描述" value={employee.description || '暂无职责说明'} />
            </div>
          )}

          {tab === 'skills' && (
            <div className="space-y-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                <div>
                  <div className="text-xs font-semibold uppercase text-tertiary">Skills</div>
                  <div className="mt-1 text-sm text-tertiary">
                    展示当前 Uniopc 引擎 profile/Gateway 已发现的 Skill；这里做员工分配，不安装 Skill。
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={skillQuery}
                    onChange={event => setSkillQuery(event.target.value)}
                    placeholder="搜索 Skill..."
                    className="h-9 w-full rounded-lg border border-subtle bg-surface-sunken px-3 text-sm text-primary outline-none placeholder:text-tertiary focus:border-brand/35 md:w-[220px]"
                  />
                  <button
                    type="button"
                    onClick={loadInlineSkillhubSnapshot}
                    disabled={skillsLoading || Boolean(savingSkillName)}
                    className="inline-flex h-9 items-center justify-center rounded-lg border border-default bg-surface-raised px-3 text-sm font-medium text-primary transition-colors hover:bg-state-hover disabled:opacity-50"
                  >
                    {skillsLoading ? '刷新中' : '刷新'}
                  </button>
                </div>
              </div>

              {(skillsError || skillsMessage) && (
                <div className={`rounded-xl border px-4 py-3 text-sm ${
                  skillsError
                    ? 'border-rose-400/20 bg-rose-400/10 text-danger-text'
                    : 'border-emerald-400/20 bg-emerald-400/10 text-success-text'
                }`}>
                  {skillsError || skillsMessage}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-3">
                <InlineDetailRow label="已分配" value={`${selectedSkillNames.length}`} />
                <InlineDetailRow label="可使用" value={`${selectedSkills.length - selectedUnavailableSkillCount}`} />
                <InlineDetailRow label="需处理" value={`${selectedUnavailableSkillCount}`} />
              </div>

              <div className="rounded-2xl border border-subtle bg-surface-sunken">
                {skillsLoading ? (
                  <div className="flex h-56 items-center justify-center text-sm text-tertiary">
                    正在读取当前 profile 的 Skills...
                  </div>
                ) : skills.length === 0 ? (
                  <div className="flex h-56 flex-col items-center justify-center px-6 text-center">
                    <div className="text-base font-medium text-primary">No skills yet</div>
                    <div className="mt-2 max-w-md text-sm leading-6 text-tertiary">
                      Gateway 没有返回已发现 Skill。请确认当前 profile 的 Skill 运行环境后刷新。
                    </div>
                  </div>
                ) : filteredSkills.length === 0 ? (
                  <div className="flex h-56 items-center justify-center text-sm text-tertiary">
                    没有匹配的 Skill
                  </div>
                ) : (
                  <div className="space-y-4 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="inline-flex rounded-lg border border-subtle bg-surface-raised p-1">
                        {[
                          { id: 'assigned', label: '已分配', count: selectedSkillNames.length },
                          { id: 'all', label: '全部', count: skills.length },
                        ].map(item => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => setSkillListMode(item.id)}
                            className={`h-8 rounded-md px-3 text-xs font-medium transition-colors ${
                              skillListMode === item.id
                                ? 'bg-white text-[#171717]'
                                : 'text-secondary hover:bg-state-hover hover:text-primary'
                            }`}
                          >
                            {item.label} {item.count}
                          </button>
                        ))}
                      </div>
                      <div className="text-xs text-tertiary">
                        {skillListMode === 'assigned' ? '当前员工真正可调用的 Skill' : '当前 Profile/Gateway 已发现的 Skill'}
                      </div>
                    </div>

                    {visibleSkills.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-default px-4 py-8 text-center text-sm text-tertiary">
                        {skillListMode === 'assigned'
                          ? '这个员工还没有分配 Skill。切到“全部”查看可分配项。'
                          : '当前筛选下没有 Skill。'}
                      </div>
                    ) : (
                      <div className="grid gap-3 md:grid-cols-2">
                        {visibleSkills.map(skill => {
                            const status = skillStatus(skill)
                            const canAssign = isSkillAssignable(skill)
                            const assigned = selectedSkillNames.includes(skill.name)
                            const saving = savingSkillName === skill.name
                            const canToggle = canManageSkillAssignments && (skillListMode === 'assigned' ? assigned : !assigned && canAssign)
                            const disabled = (Boolean(savingSkillName) && !saving) || !canToggle
                            return (
                              <button
                                key={skill.name}
                                type="button"
                                onClick={() => toggleInlineSkill(skill.name)}
                                disabled={disabled}
                                className={`rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                                  assigned
                                    ? 'border-brand/25 bg-state-selected hover:bg-state-active'
                                    : 'border-subtle bg-surface-raised hover:border-strong hover:bg-state-hover'
                                }`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="flex min-w-0 items-center gap-2">
                                      {skill.emoji && <span className="shrink-0 text-base">{skill.emoji}</span>}
                                      <span className="truncate text-base font-semibold text-primary">{skill.name}</span>
                                    </div>
                                    <p className="mt-2 line-clamp-2 text-sm leading-6 text-tertiary">
                                      {skill.description || '没有描述'}
                                    </p>
                                  </div>
                                  <span className={`mt-0.5 shrink-0 rounded-full border px-2.5 py-1 text-2xs font-medium ${status.className}`}>
                                    {status.label}
                                  </span>
                                </div>
                                <div className="mt-4 flex items-center justify-between gap-3">
                                  <span className="rounded-full border border-subtle bg-surface-raised px-2.5 py-1 text-2xs text-secondary">
                                    {sourceLabel(skill)}
                                  </span>
                                  <span className={`text-xs font-medium ${canAssign ? 'text-accent-text' : 'text-warning-text'}`}>
                                    {saving
                                      ? '保存中'
                                      : assigned
                                        ? skillListMode === 'assigned' && canManageSkillAssignments ? '移除分配' : '已分配'
                                        : canAssign ? canManageSkillAssignments ? '分配给员工' : '管理员可分配' : '需先处理'}
                                  </span>
                                </div>
                              </button>
                            )
                          })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab !== 'overview' && tab !== 'identity' && tab !== 'skills' && (
            <div className="rounded-2xl border border-subtle bg-surface-sunken px-4 py-8 text-center text-sm text-tertiary">
              {targetName} 的 {tabs.find(item => item.id === tab)?.label} 信息会显示在这里。
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
