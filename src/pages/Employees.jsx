import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { engineClient } from '../lib/engine/client.js'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../hooks/useAuth'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import { profileWorkspaceNavigationState, useProfileWorkspace } from '../hooks/useProfileWorkspace'
import { ensureOpenClawStatus, useRuntimeStatusStore } from '../lib/runtimeStatus'
import {
  getLocalEmployees,
  invalidateLocalEmployeesCache,
  loadLocalEmployees,
  primeLocalEmployeesCache,
} from '../lib/openclawEmployees'
import { loadEmployeeDirectory } from '../lib/employeeDirectory'
import { profileWorkspacePath } from '../lib/profileWorkspace'
import Modal from '../components/Modal'
import { ACTION, SURFACE } from '../lib/theme'
import EmployeeAvatar from '../components/EmployeeAvatar'
import { supabase } from '../lib/supabase'
import {
  approveCloudAiEmployeeCreationRequest,
  listMyCloudAiEmployeeRequests,
  requestCloudAiEmployeeCreation,
  syncMyCloudAiEmployees,
  upsertCloudEmployee,
} from '../lib/cloudWorkspace'
import { renderMarkdownToHtml } from '../lib/markdown'
import {
  isSkillAssignable,
  sourceLabel,
} from '../lib/skillAssignments'
import {
  formatOpenClawModelLabel,
} from '../lib/openclawModels'
import { displayEmployeeName } from '../lib/employeeDisplay'
import { shouldOpenEmployeeCreateFromSearch } from '../lib/employeeNavigation'
import { shouldDeferOpenClawDirectoryHydration } from '../lib/openclawAccess'
import { lazyPage } from '../lib/lazyPage'
import EmployeeDirectoryPane from './employees/EmployeeDirectoryPane'
import EmployeeDetailPane from './employees/EmployeeDetailPane'

const EmployeeConnectionsDialog = lazyPage(() => import('./employees/EmployeeConnectionsDialog'))

const EMPTY_FORM = {
  id: '',
  name: '',
  role: '',
  description: '',
  emoji: '',
  model: '',
  thinkingDefault: '',
}

// 思考强度是员工级配置（Accio 同款：不在每条消息上问用户）。
// low 是所有支持思考的模型都接受的档位（二元思考模型里即 on）。
const EMPLOYEE_THINKING_CHOICES = [
  { id: '', label: '跟随引擎默认' },
  { id: 'off', label: '关闭思考（更快、更省额度）' },
  { id: 'low', label: '开启思考（回答更深入）' },
]

const EMPTY_FEISHU_FORM = {
  accountId: 'default',
  domain: 'feishu',
  appId: '',
  appSecret: '',
}

const EMPTY_WECHAT_FORM = {
  accountId: '',
}

const EMPLOYEE_FORM_ID = 'employee-modal-form'

function formatModelLabel(option) {
  return formatOpenClawModelLabel(option)
}

function employeeModelLabel(employee, currentModelRef = '') {
  const explicitModel = String(employee?.model || '').trim()
  if (explicitModel) return formatModelLabel(explicitModel)
  const inheritedModel = String(employee?.defaultModel || currentModelRef || '').trim()
  return inheritedModel ? `跟随 Profile 默认：${formatModelLabel(inheritedModel)}` : '跟随 Profile 默认'
}

function formatProviderLabel(provider) {
  const raw = String(provider || '').trim()
  if (!raw) return ''

  const match = raw.match(/^([^\s:]+)(?:\s+([^:]+))?(?::\s*(.+))?$/)
  if (!match) return raw

  const [, channelId, accountId = '', state = ''] = match
  const channelName =
    channelId === 'openclaw-weixin'
      ? '微信'
      : channelId === 'feishu'
        ? 'Feishu'
        : channelId

  if (accountId && state && state !== 'configured') return `${channelName} · ${accountId} · ${state}`
  if (accountId) return `${channelName} · ${accountId}`
  if (state) return `${channelName} · ${state}`
  return channelName
}

function collectEmployeeChannelLabels(employee, { feishuAccount = null, wechatAccount = null } = {}) {
  const labels = []

  if (feishuAccount?.accountId) labels.push(`Feishu · ${feishuAccount.accountId}`)
  if (wechatAccount?.accountId) labels.push(`微信 · ${wechatAccount.accountId}`)

  for (const provider of Array.isArray(employee?.providers) ? employee.providers : []) {
    const label = formatProviderLabel(provider)
    if (label) labels.push(label)
  }

  if (labels.length === 0 && Number(employee?.bindings || 0) > 0) {
    labels.push(`已绑定 ${employee.bindings} 个 channel`)
  }

  return Array.from(new Set(labels))
}

function safeDisposeTauriListener(unlisten) {
  if (typeof unlisten !== 'function') return
  try {
    const result = unlisten()
    if (result && typeof result.catch === 'function') {
      result.catch(() => null)
    }
  } catch {
    // Tauri can race while disposing listeners during WebView navigation.
  }
}

function getEmployeeAgentId(employee) {
  return employee?.openclawAgentId || employee?.id || ''
}

function mergeEmployeeList(items, employee) {
  if (!employee?.id) return items

  const next = Array.isArray(items) ? [...items] : []
  const index = next.findIndex(item => item.id === employee.id)
  if (index >= 0) {
    next[index] = employee
  } else {
    next.push(employee)
  }
  return next
}

function orderEmployeesForChat(items) {
  return [...items].sort((a, b) => {
    const aDefault = Boolean(a.isDefault)
    const bDefault = Boolean(b.isDefault)
    if (aDefault !== bDefault) return aDefault ? -1 : 1
    const aKey = String(a.name || a.id || '')
    const bKey = String(b.name || b.id || '')
    return aKey.localeCompare(bKey, 'zh-CN')
  })
}

export default function Employees() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const activeOpenClaw = useActiveOpenClawProfile()
  const profileWorkspace = useProfileWorkspace()
  const profileWorkspaceState = profileWorkspaceNavigationState(profileWorkspace)
  const workspaceProfile = profileWorkspace || activeOpenClaw.workspaceProfile
  const [searchParams, setSearchParams] = useSearchParams()
  const runtime = useRuntimeStatusStore()
  const currentProject = null
  const [employees, setEmployees] = useState([])
  const [employeeRequests, setEmployeeRequests] = useState([])
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [requestActionId, setRequestActionId] = useState('')
  const [deletingId, setDeletingId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [connectModalOpen, setConnectModalOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  // 角色模板来自已安装插件声明的 agentTemplates(如 uniopc-employee-roles 角色包)。
  const [roleTemplates, setRoleTemplates] = useState([])
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [employeeDetailTab, setEmployeeDetailTab] = useState('overview')
  const [feishuOverview, setFeishuOverview] = useState(null)
  const [loadingFeishu, setLoadingFeishu] = useState(false)
  const [savingFeishu, setSavingFeishu] = useState(false)
  const [bindingFeishu, setBindingFeishu] = useState(false)
  const [feishuForm, setFeishuForm] = useState(EMPTY_FEISHU_FORM)
  const [selectedChannelKind, setSelectedChannelKind] = useState('feishu')
  const [wechatOverview, setWechatOverview] = useState(null)
  const [loadingWechat, setLoadingWechat] = useState(false)
  const [installingWechat, setInstallingWechat] = useState(false)
  const [bindingWechat, setBindingWechat] = useState(false)
  const [startingWechatQr, setStartingWechatQr] = useState(false)
  const [checkingWechatQr, setCheckingWechatQr] = useState(false)
  const [wechatForm, setWechatForm] = useState(EMPTY_WECHAT_FORM)
  const [wechatQrSession, setWechatQrSession] = useState(null)
  const [wechatQrAutoTried, setWechatQrAutoTried] = useState(false)
  const [pairingRequests, setPairingRequests] = useState([])
  const [approvingPairingCode, setApprovingPairingCode] = useState('')
  const [savingChannelPolicy, setSavingChannelPolicy] = useState(false)
  const [employeeDocsOpen, setEmployeeDocsOpen] = useState(false)
  const [employeeDocsEmployee, setEmployeeDocsEmployee] = useState(null)
  const [employeeDocuments, setEmployeeDocuments] = useState([])
  const [loadingEmployeeDocuments, setLoadingEmployeeDocuments] = useState(false)
  const [selectedEmployeeDocPath, setSelectedEmployeeDocPath] = useState('')
  const [employeeDocumentDetail, setEmployeeDocumentDetail] = useState(null)
  const [loadingEmployeeDocument, setLoadingEmployeeDocument] = useState(false)
  const [editingEmployeeDocument, setEditingEmployeeDocument] = useState(false)
  const [employeeDocumentValue, setEmployeeDocumentValue] = useState('')
  const [savingEmployeeDocument, setSavingEmployeeDocument] = useState(false)
  const [skillhubSkills, setSkillhubSkills] = useState([])
  const [skillhubAgents, setSkillhubAgents] = useState([])
  const [loadingSkillhub, setLoadingSkillhub] = useState(false)
  const [savingSkillName, setSavingSkillName] = useState('')
  const [skillQuery, setSkillQuery] = useState('')
  const [skillListMode, setSkillListMode] = useState('assigned')
  const [modelSnapshot, setModelSnapshot] = useState(null)
  const employeeIdFromUrl = searchParams.get('agent') || ''

  const openClawStatus = runtime.openClaw.status
  const currentModelRef =
    openClawStatus?.resolvedDefaultModel ||
    openClawStatus?.defaultModel ||
    modelSnapshot?.resolvedDefaultModel ||
    modelSnapshot?.primaryModel ||
    ''
  const configuredWechatAccounts = useMemo(
    () => (wechatOverview?.accounts || []).filter(account => account.configured),
    [wechatOverview],
  )
  const activeProfile = profileWorkspace ? profileWorkspace.activeProfile : activeOpenClaw.activeProfile || ''
  const conversationsPath = query => {
    const base = profileWorkspace ? profileWorkspacePath(profileWorkspace, 'conversations') : '/conversations'
    return query ? `${base}?${query}` : base
  }
  const gatewayPort = profileWorkspace ? profileWorkspace.gatewayPort : workspaceProfile?.gatewayPort || workspaceProfile?.gateway_port || null
  const currentProfile = activeProfile
  // Latest profile for in-flight async loads to compare against (see loadEmployees).
  const currentProfileRef = useRef(currentProfile)
  currentProfileRef.current = currentProfile
  const skillProfile = activeProfile
  function requireCurrentProfile(message = '组织管理员尚未为该工作区创建 Uniopc 引擎 profile。') {
    if (currentProfile) return currentProfile
    setError(message)
    return ''
  }
  const deferOpenClawDirectoryHydration = shouldDeferOpenClawDirectoryHydration({
    userId: user?.uid,
    workspaceProfileLoading: profileWorkspace ? profileWorkspace.loading : activeOpenClaw.loading,
  })
  const useCloudEmployeeDirectory = false
  const canManageAiEmployees = true
  const canManageChannels = Boolean(currentProfile)
  const renderedEmployeeDoc = useMemo(
    () => renderMarkdownToHtml(employeeDocumentValue || employeeDocumentDetail?.content || ''),
    [employeeDocumentDetail?.content, employeeDocumentValue],
  )
  const isEmployeeDocDirty = Boolean(
    employeeDocumentDetail && employeeDocumentValue !== employeeDocumentDetail.content,
  )
  const selectedEmployee = useMemo(
    () => employees.find(employee => employee.id === selectedEmployeeId) || employees[0] || null,
    [employees, selectedEmployeeId],
  )
  const selectedFeishuAccount = selectedEmployee ? getEmployeeFeishuAccount(selectedEmployee.id) : null
  const selectedWechatAccount = selectedEmployee ? getEmployeeWechatAccount(selectedEmployee.id) : null
  const selectedChannelLabels = selectedEmployee
    ? collectEmployeeChannelLabels(selectedEmployee, {
        feishuAccount: selectedFeishuAccount,
        wechatAccount: selectedWechatAccount,
      })
    : []
  const visibleEmployeeRequests = employeeRequests.filter(request => (
    request.status === 'pending' || request.status === 'failed'
  ))
  const pendingEmployeeRequests = visibleEmployeeRequests.filter(request => request.status === 'pending')
  const selectedWorkspacePath = selectedEmployee?.workspace || selectedEmployee?.workspacePath || ''
  const selectedAgentDir = selectedEmployee?.agentDir || ''
  const selectedRoutes = Array.isArray(selectedEmployee?.routes) ? selectedEmployee.routes : []
  const selectedBindingsCount = Number(selectedEmployee?.bindings || selectedEmployee?.bindingsCount || 0)
  const defaultEmployeeId = useMemo(
    () => employees.find(employee => employee.isDefault)?.id || '',
    [employees],
  )
  // 配对请求归属:渠道账号绑定了谁就算谁的;未绑定账号的消息按引擎默认路由
  // 落到默认员工,待批请求也一并归到默认员工头上。
  const pairingByEmployeeId = useMemo(() => {
    const map = new Map()
    for (const request of pairingRequests) {
      const overview = request.channelId === 'feishu' ? feishuOverview : wechatOverview
      const account = overview?.accounts?.find(item => item.accountId === request.accountId)
      const employeeId = account?.currentAgentId || defaultEmployeeId
      if (!employeeId) continue
      if (!map.has(employeeId)) map.set(employeeId, [])
      map.get(employeeId).push(request)
    }
    return map
  }, [pairingRequests, feishuOverview, wechatOverview, defaultEmployeeId])
  const selectedPairingRequests = selectedEmployee
    ? pairingByEmployeeId.get(selectedEmployee.id) || []
    : []
  const skillAssignmentsByAgentId = useMemo(() => {
    const map = new Map()
    for (const agent of Array.isArray(skillhubAgents) ? skillhubAgents : []) {
      if (agent?.id) map.set(agent.id, Array.isArray(agent.skills) ? agent.skills : [])
    }
    return map
  }, [skillhubAgents])
  const selectedEmployeeAgentId = getEmployeeAgentId(selectedEmployee)
  const selectedEmployeeSkillNames = selectedEmployeeAgentId
    ? skillAssignmentsByAgentId.get(selectedEmployeeAgentId) || []
    : []
  // `agents.list[].skills` is an OPTIONAL allowlist: leaving it empty means the
  // engine exposes every eligible skill, and setting it NARROWS the agent to
  // exactly that list. Counting straight off the array therefore reported "0
  // 已分配 / 0 可使用" for an employee that could actually use every skill.
  const selectedEmployeeSkillsRestricted = selectedEmployeeSkillNames.length > 0
  const selectedEmployeeSkills = selectedEmployeeSkillsRestricted
    ? selectedEmployeeSkillNames.map(name => (
      skillhubSkills.find(skill => skill.name === name) || { name, description: '', eligible: true, bundled: false }
    ))
    : skillhubSkills
  const selectedUnavailableSkillCount = selectedEmployeeSkills.filter(skill => !isSkillAssignable(skill)).length
  const selectedAvailableSkillCount = selectedEmployeeSkills.length - selectedUnavailableSkillCount
  const matchesEmployeeSkillQuery = skill => {
    const needle = skillQuery.trim().toLowerCase()
    if (!needle) return true
    return `${skill.name} ${skill.description || ''} ${sourceLabel(skill)}`.toLowerCase().includes(needle)
  }
  const filteredSelectedEmployeeSkills = selectedEmployeeSkills.filter(matchesEmployeeSkillQuery)
  const filteredEmployeeSkills = skillhubSkills.filter(skill => {
    return matchesEmployeeSkillQuery(skill)
  })
  const visibleEmployeeSkills = skillListMode === 'assigned' ? filteredSelectedEmployeeSkills : filteredEmployeeSkills
  const employeeDetailTabs = [
    { id: 'overview', label: '概览' },
    { id: 'identity', label: '身份' },
    { id: 'skills', label: 'Skills', count: selectedEmployeeSkillNames.length },
    { id: 'runtime', label: '运行' },
    { id: 'workspace', label: '工作区' },
    { id: 'channels', label: '渠道', count: selectedChannelLabels.length || selectedBindingsCount, alert: selectedPairingRequests.length },
    { id: 'activity', label: '活动' },
  ]

  useEffect(() => {
    if (useCloudEmployeeDirectory) return
    if (!currentProfile) {
      setModelSnapshot(null)
      return
    }
    ensureOpenClawStatus().catch(() => null)
    engineClient.models.snapshot({ profile: currentProfile })
      .then(snapshot => setModelSnapshot(snapshot))
      .catch(() => setModelSnapshot(null))
  }, [currentProfile, useCloudEmployeeDirectory])

  useEffect(() => {
    if (employees.length === 0) {
      setSelectedEmployeeId('')
      return
    }

    if (employeeIdFromUrl && employees.some(employee => employee.id === employeeIdFromUrl)) {
      setSelectedEmployeeId(employeeIdFromUrl)
      return
    }

    if (!employees.some(employee => employee.id === selectedEmployeeId)) {
      setSelectedEmployeeId(employees[0].id)
    }
  }, [employeeIdFromUrl, employees, selectedEmployeeId])

  useEffect(() => {
    if (!user?.uid) return
    loadEmployeeRequests().catch(() => null)
  }, [user?.uid])

  useEffect(() => {
    let cancelled = false

    async function hydrate() {
      if (deferOpenClawDirectoryHydration) {
        setEmployees([])
        setLoading(true)
        setError('')
        return
      }
      setEmployees([])
      const profile = currentProfile
      if (!profile) {
        setLoading(false)
        setError('组织管理员尚未为你创建 Uniopc 引擎 profile。')
        return
      }
      setLoading(true)
      setError('')
      try {
        const directory = await loadEmployeeDirectory({
          profile,
          source: 'runtime',
          syncCloudEmployees: items => user?.uid
            ? syncMyCloudAiEmployees(supabase, user.uid, items)
            : Promise.resolve([]),
        })
        if (!cancelled) setEmployees(orderEmployeesForChat(directory.employees))
      } catch (err) {
        if (!cancelled) setError(String(err?.message || err || '读取当前 AI 员工失败'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    hydrate()

    return () => {
      cancelled = true
    }
  }, [currentProfile, deferOpenClawDirectoryHydration, user?.uid])

  useEffect(() => {
    let cancelled = false
    let disposeSnapshot = null

    async function refreshLocalEmployees() {
      if (deferOpenClawDirectoryHydration) return
      if (useCloudEmployeeDirectory) return
      if (!currentProfile) {
        setEmployees([])
        setLoading(false)
        return
      }
      invalidateLocalEmployeesCache(currentProfile)
      const employees = await loadLocalEmployees(currentProfile)
      if (!cancelled) {
        primeLocalEmployeesCache(employees, currentProfile)
        setEmployees(orderEmployeesForChat(employees))
        setLoading(false)
      }
    }

    listen('project-snapshot-changed', (event) => {
      const payload = event?.payload || {}
      const source = String(payload.source || '')
      const sameProfile = !payload.profile || payload.profile === currentProfile
      if (useCloudEmployeeDirectory) return
      if (!source.startsWith('agents.') || !sameProfile) return
      refreshLocalEmployees().catch(() => null)
    }).then((unlisten) => {
      if (cancelled) {
        safeDisposeTauriListener(unlisten)
        return
      }
      disposeSnapshot = unlisten
    }).catch(() => null)

    return () => {
      cancelled = true
      safeDisposeTauriListener(disposeSnapshot)
    }
  }, [currentProfile, deferOpenClawDirectoryHydration, useCloudEmployeeDirectory])

  useEffect(() => {
    if (!canManageChannels) {
      setFeishuOverview(null)
      setWechatOverview(null)
      return
    }

    loadFeishuOverview()
    loadWechatOverview()
  }, [canManageChannels])

  useEffect(() => {
    if (!canManageChannels) {
      setPairingRequests([])
      return
    }
    loadPairingRequests()
    // 配对码 1 小时过期、每渠道最多挂 3 个待批请求,轮询要跟得上运营节奏。
    const timer = setInterval(loadPairingRequests, 30000)
    return () => clearInterval(timer)
  }, [canManageChannels, currentProfile])

  useEffect(() => {
    loadEmployeeSkillhubSnapshot(skillProfile)
  }, [skillProfile])

  useEffect(() => {
    function handleOpenGuide() {
      setGuideOpen(true)
    }

    function handleOpenCreate() {
      openCreateModal()
    }

    window.addEventListener('uniopc:open-employee-guide', handleOpenGuide)
    window.addEventListener('uniopc:open-employee-create', handleOpenCreate)

    return () => {
      window.removeEventListener('uniopc:open-employee-guide', handleOpenGuide)
      window.removeEventListener('uniopc:open-employee-create', handleOpenCreate)
    }
  }, [currentProfile])

  useEffect(() => {
    if (!shouldOpenEmployeeCreateFromSearch(searchParams)) return

    if (!openCreateModal()) return
    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete('create')
    setSearchParams(nextParams, { replace: true })
  }, [currentProfile, searchParams, setSearchParams])

  useEffect(() => {
    if (!connectModalOpen || !wechatQrSession?.sessionKey || wechatQrSession.connected) return

    let cancelled = false
    const timer = window.setTimeout(async () => {
      setCheckingWechatQr(true)
      try {
        const result = await engineClient.agents.waitWechatQr({
          req: {
            accountId: wechatQrSession.accountId,
            timeoutMs: 1500,
          },
        })
        if (cancelled) return

        setWechatQrSession(prev =>
          prev
            ? {
                ...prev,
                accountId: result.accountId || prev.accountId,
                sessionKey: result.sessionKey || prev.sessionKey,
                qrDataUrl: result.qrDataUrl || prev.qrDataUrl,
                message: result.message || prev.message,
                connected: Boolean(result.connected),
              }
            : prev,
        )

        if (result.connected) {
          await loadWechatOverview()
          if (cancelled) return
          setWechatForm({
            accountId: result.accountId || wechatQrSession.accountId || '',
          })
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err?.message || err || '检查微信扫码状态失败'))
        }
      } finally {
        if (!cancelled) {
          setCheckingWechatQr(false)
        }
      }
    }, 2000)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [connectModalOpen, wechatQrSession?.accountId, wechatQrSession?.connected, wechatQrSession?.sessionKey])

  useEffect(() => {
    if (!connectModalOpen || !wechatOverview?.pluginInstalled) return
    if (loadingWechat || startingWechatQr || checkingWechatQr) return
    if (configuredWechatAccounts.length > 0) return
    if (wechatQrAutoTried) return
    if (wechatQrSession?.qrDataUrl || wechatQrSession?.connected) return

    setWechatQrAutoTried(true)
    startWechatQrLogin(false)
  }, [
    connectModalOpen,
    wechatOverview?.pluginInstalled,
    loadingWechat,
    startingWechatQr,
    checkingWechatQr,
    configuredWechatAccounts.length,
    wechatQrAutoTried,
    wechatQrSession?.qrDataUrl,
    wechatQrSession?.connected,
  ])

  async function loadEmployees(force = false, profileArg = currentProfile) {
    if (!profileArg) {
      setEmployees([])
      setLoading(false)
      setError('组织管理员尚未为你创建 Uniopc 引擎 profile。')
      return
    }
    if (!getLocalEmployees(profileArg) && !force) {
      setLoading(true)
    }
    setError('')
    try {
      const directory = await loadEmployeeDirectory({
        force,
        profile: profileArg,
        source: 'runtime',
        syncCloudEmployees: items => user?.uid
          ? syncMyCloudAiEmployees(supabase, user.uid, items)
          : Promise.resolve([]),
      })
      // A stale in-flight load must not clobber the roster after the user
      // switched profiles — only the load for the current profile may land.
      if (profileArg !== currentProfileRef.current) return
      setEmployees(orderEmployeesForChat(directory.employees))
    } catch (err) {
      const message = String(err?.message || err || '读取当前 AI 员工失败')
      if (getLocalEmployees(profileArg)?.length > 0) {
        setError(`员工列表实时刷新失败，当前显示本地缓存：${message}`)
      } else {
        setError(message)
      }
    } finally {
      setLoading(false)
    }
  }

  async function loadEmployeeSkillhubSnapshot(profileArg = skillProfile) {
    if (!profileArg) {
      setSkillhubSkills([])
      setSkillhubAgents([])
      return
    }
    setLoadingSkillhub(true)
    try {
      const snapshot = await engineClient.agents.skillhubSnapshot({
        profile: profileArg,
      })
      setSkillhubSkills(Array.isArray(snapshot?.skills) ? snapshot.skills : [])
      setSkillhubAgents(Array.isArray(snapshot?.agents) ? snapshot.agents : [])
    } catch (err) {
      setSkillhubSkills([])
      setSkillhubAgents([])
      setError(String(err?.message || err || '读取 Skills 失败'))
    } finally {
      setLoadingSkillhub(false)
    }
  }

  async function loadFeishuOverview() {
    if (!canManageChannels) {
      setFeishuOverview(null)
      return
    }
    setLoadingFeishu(true)
    try {
      const overview = await engineClient.agents.feishuOverview()
      setFeishuOverview(overview)
    } catch {
      setFeishuOverview(null)
    } finally {
      setLoadingFeishu(false)
    }
  }

  async function loadWechatOverview() {
    if (!canManageChannels) {
      setWechatOverview(null)
      return null
    }
    setLoadingWechat(true)
    try {
      const overview = await engineClient.agents.wechatOverview()
      setWechatOverview(overview)
      return overview
    } catch {
      setWechatOverview(null)
      return null
    } finally {
      setLoadingWechat(false)
    }
  }

  async function loadPairingRequests() {
    if (!canManageChannels) {
      setPairingRequests([])
      return
    }
    try {
      const snapshot = await engineClient.agents.listChannelPairingRequests()
      setPairingRequests(Array.isArray(snapshot?.requests) ? snapshot.requests : [])
    } catch {
      // 静默保留上一次结果:pairing 文件读取失败不应打断页面
    }
  }

  function getEmployeeFeishuAccount(employeeId, overview = feishuOverview) {
    if (!employeeId || !overview?.accounts) return null
    return overview.accounts.find(account => account.currentAgentId === employeeId) || null
  }

  function getEmployeeWechatAccount(employeeId, overview = wechatOverview) {
    if (!employeeId || !overview?.accounts) return null
    return overview.accounts.find(account => account.currentAgentId === employeeId) || null
  }

  function syncFeishuFormForEmployee(employeeId, overview = feishuOverview) {
    const boundAccount = getEmployeeFeishuAccount(employeeId, overview)
    const fallbackAccount = overview?.accounts?.[0] || null
    const source = boundAccount || fallbackAccount

    setFeishuForm({
      accountId: source?.accountId || 'default',
      domain: source?.domain || 'feishu',
      appId: source?.appId || '',
      appSecret: '',
    })
  }

  function syncWechatFormForEmployee(employeeId, overview = wechatOverview) {
    const boundAccount = getEmployeeWechatAccount(employeeId, overview)
    const configuredAccounts = (overview?.accounts || []).filter(account => account.configured)
    const fallbackAccount = configuredAccounts[0] || null
    const source = boundAccount?.configured ? boundAccount : fallbackAccount

    setWechatForm({
      accountId: source?.accountId || '',
    })
  }

  function selectEmployee(employeeId) {
    setSelectedEmployeeId(employeeId)
    setSearchParams({ agent: employeeId })
  }

  function changeSelectedChannelKind(channelKind) {
    setSelectedChannelKind(channelKind)
    if (channelKind === 'wechat') {
      syncWechatFormForEmployee(form.id)
    } else {
      syncFeishuFormForEmployee(form.id)
    }
  }

  function changeFeishuAccount(accountId) {
    const account = feishuOverview?.accounts?.find(item => item.accountId === accountId)
    setFeishuForm(prev => ({
      ...prev,
      accountId,
      domain: account?.domain || prev.domain,
      appId: account?.appId || prev.appId,
      appSecret: '',
    }))
  }

  function changeWechatAccount(accountId) {
    setWechatQrSession(null)
    setWechatForm({ accountId })
  }

  function refreshWechatQr() {
    setWechatQrAutoTried(true)
    startWechatQrLogin(true)
  }

  function openCreateModal() {
    if (!currentProfile) {
      setError('组织管理员尚未为你创建 Uniopc 引擎 profile，暂时不能创建 AI 员工。')
      return false
    }
    setEditing(false)
    setForm({
      ...EMPTY_FORM,
      model: '',
      role: '通用员工',
      description: '负责持续对话、整理任务并推动业务下一步。',
    })
    setSelectedTemplateId('')
    engineClient.agents.listTemplates()
      .then(list => setRoleTemplates(Array.isArray(list) ? list : []))
      .catch(() => setRoleTemplates([]))
    setFeishuForm(EMPTY_FEISHU_FORM)
    setWechatForm(EMPTY_WECHAT_FORM)
    setWechatQrSession(null)
    setWechatQrAutoTried(false)
    setModalOpen(true)
    return true
  }

  function openEditModal(employee) {
    setEditing(true)
    setForm({
      id: employee.id,
      name: employee.name,
      role: employee.role,
      description: employee.description,
      emoji: employee.emoji || '',
      model: employee.model || '',
      thinkingDefault: employee.thinkingDefault || '',
    })
    syncFeishuFormForEmployee(employee.id)
    syncWechatFormForEmployee(employee.id)
    setWechatQrSession(null)
    setWechatQrAutoTried(false)
    setModalOpen(true)
  }

  function openConnectModal(employee) {
    setEditing(true)
    const hasWechat = Boolean(getEmployeeWechatAccount(employee.id))
    setForm({
      id: employee.id,
      name: employee.name,
      role: employee.role,
      description: employee.description,
      emoji: employee.emoji || '',
      model: employee.model || '',
      thinkingDefault: employee.thinkingDefault || '',
    })
    syncFeishuFormForEmployee(employee.id)
    syncWechatFormForEmployee(employee.id)
    setSelectedChannelKind(hasWechat ? 'wechat' : 'feishu')
    setWechatQrSession(null)
    setWechatQrAutoTried(false)
    setConnectModalOpen(true)
  }

  function openEmployeeDocs(employee) {
    setEmployeeDocsEmployee(employee)
    setEmployeeDocsOpen(true)
    setEmployeeDocuments([])
    setSelectedEmployeeDocPath('')
    setEmployeeDocumentDetail(null)
    setEmployeeDocumentValue('')
    setEditingEmployeeDocument(false)
  }

  function applyRoleTemplate(template) {
    if (!template) {
      setSelectedTemplateId('')
      return
    }
    setSelectedTemplateId(template.id)
    setForm(prev => ({
      ...prev,
      name: template.name || prev.name,
      role: template.name || prev.role,
      description: template.description || prev.description,
      emoji: template.emoji || prev.emoji,
    }))
  }

  function closeModal() {
    setModalOpen(false)
    setForm(EMPTY_FORM)
    setSelectedTemplateId('')
    setFeishuForm(EMPTY_FEISHU_FORM)
    setWechatForm(EMPTY_WECHAT_FORM)
    setSelectedChannelKind('feishu')
    setWechatQrSession(null)
    setWechatQrAutoTried(false)
    setEditing(false)
  }

  async function loadEmployeeRequests() {
    if (!user?.uid) return
    try {
      const rows = await listMyCloudAiEmployeeRequests(supabase, user.uid)
      setEmployeeRequests(rows)
    } catch (err) {
      setError(String(err?.message || err || '读取 AI 员工创建申请失败'))
    }
  }

  async function approveEmployeeRequest(request) {
    if (!request?.id || requestActionId) return
    setRequestActionId(request.id)
    setError('')
    try {
      const requestProfile = request.openclaw_profile || currentProfile
      if (!requestProfile) {
        setError('组织管理员尚未为该申请创建 Uniopc 引擎 profile。')
        return
      }
      const requestModel = String(request.default_model || '').trim()
      const created = await engineClient.agents.create({
        req: {
          name: request.name,
          role: request.role,
          description: request.description,
          emoji: request.emoji,
          model: requestModel || null,
          profile: requestProfile,
        },
      })
      const cloudEmployee = await upsertCloudEmployee(
        supabase,
        user.uid,
        {
          ...created,
          organization_id: request.organization_id,
          organization_member_id: request.organization_member_id,
          openclaw_profile_id: request.openclaw_profile_id,
          openclaw_profile: request.openclaw_profile,
          runtime_status: created.status === 'active' ? 'online' : 'offline',
        },
        requestProfile,
      )
      await approveCloudAiEmployeeCreationRequest(supabase, user.uid, {
        requestId: request.id,
        cloudEmployeeId: cloudEmployee.id,
        openclawAgentId: created.id,
      })
      await Promise.all([
        loadEmployeeRequests(),
        loadEmployees(true, requestProfile),
      ])
    } catch (err) {
      const message = String(err?.message || err || '批准 AI 员工创建申请失败')
      setError(message)
      try {
        await approveCloudAiEmployeeCreationRequest(supabase, user.uid, {
          requestId: request.id,
          openclawAgentId: request.openclaw_agent_id || request.name,
          failureMessage: message,
        })
        await loadEmployeeRequests()
      } catch {
        // Keep the original creation error visible.
      }
    } finally {
      setRequestActionId('')
    }
  }

  function closeConnectModal() {
    setConnectModalOpen(false)
    setForm(EMPTY_FORM)
    setFeishuForm(EMPTY_FEISHU_FORM)
    setWechatForm(EMPTY_WECHAT_FORM)
    setWechatQrSession(null)
    setWechatQrAutoTried(false)
    setEditing(false)
  }

  function closeEmployeeDocs() {
    setEmployeeDocsOpen(false)
    setEmployeeDocsEmployee(null)
    setEmployeeDocuments([])
    setSelectedEmployeeDocPath('')
    setEmployeeDocumentDetail(null)
    setEmployeeDocumentValue('')
    setEditingEmployeeDocument(false)
  }

  // Clearing the allowlist hands the employee every eligible skill back — the
  // engine's default. This is the only way out of a restriction, so it needs a
  // visible control rather than "unassign them one by one".
  async function clearSelectedEmployeeSkillRestriction() {
    if (!selectedEmployee || !selectedEmployeeAgentId || savingSkillName) return
    if (!requireCurrentProfile('组织管理员尚未为该工作区创建 Uniopc 引擎 profile，暂时不能调整 Skill。')) return
    setSavingSkillName('__clear__')
    setError('')
    try {
      const updated = await engineClient.agents.setSkills({
        req: { profile: skillProfile, agentId: selectedEmployeeAgentId, skills: [] },
      })
      setSkillhubAgents(prev => prev.map(agent => (
        agent.id === updated.id ? updated : agent
      )))
    } catch (err) {
      setError(String(err?.message || err || '恢复全部 Skill 失败'))
      await loadEmployeeSkillhubSnapshot(skillProfile)
    } finally {
      setSavingSkillName('')
    }
  }

  async function toggleSelectedEmployeeSkill(skillName) {
    if (!selectedEmployee || !selectedEmployeeAgentId || !skillName || savingSkillName) return
    if (!requireCurrentProfile('组织管理员尚未为该工作区创建 Uniopc 引擎 profile，暂时不能分配 Skill。')) return

    const currentSkills = Array.isArray(selectedEmployeeSkillNames) ? selectedEmployeeSkillNames : []
    const hasSkill = currentSkills.includes(skillName)
    const skill = skillhubSkills.find(item => item.name === skillName)
    if (!hasSkill && skill && !isSkillAssignable(skill)) {
      setError('这个 Skill 当前不可用，请先处理依赖或启用后再分配。')
      return
    }
    // Going from "no allowlist" to "one entry" LOOKS additive but is the
    // opposite: the engine switches from "every eligible skill" to "only this
    // one". Say so before the employee silently loses everything else.
    if (!hasSkill && currentSkills.length === 0) {
      const confirmed = window.confirm(
        `「${displayEmployeeName(selectedEmployee)}」当前未限定 Skill，可以使用全部 Skill。\n\n` +
        `分配后将只保留你勾选的 Skill，其余全部停用。确定要限定吗？`,
      )
      if (!confirmed) return
    }

    const nextSkills = hasSkill
      ? currentSkills.filter(item => item !== skillName)
      : [...currentSkills, skillName]
    const fallbackAgent = {
      id: selectedEmployeeAgentId,
      name: selectedEmployee.name,
      role: selectedEmployee.role,
      isDefault: Boolean(selectedEmployee.isDefault),
      skills: nextSkills,
    }

    setSavingSkillName(skillName)
    setError('')
    setSkillhubAgents(prev => {
      const exists = prev.some(agent => agent.id === selectedEmployeeAgentId)
      if (!exists) return [...prev, fallbackAgent]
      return prev.map(agent => (
        agent.id === selectedEmployeeAgentId ? { ...agent, skills: nextSkills } : agent
      ))
    })

    try {
      const updated = await engineClient.agents.setSkills({
        req: {
          profile: skillProfile,
          agentId: selectedEmployeeAgentId,
          skills: nextSkills,
        },
      })
      setSkillhubAgents(prev => prev.map(agent => (
        agent.id === updated.id ? updated : agent
      )))
    } catch (err) {
      setError(String(err?.message || err || '保存 Skill 分配失败'))
      await loadEmployeeSkillhubSnapshot(skillProfile)
    } finally {
      setSavingSkillName('')
    }
  }

  async function loadEmployeeDocuments(employee = employeeDocsEmployee) {
    if (!employee?.id) return
    if (!requireCurrentProfile('组织管理员尚未为该工作区创建 Uniopc 引擎 profile，暂时不能读取员工文档。')) return
    setLoadingEmployeeDocuments(true)
    setError('')
    try {
      const rows = await engineClient.agents.listDocuments({
        agentId: employee.id,
        profile: currentProfile,
      })
      const items = Array.isArray(rows) ? rows : []
      setEmployeeDocuments(items)
      setSelectedEmployeeDocPath(prev =>
        prev && items.some(item => item.relativePath === prev) ? prev : items[0]?.relativePath || '',
      )
    } catch (err) {
      setEmployeeDocuments([])
      setSelectedEmployeeDocPath('')
      setError(String(err?.message || err || '读取员工文档失败'))
    } finally {
      setLoadingEmployeeDocuments(false)
    }
  }

  async function loadEmployeeDocument(relativePath, employee = employeeDocsEmployee) {
    if (!employee?.id || !relativePath) return
    if (!requireCurrentProfile('组织管理员尚未为该工作区创建 Uniopc 引擎 profile，暂时不能读取员工文档。')) return
    setLoadingEmployeeDocument(true)
    setError('')
    try {
      const detail = await engineClient.agents.getDocument({
        agentId: employee.id,
        relativePath,
        profile: currentProfile,
      })
      setEmployeeDocumentDetail(detail)
      setEmployeeDocumentValue(detail?.content || '')
      setEditingEmployeeDocument(false)
    } catch (err) {
      setEmployeeDocumentDetail(null)
      setEmployeeDocumentValue('')
      setEditingEmployeeDocument(false)
      setError(String(err?.message || err || '读取员工文档失败'))
    } finally {
      setLoadingEmployeeDocument(false)
    }
  }

  function startEmployeeDocumentEditing() {
    if (!employeeDocumentDetail) return
    setEmployeeDocumentValue(employeeDocumentDetail.content || '')
    setEditingEmployeeDocument(true)
  }

  function cancelEmployeeDocumentEditing() {
    setEmployeeDocumentValue(employeeDocumentDetail?.content || '')
    setEditingEmployeeDocument(false)
  }

  async function saveEmployeeDocument() {
    if (!employeeDocsEmployee?.id || !employeeDocumentDetail?.relativePath) return
    if (!requireCurrentProfile('组织管理员尚未为该工作区创建 Uniopc 引擎 profile，暂时不能保存员工文档。')) return

    setSavingEmployeeDocument(true)
    setError('')
    try {
      const detail = await engineClient.agents.saveDocument({
        agentId: employeeDocsEmployee.id,
        profile: currentProfile,
        input: {
          relativePath: employeeDocumentDetail.relativePath,
          content: employeeDocumentValue,
        },
      })
      setEmployeeDocumentDetail(detail)
      setEmployeeDocumentValue(detail?.content || '')
      setEditingEmployeeDocument(false)
      await loadEmployeeDocuments(employeeDocsEmployee)
    } catch (err) {
      setError(String(err?.message || err || '保存员工文档失败'))
    } finally {
      setSavingEmployeeDocument(false)
    }
  }

  useEffect(() => {
    if ((modalOpen || connectModalOpen) && editing && form.id) {
      syncFeishuFormForEmployee(form.id, feishuOverview)
      const boundWechatAccount = getEmployeeWechatAccount(form.id, wechatOverview)
      if (boundWechatAccount || !wechatForm.accountId) {
        syncWechatFormForEmployee(form.id, wechatOverview)
      }
    }
  }, [feishuOverview, wechatOverview, modalOpen, connectModalOpen, editing, form.id, wechatForm.accountId])

  useEffect(() => {
    if (!employeeDocsOpen || !employeeDocsEmployee?.id) return
    loadEmployeeDocuments(employeeDocsEmployee)
  }, [employeeDocsOpen, employeeDocsEmployee?.id, currentProfile])

  useEffect(() => {
    if (!employeeDocsOpen || !employeeDocsEmployee?.id || !selectedEmployeeDocPath) {
      setEmployeeDocumentDetail(null)
      setEmployeeDocumentValue('')
      setEditingEmployeeDocument(false)
      return
    }
    loadEmployeeDocument(selectedEmployeeDocPath, employeeDocsEmployee)
  }, [employeeDocsEmployee, employeeDocsOpen, selectedEmployeeDocPath, currentProfile])

  async function saveEmployee(event) {
    event.preventDefault()
    if (!form.name.trim() || !form.role.trim()) return
    if (!currentProfile) {
      setError('组织管理员尚未为你创建 Uniopc 引擎 profile，暂时不能保存 AI 员工。')
      return
    }
    const explicitModelOverride = String(form.model || '').trim()

    setSaving(true)
    setError('')
    setNotice('')
    try {
      let savedEmployee
      if (useCloudEmployeeDirectory && !editing) {
        await requestCloudAiEmployeeCreation(supabase, user.uid, {
          name: form.name.trim(),
          role: form.role.trim(),
          description: form.description.trim(),
          emoji: form.emoji.trim(),
          model: explicitModelOverride || null,
        })
        await loadEmployeeRequests()
        closeModal()
        setNotice('AI 员工创建申请已提交，Owner/Admin 批准后会出现在列表里。')
        return
      }

      if (editing) {
        savedEmployee = await engineClient.agents.update({
          req: {
            id: form.id,
            name: form.name.trim(),
            role: form.role.trim(),
            description: form.description.trim(),
            emoji: form.emoji.trim(),
            model: explicitModelOverride || null,
            profile: currentProfile,
            thinkingDefault: form.thinkingDefault ?? '',
          },
        })

      } else {
        const template = roleTemplates.find(item => item.id === selectedTemplateId) || null
        savedEmployee = await engineClient.agents.create({
          req: {
            name: form.name.trim(),
            role: form.role.trim(),
            description: form.description.trim(),
            emoji: form.emoji.trim(),
            model: null,
            profile: currentProfile,
            soulMd: template?.soulMd || null,
            agentsMd: template?.agentsMd || null,
          },
        })

        // 软绑定角色默认技能:模板技能都是全局插件技能,员工创建后本就可用;
        // 引擎侧 per-agent 绑定(agents.update skills)在部分运行时版本不支持,
        // 失败只提示、不影响创建结果。
        if (savedEmployee?.id && template?.defaultSkillIds?.length) {
          try {
            await engineClient.agents.setSkills({
              req: {
                agentId: savedEmployee.id,
                profile: currentProfile,
                skills: template.defaultSkillIds,
              },
            })
          } catch {
            setNotice('员工已创建。角色默认技能已全局可用，按员工单独绑定暂不受当前引擎版本支持。')
          }
        }
      }

      if (savedEmployee?.id) {
        setEmployees(prev => {
          const next = mergeEmployeeList(prev, savedEmployee)
          const ordered = orderEmployeesForChat(next)
          primeLocalEmployeesCache(ordered, currentProfile)
          return ordered
        })
        setSelectedEmployeeId(savedEmployee.id)
      } else {
        invalidateLocalEmployeesCache(currentProfile)
      }
      closeModal()
      if (editing) {
        loadEmployees(true).catch(() => null)
      }
    } catch (err) {
      setError(String(err?.message || err || '保存 AI 员工失败'))
    } finally {
      setSaving(false)
    }
  }

  async function deleteEmployee(employee) {
    if (!requireCurrentProfile('组织管理员尚未为该工作区创建 Uniopc 引擎 profile，暂时不能删除 AI 员工。')) return
    const confirmed = window.confirm(`确定要删除 AI 员工「${displayEmployeeName(employee)}」吗？`)
    if (!confirmed) return

    setDeletingId(employee.id)
    setError('')
    try {
      await engineClient.agents.delete({ id: employee.id, profile: currentProfile })
      invalidateLocalEmployeesCache(currentProfile)
      await loadEmployees(true)
    } catch (err) {
      setError(String(err?.message || err || '删除 AI 员工失败'))
    } finally {
      setDeletingId('')
    }
  }

  async function saveAndBindFeishu() {
    if (!editing || !form.id) return

    const accountId = feishuForm.accountId.trim() || 'default'
    const hasExistingAccount = Boolean(
      feishuOverview?.accounts?.some(account => account.accountId === accountId),
    )
    const shouldSaveAccount =
      !hasExistingAccount || Boolean(feishuForm.appId.trim() || feishuForm.appSecret.trim())

    setSavingFeishu(true)
    setError('')
    try {
      let nextOverview = feishuOverview

      if (shouldSaveAccount) {
        if (!feishuForm.appId.trim()) {
          throw new Error('先填写 Feishu App ID，或者选择一个已存在的连接。')
        }

        nextOverview = await engineClient.agents.saveFeishuAccount({
          req: {
            accountId,
            domain: feishuForm.domain,
            appId: feishuForm.appId.trim(),
            appSecret: feishuForm.appSecret.trim(),
          },
        })
      }

      nextOverview = await engineClient.agents.bindFeishu({
        accountId,
        employeeId: form.id,
      })
      setFeishuOverview(nextOverview)
      syncFeishuFormForEmployee(form.id, nextOverview)
    } catch (err) {
      setError(String(err?.message || err || '开通 Feishu 连接失败'))
    } finally {
      setSavingFeishu(false)
    }
  }

  async function unbindFeishu() {
    if (!editing || !form.id) return

    const currentAccount = getEmployeeFeishuAccount(form.id)
    if (!currentAccount) return

    setBindingFeishu(true)
    setError('')
    try {
      const nextOverview = await engineClient.agents.unbindFeishu({
        accountId: currentAccount.accountId,
        employeeId: form.id,
      })
      setFeishuOverview(nextOverview)
      syncFeishuFormForEmployee(form.id, nextOverview)
    } catch (err) {
      setError(String(err?.message || err || '关闭 Feishu 连接失败'))
    } finally {
      setBindingFeishu(false)
    }
  }

  async function installWechatPlugin() {
    setInstallingWechat(true)
    setError('')
    try {
      const overview = await engineClient.agents.installWechatPlugin()
      setWechatOverview(overview)
      syncWechatFormForEmployee(form.id, overview)
    } catch (err) {
      setError(String(err?.message || err || '安装微信渠道插件失败'))
    } finally {
      setInstallingWechat(false)
    }
  }

  async function startWechatQrLogin(force = false) {
    setStartingWechatQr(true)
    setError('')
    try {
      const result = await engineClient.agents.startWechatQr({
        req: {
          accountId: wechatForm.accountId?.trim() || 'default',
          force,
        },
      })
      setWechatQrSession({
        accountId: result.accountId || wechatForm.accountId?.trim() || 'default',
        sessionKey: result.sessionKey || result.accountId || wechatForm.accountId?.trim() || 'default',
        qrDataUrl: result.qrDataUrl || '',
        message:
          result.message ||
          (result.qrDataUrl ? '二维码已生成，请使用微信扫码。' : '暂时还没拿到二维码，请稍后重试。'),
        connected: false,
      })
      setWechatForm({
        accountId: result.accountId || wechatForm.accountId?.trim() || 'default',
      })
      if (!result.qrDataUrl) {
        setError(result.message || '暂时还没拿到微信二维码，请点“刷新二维码”再试一次。')
      }
    } catch (err) {
      const message = String(err?.message || err || '生成微信二维码失败')
      const accountId = wechatForm.accountId?.trim() || 'default'
      setWechatQrSession({
        accountId,
        sessionKey: accountId,
        qrDataUrl: '',
        message,
        connected: false,
      })
      setError(message)
    } finally {
      setStartingWechatQr(false)
    }
  }

  async function checkWechatQrNow() {
    if (!wechatQrSession?.accountId) return

    setCheckingWechatQr(true)
    setError('')
    try {
      const result = await engineClient.agents.waitWechatQr({
        req: {
          accountId: wechatQrSession.accountId,
          timeoutMs: 1000,
        },
      })
      setWechatQrSession(prev =>
        prev
          ? {
              ...prev,
              accountId: result.accountId || prev.accountId,
              sessionKey: result.sessionKey || prev.sessionKey,
              qrDataUrl: result.qrDataUrl || prev.qrDataUrl,
              message: result.message || prev.message,
              connected: Boolean(result.connected),
            }
          : prev,
      )
      if (result.connected) {
        await loadWechatOverview()
        setWechatForm({
          accountId: result.accountId || wechatQrSession.accountId,
        })
      }
    } catch (err) {
      setError(String(err?.message || err || '检查微信扫码状态失败'))
    } finally {
      setCheckingWechatQr(false)
    }
  }

  async function bindWechat() {
    if (!editing || !form.id) return

    const accountId = wechatForm.accountId.trim()
    if (!accountId) {
      setError('请先扫码登录微信，拿到真实账号后再绑定。')
      return
    }
    setBindingWechat(true)
    setError('')
    try {
      await engineClient.agents.bindChannel({
        req: {
          channelId: 'openclaw-weixin',
          accountId,
          employeeId: form.id,
        },
      })
      await loadWechatOverview()
    } catch (err) {
      setError(String(err?.message || err || '绑定微信账号失败'))
    } finally {
      setBindingWechat(false)
    }
  }

  async function unbindWechat() {
    if (!editing || !form.id) return

    const currentAccount = getEmployeeWechatAccount(form.id)
    if (!currentAccount) return

    setBindingWechat(true)
    setError('')
    try {
      await engineClient.agents.unbindChannel({
        req: {
          channelId: 'openclaw-weixin',
          accountId: currentAccount.accountId,
          employeeId: form.id,
        },
      })
      await loadWechatOverview()
    } catch (err) {
      setError(String(err?.message || err || '解绑微信账号失败'))
    } finally {
      setBindingWechat(false)
    }
  }

  async function approvePairingRequest(request) {
    if (!request?.code) return
    setApprovingPairingCode(request.code)
    setError('')
    try {
      const result = await engineClient.agents.approveChannelPairing({
        req: {
          channelId: request.channelId,
          code: request.code,
          accountId: request.accountId,
        },
      })
      setNotice(result?.message || '已批准配对请求。')
      await loadPairingRequests()
    } catch (err) {
      setError(String(err?.message || err || '批准配对请求失败'))
      await loadPairingRequests()
    } finally {
      setApprovingPairingCode('')
    }
  }

  async function updateChannelPolicy(channelId, accountId, patch) {
    setSavingChannelPolicy(true)
    setError('')
    try {
      const result = await engineClient.agents.setChannelPolicy({
        req: { channelId, accountId, ...patch },
      })
      setNotice(result?.message || '准入策略已更新。')
      if (channelId === 'feishu') {
        await loadFeishuOverview()
      } else {
        await loadWechatOverview()
      }
    } catch (err) {
      setError(String(err?.message || err || '更新准入策略失败'))
    } finally {
      setSavingChannelPolicy(false)
    }
  }

  async function openExternalUrl(url) {
    try {
      await invoke('openclaw_open_external_url', { url })
    } catch (err) {
      setError(String(err?.message || err || '打开外部链接失败'))
    }
  }

  return (
    <div className="mx-auto h-full min-h-0 max-w-[1520px] overflow-hidden">
      <section className="grid h-full min-h-0 overflow-hidden bg-transparent p-0 lg:grid-cols-[300px_1px_minmax(0,1fr)]">
        <EmployeeDirectoryPane
          employees={employees}
          roster={employees.map(employee => ({
            type: 'employee',
            id: employee.id,
            employee,
            unreadCount: pairingByEmployeeId.get(employee.id)?.length || 0,
          }))}
          selectedEmployeeId={selectedEmployeeId}
          loading={loading}
          onSelect={selectEmployee}
          onCreate={openCreateModal}
          onOpenChat={employeeId => navigate(conversationsPath(`agent=${employeeId}`), { state: profileWorkspaceState })}
          emptyDescription={currentProject ? `当前项目「${currentProject.name}」还没有 AI 员工。` : '先创建一个属于当前 profile 的 AI 员工。'}
          addLabel={canManageAiEmployees ? '+ 新增员工' : '申请创建'}
          error={error}
          notice={notice}
          requests={visibleEmployeeRequests}
          canManage={canManageAiEmployees}
          requestActionId={requestActionId}
          onApproveRequest={approveEmployeeRequest}
        />

        <div className="hidden bg-subtle lg:block" />

        <EmployeeDetailPane
          employee={selectedEmployee}
          detailTab={employeeDetailTab}
          onDetailTabChange={setEmployeeDetailTab}
          onEdit={openEditModal}
          onDelete={deleteEmployee}
          onOpenConnections={openConnectModal}
          onOpenDocuments={openEmployeeDocs}
          onCreate={openCreateModal}
          notice={notice}
          error={error}
          canManage={canManageAiEmployees}
          deletingId={deletingId}
          detailTabs={employeeDetailTabs}
          currentModelRef={currentModelRef}
          currentProfile={currentProfile}
          currentProjectName={currentProject?.name}
          channelLabels={selectedChannelLabels}
          workspacePath={selectedWorkspacePath}
          agentDir={selectedAgentDir}
          routes={selectedRoutes}
          bindingsCount={selectedBindingsCount}
          skillQuery={skillQuery}
          onSkillQueryChange={setSkillQuery}
          skillsRestricted={selectedEmployeeSkillsRestricted}
          skillNames={selectedEmployeeSkillNames}
          availableSkillCount={selectedAvailableSkillCount}
          unavailableSkillCount={selectedUnavailableSkillCount}
          loadingSkills={loadingSkillhub}
          savingSkillName={savingSkillName}
          allSkills={skillhubSkills}
          filteredSkills={filteredEmployeeSkills}
          visibleSkills={visibleEmployeeSkills}
          skillListMode={skillListMode}
          onSkillListModeChange={setSkillListMode}
          onClearSkillRestriction={clearSelectedEmployeeSkillRestriction}
          onRefreshSkills={() => loadEmployeeSkillhubSnapshot(skillProfile)}
          onToggleSkill={toggleSelectedEmployeeSkill}
          pairingRequests={selectedPairingRequests}
          approvingPairingCode={approvingPairingCode}
          onRefreshPairing={loadPairingRequests}
          onApprovePairing={approvePairingRequest}
          feishuAccount={selectedFeishuAccount}
          wechatAccount={selectedWechatAccount}
          savingChannelPolicy={savingChannelPolicy}
          onUpdateChannelPolicy={updateChannelPolicy}
        />
      </section>

      <Modal
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        size="xl"
        title="创建逻辑"
        description="这里不再占页面空间，只在需要时快速查看。"
      >
        <div className="space-y-3 text-sm leading-7 text-secondary">
          <p>1. 每位员工底层都对应一个独立的 Uniopc 引擎 agent。</p>
          <p>2. 系统会为员工创建独立 workspace，并写入 `IDENTITY.md` 和 `AGENTS.md`。</p>
          <p>3. 对话页左侧会展示所有员工，点谁就和谁聊。</p>
        </div>

        <div className="mt-5 rounded-2xl border border-subtle bg-surface-sunken p-4">
          <div className="text-xs uppercase tracking-[0.16em] text-tertiary">当前默认模型</div>
          <div className="mt-2 text-base font-medium text-primary">
            {formatModelLabel(currentModelRef)}
          </div>
        </div>
      </Modal>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        size="xl"
        title={editing ? '编辑 AI 员工' : canManageAiEmployees ? '新建 AI 员工' : '申请创建 AI 员工'}
        description={canManageAiEmployees ? '先定义这个员工是谁、负责什么。模型默认跟随当前 Uniopc 引擎 Profile。' : '这会提交到组织申请队列，不会直接修改 Owner 电脑上的 Uniopc 引擎。'}
        // 定高:选中角色展开详情时高度不变,内容在 body 内滚动,避免弹窗一高一矮。
        panelClassName="h-[min(720px,calc(100vh-4rem))]"
        bodyClassName="pt-4"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button type="button" onClick={closeModal} className={ACTION.secondary}>
              取消
            </button>
            <button
              type="submit"
              form={EMPLOYEE_FORM_ID}
              disabled={saving || !form.name.trim()}
              className={ACTION.primary}
            >
              {saving ? '保存中...' : editing ? '保存修改' : canManageAiEmployees ? '创建员工' : '提交申请'}
            </button>
          </div>
        }
      >
        <form id={EMPLOYEE_FORM_ID} onSubmit={saveEmployee} className="grid gap-4 md:grid-cols-2">
              {!editing && roleTemplates.length > 0 && (
                <div className="md:col-span-2">
                  <div className="mb-2 text-sm font-medium text-secondary">选择角色</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => applyRoleTemplate(null)}
                      className={`rounded-2xl border px-4 py-3 text-left transition-colors ${
                        !selectedTemplateId
                          ? 'border-violet-400/28 bg-violet-400/12'
                          : 'border-subtle bg-surface-raised hover:bg-state-hover'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-overlay text-2xl">✏️</span>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-primary">自定义</div>
                          <div className="mt-1 text-xs leading-5 text-secondary">
                            不用模板，自己定义这个员工的角色和职责。
                          </div>
                        </div>
                      </div>
                    </button>
                    {roleTemplates.map(template => (
                      <button
                        key={template.id}
                        type="button"
                        onClick={() => applyRoleTemplate(template)}
                        className={`rounded-2xl border px-4 py-3 text-left transition-colors ${
                          selectedTemplateId === template.id
                            ? 'border-violet-400/28 bg-violet-400/12'
                            : 'border-subtle bg-surface-raised hover:bg-state-hover'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <EmployeeAvatar kind="ai" name={template.name} emoji={template.emoji} size="lg" />
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-primary">{template.name}</div>
                            <div className="mt-1 line-clamp-2 text-xs leading-5 text-secondary">
                              {template.description || '官方角色模板'}
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                  <div className="mt-1.5 text-xs leading-5 text-tertiary">
                    选择角色会预填人设与职责，创建后自动绑定该角色的默认技能；内容仍可修改。
                  </div>
                </div>
              )}

              {/* 头像圆徽 + 名称 + 角色并排一行:省高度,也更贴"人"的隐喻。 */}
              <div className="md:col-span-2 flex items-end gap-3">
                <label className="block shrink-0">
                  <div className="mb-2 text-sm font-medium text-secondary">头像</div>
                  <div className="flex items-center gap-2">
                    {/* 预览就是真实渲染：留空时看到的正是这位员工实际会长的样子 */}
                    <EmployeeAvatar kind="ai" name={form.name} emoji={form.emoji} size="lg" />
                    <input
                      value={form.emoji}
                      onChange={event => setForm(prev => ({ ...prev, emoji: event.target.value }))}
                      placeholder="🤖"
                      className={`${SURFACE.input} w-16 text-center`}
                    />
                  </div>
                </label>
                <label className="block min-w-0 flex-1">
                  <div className="mb-2 text-sm font-medium text-secondary">员工名称</div>
                  <input
                    value={form.name}
                    onChange={event => setForm(prev => ({ ...prev, name: event.target.value }))}
                    placeholder="例如：客服小云"
                    className={SURFACE.input}
                  />
                </label>
                <label className="block min-w-0 flex-1">
                  <div className="mb-2 text-sm font-medium text-secondary">角色</div>
                  <input
                    value={form.role}
                    onChange={event => setForm(prev => ({ ...prev, role: event.target.value }))}
                    placeholder="例如：客服员工"
                    className={SURFACE.input}
                  />
                </label>
              </div>

              <label className="block md:col-span-2">
                <div className="mb-2 text-sm font-medium text-secondary">职责说明</div>
                <textarea
                  rows={3}
                  value={form.description}
                  onChange={event => setForm(prev => ({ ...prev, description: event.target.value }))}
                  placeholder="写清楚它主要负责什么、怎么回答、为谁服务。"
                  className={SURFACE.textarea}
                />
              </label>

              {/* 角色详情放在员工信息之后:先知道对象,再看属性。 */}
              {!editing && (() => {
                const detail = roleTemplates.find(item => item.id === selectedTemplateId)
                if (!detail) return null
                const hasDetail = detail.capabilities?.length || detail.styleTags?.length || detail.workModes?.length
                if (!hasDetail) return null
                return (
                  <div className="md:col-span-2 rounded-2xl border border-violet-400/20 bg-violet-400/[0.06] p-4">
                    {detail.capabilities?.length > 0 && (
                      <div>
                        <div className="text-xs uppercase tracking-[0.16em] text-tertiary">
                          核心能力（{detail.capabilities.length}）
                        </div>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          {detail.capabilities.map((cap, index) => (
                            <div key={index} className="rounded-xl border border-subtle bg-surface-sunken px-3 py-2.5">
                              <div className="text-sm font-medium text-primary">
                                {cap.emoji ? `${cap.emoji} ` : ''}{cap.title}
                              </div>
                              {cap.description && (
                                <div className="mt-1 text-xs leading-5 text-secondary">{cap.description}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {detail.styleTags?.length > 0 && (
                      <div className="mt-3">
                        <div className="text-xs uppercase tracking-[0.16em] text-tertiary">工作风格</div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {detail.styleTags.map(tag => (
                            <span key={tag} className="rounded-full border border-default bg-surface-raised px-3 py-1 text-xs text-secondary">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {detail.workModes?.length > 0 && (
                      <div className="mt-3">
                        <div className="text-xs uppercase tracking-[0.16em] text-tertiary">工作模式</div>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          {detail.workModes.map((mode, index) => (
                            <div key={index} className="rounded-xl border border-subtle bg-surface-sunken px-3 py-2.5">
                              <div className="text-sm font-medium text-primary">{mode.title}</div>
                              {Array.isArray(mode.steps) && mode.steps.length > 0 && (
                                <div className="mt-1 text-xs leading-5 text-secondary">
                                  {mode.steps.join(' → ')}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })()}

              {editing && (
                <label className="block md:col-span-2">
                  <div className="mb-2 text-sm font-medium text-secondary">思考强度</div>
                  <select
                    value={form.thinkingDefault}
                    onChange={event => setForm(prev => ({ ...prev, thinkingDefault: event.target.value }))}
                    className={SURFACE.select}
                  >
                    {EMPLOYEE_THINKING_CHOICES.map(choice => (
                      <option key={choice.id} value={choice.id}>{choice.label}</option>
                    ))}
                  </select>
                  <div className="mt-1.5 text-xs leading-5 text-tertiary">
                    开启后这位员工会先思考再回答：更深入，但更慢、消耗更多额度。适合分析、写作类员工。
                  </div>
                </label>
              )}
            </form>
      </Modal>

      {(employeeDocsOpen || connectModalOpen) && (
        <EmployeeConnectionsDialog
          employee={form}
          open={connectModalOpen}
          onClose={closeConnectModal}
          feishuAccount={getEmployeeFeishuAccount(form.id)}
          wechatAccount={getEmployeeWechatAccount(form.id)}
          selectedChannelKind={selectedChannelKind}
          onChannelKindChange={changeSelectedChannelKind}
          feishuOverview={feishuOverview}
          feishuForm={feishuForm}
          onFeishuAccountChange={changeFeishuAccount}
          onFeishuFormChange={patch => setFeishuForm(prev => ({ ...prev, ...patch }))}
          savingFeishu={savingFeishu}
          loadingFeishu={loadingFeishu}
          bindingFeishu={bindingFeishu}
          onSaveFeishu={saveAndBindFeishu}
          onUnbindFeishu={unbindFeishu}
          wechatOverview={wechatOverview}
          configuredWechatAccounts={configuredWechatAccounts}
          wechatForm={wechatForm}
          onWechatAccountChange={changeWechatAccount}
          wechatQrSession={wechatQrSession}
          loadingWechat={loadingWechat}
          installingWechat={installingWechat}
          bindingWechat={bindingWechat}
          startingWechatQr={startingWechatQr}
          checkingWechatQr={checkingWechatQr}
          onInstallWechat={installWechatPlugin}
          onRefreshWechatQr={refreshWechatQr}
          onCheckWechatQr={checkWechatQrNow}
          onRefreshWechat={loadWechatOverview}
          onBindWechat={bindWechat}
          onUnbindWechat={unbindWechat}
          onOpenExternalUrl={openExternalUrl}
          documentsOpen={employeeDocsOpen}
          onCloseDocuments={closeEmployeeDocs}
          documentsEmployee={employeeDocsEmployee}
          documents={employeeDocuments}
          loadingDocuments={loadingEmployeeDocuments}
          selectedDocumentPath={selectedEmployeeDocPath}
          onSelectDocument={setSelectedEmployeeDocPath}
          documentDetail={employeeDocumentDetail}
          loadingDocument={loadingEmployeeDocument}
          editingDocument={editingEmployeeDocument}
          documentValue={employeeDocumentValue}
          onDocumentValueChange={setEmployeeDocumentValue}
          renderedDocument={renderedEmployeeDoc}
          isDocumentDirty={isEmployeeDocDirty}
          savingDocument={savingEmployeeDocument}
          onStartDocumentEditing={startEmployeeDocumentEditing}
          onCancelDocumentEditing={cancelEmployeeDocumentEditing}
          onSaveDocument={saveEmployeeDocument}
        />
      )}
    </div>
  )
}
