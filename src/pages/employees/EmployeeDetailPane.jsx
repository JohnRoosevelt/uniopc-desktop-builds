import { displayEmployeeName } from '../../lib/employeeDisplay'
import { formatOpenClawModelLabel } from '../../lib/openclawModels'
import { isSkillAssignable, skillStatus, sourceLabel } from '../../lib/skillAssignments'

const DM_POLICY_OPTIONS = [
  { value: 'pairing', label: '配对模式（陌生人需批准）' },
  { value: 'allowlist', label: '白名单（仅已批准的人）' },
  { value: 'open', label: '开放（所有人可私聊）' },
  { value: 'disabled', label: '关闭私聊' },
]

const GROUP_POLICY_OPTIONS = [
  { value: 'allowlist', label: '白名单群' },
  { value: 'open', label: '开放（所有群，需 @提及）' },
  { value: 'disabled', label: '关闭群聊' },
]

function employeeModelLabel(employee, currentModelRef = '') {
  const explicitModel = String(employee?.model || '').trim()
  if (explicitModel) return formatOpenClawModelLabel(explicitModel)
  const inheritedModel = String(employee?.defaultModel || currentModelRef || '').trim()
  return inheritedModel ? `跟随 Profile 默认：${formatOpenClawModelLabel(inheritedModel)}` : '跟随 Profile 默认'
}

function formatValue(value, fallback = '未设置') {
  const normalized = String(value || '').trim()
  return normalized || fallback
}

function formatStatusLabel(status) {
  if (!status || status === 'active') return '活跃'
  if (status === 'inactive' || status === 'offline') return '离线'
  if (status === 'unregistered') return '未注册'
  if (status === 'activating') return '创建中'
  if (status === 'activation_failed') return '创建失败'
  if (status === 'disabled') return '已停用'
  return status
}

function employeeStatusBadgeClass(status) {
  if (!status || status === 'active') return 'border-emerald-400/20 bg-emerald-400/10 text-success-text'
  if (status === 'activation_failed') return 'border-rose-400/24 bg-rose-400/12 text-danger-text'
  return 'border-amber-400/24 bg-amber-400/12 text-warning-text'
}

function formatTimeValue(value) {
  if (!value) return '暂无'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function channelChipClass(label) {
  if (label.startsWith('Feishu')) {
    return 'rounded-full border border-violet-400/24 bg-violet-400/12 px-2.5 py-1 text-accent-text'
  }
  if (label.startsWith('微信')) {
    return 'rounded-full border border-emerald-400/24 bg-emerald-400/12 px-2.5 py-1 text-success-text'
  }
  return 'rounded-full border border-subtle bg-surface-raised px-2.5 py-1'
}

function pairingChannelLabel(channelId) {
  if (channelId === 'openclaw-weixin') return '微信'
  if (channelId === 'feishu') return 'Feishu'
  return channelId
}

function pairingSenderLabel(request) {
  const meta = request?.meta || {}
  const name = String(meta.name || meta.displayName || meta.senderName || '').trim()
  return name || String(request?.id || '').trim() || '未知发送者'
}

function pairingExpiryLabel(expiresAtMs) {
  const remaining = Number(expiresAtMs) - Date.now()
  if (!Number.isFinite(remaining) || remaining <= 0) return '已过期'
  const minutes = Math.max(1, Math.round(remaining / 60000))
  return `${minutes} 分钟后过期`
}

function DetailRow({ label, value, mono = false }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] items-start gap-3 border-b border-subtle py-3 last:border-b-0">
      <div className="text-xs font-medium text-tertiary">{label}</div>
      <div className={`min-w-0 truncate text-sm leading-5 text-primary ${mono ? 'font-mono' : ''}`}>
        {value}
      </div>
    </div>
  )
}

export default function EmployeeDetailPane({
  employee,
  detailTab,
  onDetailTabChange,
  onEdit,
  onDelete,
  onOpenConnections,
  onOpenDocuments,
  onCreate,
  notice,
  error,
  canManage,
  deletingId,
  detailTabs,
  currentModelRef,
  currentProfile,
  currentProjectName,
  channelLabels,
  workspacePath,
  agentDir,
  routes,
  bindingsCount,
  skillQuery,
  onSkillQueryChange,
  skillsRestricted,
  skillNames,
  availableSkillCount,
  unavailableSkillCount,
  loadingSkills,
  savingSkillName,
  allSkills,
  filteredSkills,
  visibleSkills,
  skillListMode,
  onSkillListModeChange,
  onClearSkillRestriction,
  onRefreshSkills,
  onToggleSkill,
  pairingRequests,
  approvingPairingCode,
  onRefreshPairing,
  onApprovePairing,
  feishuAccount,
  wechatAccount,
  savingChannelPolicy,
  onUpdateChannelPolicy,
}) {
  return (
    <main className="min-h-0 overflow-y-auto">
      {!employee ? (
        <div className="flex h-full min-h-[560px] items-center justify-center px-8 text-center">
          <div>
            <div className="text-base font-medium text-primary">Select an agent to view details</div>
            {canManage && (
              <button type="button" onClick={onCreate} className="mt-4 inline-flex h-8 items-center justify-center rounded-lg bg-white px-3 text-sm font-medium text-[#171717] transition-colors hover:bg-stone-200">
                + 新增员工
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="mx-auto max-w-[1080px] px-5 py-4">
          <div className="flex h-12 items-center justify-between gap-3 border-b border-subtle pb-4">
            <div className="flex min-w-0 items-center gap-2">
              <div className="text-base font-semibold text-primary">员工设置</div>
              <span className={`rounded-md border px-2 py-0.5 text-2xs font-medium ${employeeStatusBadgeClass(employee.status)}`}>
                {formatStatusLabel(employee.status)}
              </span>
              {employee.activationError && (
                <div className="ml-2 truncate text-xs text-danger-text">
                  Uniopc 引擎 注册失败：{employee.activationError}
                </div>
              )}
            </div>

            <div className="flex shrink-0 flex-wrap gap-2">
              {canManage && (
                <>
                  <button type="button" onClick={() => onEdit(employee)} className="inline-flex h-8 items-center justify-center rounded-lg border border-default bg-surface-raised px-3 text-sm font-medium text-primary transition-colors hover:bg-state-hover">
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(employee)}
                    disabled={employee.isDefault || deletingId === employee.id}
                    title={employee.isDefault ? '默认 AI 员工 main 不能删除' : '删除 AI 员工'}
                    className="inline-flex h-8 items-center justify-center rounded-lg border border-rose-400/18 bg-rose-500/8 px-3 text-sm font-medium text-danger-text transition-colors hover:bg-rose-500/14 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {deletingId === employee.id ? '删除中...' : '删除'}
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="mt-4 border-b border-subtle">
            <div className="flex flex-wrap gap-1">
              {detailTabs.map(tab => {
                const active = detailTab === tab.id
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => onDetailTabChange(tab.id)}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors ${
                      active ? 'bg-white text-[#171717]' : 'text-secondary hover:bg-state-hover hover:text-primary'
                    }`}
                  >
                    {tab.label}
                    {tab.count > 0 && (
                      <span className={`rounded-md px-1.5 py-0.5 text-2xs ${active ? 'bg-surface-sunken text-[#171717]' : 'bg-surface-overlay text-secondary'}`}>
                        {tab.count}
                      </span>
                    )}
                    {tab.alert > 0 && (
                      <span className="rounded-md bg-rose-500 px-1.5 py-0.5 text-2xs font-semibold text-white">
                        {tab.alert}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="py-5">
            {detailTab === 'overview' && (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  ['状态', formatStatusLabel(employee.status)],
                  ['模型', employeeModelLabel(employee, currentModelRef)],
                  ['渠道', channelLabels.length > 0 ? `${channelLabels.length} 个连接` : '未连接'],
                  ['连接', currentProfile],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-subtle bg-surface-sunken px-4 py-3">
                    <div className="text-2xs font-medium text-tertiary">{label}</div>
                    <div className="mt-1 truncate text-sm font-medium text-primary">{value}</div>
                  </div>
                ))}
              </div>
            )}

            {detailTab === 'identity' && (
              <section>
                <div className="mb-2 text-xs font-semibold uppercase text-tertiary">Identity</div>
                <div className="rounded-2xl border border-subtle bg-surface-sunken px-4">
                  <DetailRow label="员工 ID" value={employee.id} mono />
                  <DetailRow label="Uniopc AI 助理" value={formatValue(employee.openclawAgentId || employee.id)} mono />
                  <DetailRow label="名称" value={formatValue(displayEmployeeName(employee))} />
                  <DetailRow label="角色" value={formatValue(employee.role, 'AI 员工')} />
                  <DetailRow label="描述" value={formatValue(employee.description, '暂无职责说明')} />
                  <DetailRow label="类型" value={formatValue(employee.employeeType, 'shared')} />
                  <DetailRow label="是否默认" value={employee.isDefault ? '是' : '否'} />
                </div>
              </section>
            )}

            {detailTab === 'skills' && (
              <section>
                <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase text-tertiary">Skills</div>
                    <div className="mt-1 text-sm text-tertiary">
                      展示当前 Uniopc 引擎 profile/Gateway 已发现的 Skill；这里做员工分配，不安装 Skill。
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      value={skillQuery}
                      onChange={event => onSkillQueryChange(event.target.value)}
                      placeholder="搜索 Skill..."
                      className="h-9 w-full rounded-lg border border-subtle bg-surface-sunken px-3 text-sm text-primary outline-none placeholder:text-tertiary focus:border-violet-400/35 md:w-[220px]"
                    />
                    {skillsRestricted && (
                      <button
                        type="button"
                        onClick={onClearSkillRestriction}
                        disabled={loadingSkills || Boolean(savingSkillName)}
                        className="inline-flex h-9 items-center justify-center rounded-lg border border-default bg-surface-raised px-3 text-sm font-medium text-primary transition-colors hover:bg-state-hover disabled:opacity-50"
                      >
                        恢复为全部
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={onRefreshSkills}
                      disabled={loadingSkills || Boolean(savingSkillName)}
                      className="inline-flex h-9 items-center justify-center rounded-lg border border-default bg-surface-raised px-3 text-sm font-medium text-primary transition-colors hover:bg-state-hover disabled:opacity-50"
                    >
                      {loadingSkills ? '刷新中' : '刷新'}
                    </button>
                  </div>
                </div>

                <div className="mb-3 grid gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-subtle bg-surface-raised p-4">
                    <div className="text-xs text-tertiary">已分配</div>
                    <div className="mt-2 text-2xl font-semibold text-primary">
                      {skillsRestricted ? skillNames.length : '全部'}
                    </div>
                    {!skillsRestricted && <div className="mt-1 text-2xs text-tertiary">未限定，可用全部 Skill</div>}
                  </div>
                  <div className="rounded-xl border border-subtle bg-surface-raised p-4">
                    <div className="text-xs text-tertiary">可使用</div>
                    <div className="mt-2 text-2xl font-semibold text-success-text">{availableSkillCount}</div>
                  </div>
                  <div className="rounded-xl border border-subtle bg-surface-raised p-4">
                    <div className="text-xs text-tertiary">需处理</div>
                    <div className="mt-2 text-2xl font-semibold text-warning-text">{unavailableSkillCount}</div>
                  </div>
                </div>

                <div className="rounded-2xl border border-subtle bg-surface-sunken">
                  {loadingSkills ? (
                    <div className="flex h-56 items-center justify-center text-sm text-tertiary">正在读取 Skills...</div>
                  ) : allSkills.length === 0 ? (
                    <div className="flex h-56 flex-col items-center justify-center px-6 text-center">
                      <div className="text-base font-medium text-primary">No skills yet</div>
                      <div className="mt-2 max-w-md text-sm leading-6 text-tertiary">
                        Gateway 没有返回已发现 Skill。请确认当前 profile 的 Skill 运行环境后刷新。
                      </div>
                    </div>
                  ) : filteredSkills.length === 0 ? (
                    <div className="flex h-56 items-center justify-center text-sm text-tertiary">没有匹配的 Skill</div>
                  ) : (
                    <div className="space-y-4 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="inline-flex rounded-lg border border-subtle bg-surface-raised p-1">
                          {[
                            { id: 'assigned', label: '已分配', count: skillNames.length },
                            { id: 'all', label: '全部', count: allSkills.length },
                          ].map(item => (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => onSkillListModeChange(item.id)}
                              className={`h-8 rounded-md px-3 text-xs font-medium transition-colors ${
                                skillListMode === item.id ? 'bg-white text-[#171717]' : 'text-secondary hover:bg-state-hover hover:text-primary'
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
                          {skillListMode === 'assigned' ? '这个员工还没有分配 Skill。切到“全部”查看可分配项。' : '当前筛选下没有 Skill。'}
                        </div>
                      ) : (
                        <div className="grid gap-3 md:grid-cols-2">
                          {visibleSkills.map(skill => {
                            const assigned = skillNames.includes(skill.name)
                            const status = skillStatus(skill)
                            const canAssign = isSkillAssignable(skill)
                            const saving = savingSkillName === skill.name
                            const canToggle = skillListMode === 'assigned' ? assigned : !assigned && canAssign
                            const disabled = (Boolean(savingSkillName) && !saving) || !canToggle
                            return (
                              <button
                                key={skill.name}
                                type="button"
                                onClick={() => onToggleSkill(skill.name)}
                                disabled={disabled}
                                className={`rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                                  assigned
                                    ? 'border-violet-400/25 bg-violet-400/[0.08] hover:bg-violet-400/[0.12]'
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
                                        ? skillListMode === 'assigned' ? '移除分配' : '已分配'
                                        : canAssign ? '分配给员工' : '需先处理'}
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
              </section>
            )}

            {detailTab === 'runtime' && (
              <section>
                <div className="mb-2 text-xs font-semibold uppercase text-tertiary">Runtime</div>
                <div className="rounded-2xl border border-subtle bg-surface-sunken px-4">
                  <DetailRow label="状态" value={formatStatusLabel(employee.status)} />
                  <DetailRow label="模型" value={employeeModelLabel(employee, currentModelRef)} />
                  <DetailRow label="工作空间连接" value={formatValue(employee.openclawProfile || currentProfile)} mono />
                  <DetailRow label="Profile 项目" value={formatValue(currentProjectName, 'Default')} />
                  <DetailRow label="显式路由数" value={`${routes.length} 条`} />
                </div>
              </section>
            )}

            {detailTab === 'workspace' && (
              <section>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold uppercase text-tertiary">Workspace</div>
                  <button
                    type="button"
                    onClick={() => onOpenDocuments(employee)}
                    className="inline-flex h-8 items-center justify-center rounded-lg border border-default bg-surface-raised px-3 text-sm font-medium text-primary transition-colors hover:bg-state-hover"
                  >
                    管理文档
                  </button>
                </div>
                <div className="rounded-2xl border border-subtle bg-surface-sunken px-4">
                  <DetailRow label="Workspace" value={formatValue(workspacePath)} mono />
                  <DetailRow label="Agent Dir" value={formatValue(agentDir)} mono />
                  <DetailRow label="身份文档" value="IDENTITY.md / AGENTS.md / SOUL.md" mono />
                  <DetailRow label="记忆文档" value="MEMORY.md / memory/*" mono />
                </div>
              </section>
            )}

            {detailTab === 'channels' && (
              <section>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold uppercase text-tertiary">Channels</div>
                  <button
                    type="button"
                    onClick={() => onOpenConnections(employee)}
                    disabled={!employee}
                    className="inline-flex h-8 items-center justify-center rounded-lg bg-white px-3 text-sm font-medium text-[#171717] transition-colors hover:bg-stone-200 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    连接渠道
                  </button>
                </div>
                <div className="rounded-2xl border border-subtle bg-surface-sunken p-4">
                  {pairingRequests.length > 0 && (
                    <div className="mb-4 rounded-2xl border border-rose-400/24 bg-rose-400/[0.07] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-semibold text-danger-text">待批准的配对请求（{pairingRequests.length}）</div>
                        <button type="button" onClick={onRefreshPairing} className="text-xs font-medium text-danger-text/80 transition-colors hover:text-danger-text">
                          刷新
                        </button>
                      </div>
                      <div className="mt-1 text-xs leading-5 text-danger-text/70">
                        陌生人给这位员工发了消息。批准后对方才能收到回复；配对码 1 小时内有效。
                      </div>
                      <div className="mt-3 grid gap-2">
                        {pairingRequests.map(request => (
                          <div key={`${request.channelId}:${request.code}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-subtle bg-surface-sunken px-3 py-2.5">
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-center gap-2 text-sm text-primary">
                                <span className={channelChipClass(pairingChannelLabel(request.channelId))}>{pairingChannelLabel(request.channelId)}</span>
                                <span className="truncate font-medium">{pairingSenderLabel(request)}</span>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-tertiary">
                                <span className="font-mono text-secondary">{request.code}</span>
                                <span>·</span>
                                <span>{pairingExpiryLabel(request.expiresAtMs)}</span>
                                {request.accountId && request.accountId !== 'default' && (
                                  <><span>·</span><span>{request.accountId}</span></>
                                )}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => onApprovePairing(request)}
                              disabled={Boolean(approvingPairingCode)}
                              className="shrink-0 rounded-lg border border-emerald-400/24 bg-emerald-400/12 px-3 py-1.5 text-xs font-medium text-success-text transition-colors hover:bg-emerald-400/20 disabled:opacity-50"
                            >
                              {approvingPairingCode === request.code ? '批准中…' : '批准'}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div>
                      <div className="text-xs font-medium text-tertiary">连接</div>
                      {channelLabels.length === 0 ? (
                        <div className="mt-2 rounded-2xl border border-dashed border-default bg-surface-raised p-4">
                          <div className="text-sm leading-6 text-secondary">还没有给这位 AI 员工绑定远程渠道。</div>
                          <div className="mt-1 text-xs leading-5 text-tertiary">
                            连接 Feishu 或微信后，Uniopc 引擎 会把对应渠道消息路由到这位员工。
                          </div>
                          <button
                            type="button"
                            onClick={() => onOpenConnections(employee)}
                            disabled={!employee}
                            className="mt-3 inline-flex h-8 items-center justify-center rounded-lg border border-default bg-surface-raised px-3 text-sm font-medium text-primary transition-colors hover:bg-state-hover disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            选择渠道
                          </button>
                        </div>
                      ) : (
                        <div className="mt-2 flex flex-wrap gap-2 text-xs">
                          {channelLabels.map(label => <span key={label} className={channelChipClass(label)}>{label}</span>)}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-xs font-medium text-tertiary">准入策略</div>
                      {!feishuAccount && !wechatAccount ? (
                        <div className="mt-2 text-sm leading-6 text-tertiary">绑定渠道后，可以在这里控制谁能私聊这位员工。</div>
                      ) : (
                        <div className="mt-2 space-y-3">
                          {feishuAccount && (
                            <div className="rounded-xl border border-subtle bg-surface-raised p-3">
                              <div className="text-xs font-medium text-secondary">Feishu · {feishuAccount.accountId}</div>
                              <label className="mt-2 block text-xs text-tertiary">
                                私聊
                                <select
                                  value={feishuAccount.dmPolicy || 'pairing'}
                                  disabled={savingChannelPolicy}
                                  onChange={event => onUpdateChannelPolicy('feishu', feishuAccount.accountId, { dmPolicy: event.target.value })}
                                  className="mt-1 w-full rounded-lg border border-default bg-scrim px-2.5 py-1.5 text-sm text-primary outline-none focus:border-violet-400/40 disabled:opacity-50"
                                >
                                  {DM_POLICY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                                </select>
                              </label>
                              <label className="mt-2 block text-xs text-tertiary">
                                群聊
                                <select
                                  value={feishuAccount.groupPolicy || 'allowlist'}
                                  disabled={savingChannelPolicy}
                                  onChange={event => onUpdateChannelPolicy('feishu', feishuAccount.accountId, { groupPolicy: event.target.value })}
                                  className="mt-1 w-full rounded-lg border border-default bg-scrim px-2.5 py-1.5 text-sm text-primary outline-none focus:border-violet-400/40 disabled:opacity-50"
                                >
                                  {GROUP_POLICY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                                </select>
                              </label>
                            </div>
                          )}
                          {wechatAccount && (
                            <div className="rounded-xl border border-subtle bg-surface-raised p-3">
                              <div className="text-xs font-medium text-secondary">微信 · {wechatAccount.accountId}</div>
                              <label className="mt-2 block text-xs text-tertiary">
                                私聊
                                <select
                                  value={wechatAccount.dmPolicy || 'pairing'}
                                  disabled={savingChannelPolicy}
                                  onChange={event => onUpdateChannelPolicy('openclaw-weixin', wechatAccount.accountId, { dmPolicy: event.target.value })}
                                  className="mt-1 w-full rounded-lg border border-default bg-scrim px-2.5 py-1.5 text-sm text-primary outline-none focus:border-violet-400/40 disabled:opacity-50"
                                >
                                  {DM_POLICY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                                </select>
                              </label>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-4 border-t border-subtle pt-4">
                    <div className="text-xs font-medium text-tertiary">Routes</div>
                    {routes.length === 0 ? (
                      <div className="mt-2 text-sm leading-6 text-tertiary">没有显式路由规则，使用默认路由。</div>
                    ) : (
                      <div className="mt-2 space-y-2">
                        {routes.map(route => (
                          <div key={route} className="truncate rounded-lg border border-subtle bg-surface-raised px-3 py-2 text-xs text-secondary">{route}</div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            )}

            {detailTab === 'activity' && (
              <section>
                <div className="mb-2 text-xs font-semibold uppercase text-tertiary">Activity</div>
                <div className="rounded-2xl border border-subtle bg-surface-sunken px-4">
                  <DetailRow label="创建时间" value={formatTimeValue(employee.createdAt)} />
                  <DetailRow label="更新时间" value={formatTimeValue(employee.updatedAt)} />
                  <DetailRow label="项目" value={formatValue(currentProjectName, 'Default')} />
                  <DetailRow label="绑定数" value={`${bindingsCount} 个`} />
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
