import EmployeeAvatar from './EmployeeAvatar'
import { displayEmployeeName } from '../lib/employeeDisplay'
import { plainSummary } from '../lib/plainSummary'

// 装饰异常，不装饰常态。
//
// 原来是头像右下角一个绿点：实测那个绿是全屏出现最多的彩色（9 次），
// 比品牌紫（1 次）还抢眼，让一个次要状态主导了整屏色彩印象。
// 第一版改成"所有 active 都套一圈呼吸环"同样是错的 —— 员工基本全是 active，
// 人人都有的标记不传达任何信息，只剩"每个头像都被选中了"的噪音。
//
// 所以：正常在岗 = 不画任何东西。只有异常状态（创建中/失败/停用/待注册）
// 才上环，此时它在一列里是少数，才有信号价值。
function employeePresenceClass(status) {
  if (!status || status === 'active') return ''
  if (status === 'activation_failed') return 'ui-presence-failed'
  if (status === 'disabled') return 'ui-presence-idle'
  return 'ui-presence-pending'
}

function UnreadBadge({ count }) {
  const value = Number.isFinite(count) ? count : 0
  if (value <= 0) return null
  return (
    <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full border border-surface-raised bg-rose-500 px-1 text-2xs font-semibold leading-none text-white">
      {value > 99 ? '99+' : value}
    </span>
  )
}

function formatStatusLabel(status) {
  if (!status || status === 'active') return '活跃'
  if (status === 'activating') return '创建中'
  if (status === 'activation_failed') return '创建失败'
  if (status === 'disabled') return '已停用'
  return status
}

function EmployeeListAvatar({ employee, unreadCount = 0, busy = false }) {
  // Signature 只在真正稀缺的时刻出现：这位员工正在生成回复。
  // 「在岗」是常态、不值得动效；「正在替你干活」才是一眼要看到的。
  const presence = busy ? 'ui-presence-active' : employeePresenceClass(employee.status)
  return (
    <span
      className="relative inline-flex h-8 w-8"
      title={busy ? '正在回复' : formatStatusLabel(employee.status)}
    >
      <EmployeeAvatar
        name={displayEmployeeName(employee)}
        emoji={employee.emoji}
        size="md"
        kind="ai"
      />
      {presence && <span className={`ui-presence ${presence}`} />}
      <UnreadBadge count={unreadCount} />
    </span>
  )
}

function employeeDetail(employee) {
  // 描述是用户/模板写的自由文本，常带 markdown 列表。直接渲染会让
  // `- **项目开发：**` 这种原样漏在列表上。
  return plainSummary(employee.description) || formatStatusLabel(employee.status)
}

export default function EmployeeListPane({
  mode = 'chat',
  employees = [],
  roster = null,
  loading = false,
  activeEmployeeId = '',
  // 正在生成回复的员工 —— 唯一会触发呼吸环的信号
  busyEmployeeId = '',
  beforeList = null,
  onAdd,
  onSelectEmployee,
  onOpenEmployeeChat,
  onOpenEmployeeSettings,
  emptyDescription = '先创建 AI 员工，再开始对话。',
  addLabel = '+ 新增员工',
}) {
  const count = employees.length
  const showEmployeeSettings = mode === 'chat'
  const showEmployeeChat = mode === 'settings'
  const rosterItems = Array.isArray(roster) ? roster : null

  function selectEmployee(employee) {
    if (mode === 'settings') {
      onOpenEmployeeSettings?.(employee.id)
    } else {
      onOpenEmployeeChat?.(employee.id)
    }
    onSelectEmployee?.(employee.id)
  }

  function renderEmployee(employee, unreadCount = 0) {
    if (!employee) return null
    const active = activeEmployeeId === employee.id
    return (
      <div
        key={`employee:${employee.id}`}
        className={`group grid grid-cols-[minmax(0,1fr)_auto] items-stretch rounded-lg transition-colors ${
          active ? 'bg-state-hover' : 'hover:bg-surface-raised'
        }`}
      >
        <button
          type="button"
          onClick={() => selectEmployee(employee)}
          className="grid min-w-0 grid-cols-[32px_minmax(0,1fr)] gap-2.5 px-2.5 py-3 text-left"
        >
          <EmployeeListAvatar
            employee={employee}
            unreadCount={unreadCount}
            busy={Boolean(busyEmployeeId) && String(employee.id) === String(busyEmployeeId)}
          />
          {/* 不再给默认员工加「默认」徽标：它每次渲染都占一格视觉位，
              但这个事实读者一次就记住了。默认员工本来就排在列表最前，
              详情页也有「是否默认」一行 —— 信息没丢。 */}
          <span className="min-w-0">
            <span className="block truncate text-base font-medium text-primary">{displayEmployeeName(employee)}</span>
            <span className="mt-1 block truncate text-xs text-tertiary">{employeeDetail(employee)}</span>
          </span>
        </button>
        {showEmployeeSettings && (
          <button
            type="button"
            onClick={() => onOpenEmployeeSettings?.(employee.id)}
            className="mr-2 self-center rounded-lg border border-transparent px-2 py-1.5 text-xs font-medium text-tertiary opacity-0 transition-all hover:border-subtle hover:bg-surface-raised hover:text-primary group-hover:opacity-100 group-focus-within:opacity-100"
            title={`设置 ${displayEmployeeName(employee)}`}
          >
            设置
          </button>
        )}
        {showEmployeeChat && (
          <button
            type="button"
            onClick={() => onOpenEmployeeChat?.(employee.id)}
            className="mr-2 self-center rounded-lg border border-transparent px-2 py-1.5 text-xs font-medium text-tertiary opacity-0 transition-all hover:border-subtle hover:bg-surface-raised hover:text-primary group-hover:opacity-100 group-focus-within:opacity-100"
            title={`回到 ${displayEmployeeName(employee)} 的对话`}
          >
            对话
          </button>
        )}
      </div>
    )
  }

  const displayRows = rosterItems || [
    ...employees.map(employee => ({ type: 'employee', id: employee.id, employee })),
  ]

  return (
    <aside className="flex min-h-0 flex-col border-b border-subtle lg:border-b-0">
      <div className="flex h-16 shrink-0 items-center justify-between px-3">
        <div className="min-w-0">
          <div className="text-base font-semibold text-primary">员工</div>
          <div className="mt-0.5 text-xs text-tertiary">
            {loading ? '同步中' : `${count} 位员工`}
          </div>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-subtle bg-surface-raised text-lg leading-none text-secondary transition-colors hover:bg-state-hover hover:text-primary"
          title="新增员工"
        >
          +
        </button>
      </div>

      {beforeList}

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5 py-2">
        {loading && (
          <div className="px-5 py-8 text-center text-sm text-tertiary">
            正在同步员工列表...
          </div>
        )}

        {!loading && count === 0 && (
          <div className="flex h-[360px] items-center justify-center px-8 text-center">
            <div>
              <div className="text-base font-medium text-primary">No employees yet</div>
              <div className="mt-2 text-sm leading-6 text-tertiary">
                {emptyDescription}
              </div>
              <button
                type="button"
                onClick={onAdd}
                className="mt-4 inline-flex h-8 items-center justify-center rounded-lg bg-white px-3 text-sm font-medium text-[#171717] transition-colors hover:bg-stone-200"
              >
                {addLabel}
              </button>
            </div>
          </div>
        )}

        {displayRows.map(item => renderEmployee(item.employee, item.unreadCount))}
      </div>
    </aside>
  )
}
