import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import { useAuth } from '../hooks/useAuth'
import { engineClient } from '../lib/engine/client.js'
import { ACTION } from '../lib/theme'
import {
  fetchTrustedPluginCatalog,
  normalizeTrustedServiceError,
  supabase,
  trustedCatalogRowsForCurrentResponse,
} from '../lib/supabase'
import { profileWorkspacePath } from '../lib/profileWorkspace'
import {
  beginCloudAgentCatalogRequest,
  commitCloudAgentCatalogRequest,
  currentCloudAgentRuntimeAuthEnv,
  invalidateCloudAgentCatalogRequests,
  isCloudAgentPluginId,
  replaceCloudAgentPluginCatalog,
} from '../lib/cloudWorkspacePluginAuth'
import {
  buildMemberOpenClawProfileKey,
  createMemberOpenClawProfile,
  getMyWorkspacePluginPolicyBootstrap,
  listCloudOrganizationMembers,
  listMyOrganizationPluginEntitlements,
  normalizeCloudPluginCatalogRows,
} from '../lib/cloudWorkspace'
import {
  checkProfilePluginConsistency,
  reconcileProfilePluginConsistency,
  subscribeWorkspacePolicyVersion,
} from '../lib/profilePluginConsistency'
import Operations from './Operations'
import ModelSettings from './ModelSettings'
import OpenClawRuntime from './OpenClawRuntime'

function roleLabel(role) {
  if (role === 'owner') return 'Owner'
  if (role === 'admin') return 'Admin'
  return 'Member'
}

function statusClass(status) {
  if (status === 'active' || status === 'registered' || status === 'online') return 'border-emerald-400/20 bg-emerald-400/10 text-success-text'
  if (status === 'degraded' || status === 'suspended') return 'border-amber-400/24 bg-amber-400/12 text-warning-text'
  return 'border-default bg-surface-raised text-secondary'
}

function statusGatewayStatus(status) {
  return status?.gatewayStatus || null
}

function statusProfileExists(status) {
  if (!status) return null
  if (typeof status.profileExists === 'boolean') return status.profileExists
  return null
}

function normalizeRuntimeMode(value = '') {
  return 'member_local'
}

function isMemberLocal(member = {}) {
  return normalizeRuntimeMode(member?.runtimeMode || member?.runtime_mode) === 'member_local'
}

function isManagedMemberProfile(member) {
  return member?.memberRole !== 'owner'
}

function userIdFromAuth(user = {}) {
  return String(user?.uid || user?.id || user?.userId || user?.user_id || '').trim()
}

function memberUserId(member = {}) {
  return String(member?.userId || member?.user_id || member?.member_user_id || '').trim()
}

function hasProfileWorkspaceEntry(member) {
  const profileStatus = member?.profileStatus || member?.profile_status
  return profileStatus === 'active' && Boolean(member?.openclawProfileId || member?.openclaw_profile_id)
}

function canEnterOwnProfileWorkspace(member, user) {
  const currentUserId = userIdFromAuth(user)
  return Boolean(hasProfileWorkspaceEntry(member) && currentUserId && memberUserId(member) === currentUserId)
}

function cleanText(value = '') {
  return String(value || '').trim()
}

function userDisplayName(user = {}, profile = {}) {
  return cleanText(profile?.nickname) ||
    cleanText(user?.displayName) ||
    cleanText(user?.user_metadata?.display_name) ||
    cleanText(user?.email) ||
    '当前用户'
}

function userEmail(user = {}, profile = {}) {
  return cleanText(user?.email) || cleanText(profile?.email) || cleanText(user?.phone) || cleanText(profile?.phone)
}

function buildCurrentWorkspaceMember({ user = {}, profile = {}, workspaceProfile = {} } = {}) {
  const memberId = workspaceProfile?.memberId || workspaceProfile?.member_id || user?.uid || user?.id || 'me'
  const memberRole = workspaceProfile?.memberRole || workspaceProfile?.member_role || 'member'
  const profileStatus = workspaceProfile?.profileStatus || workspaceProfile?.profile_status || 'active'
  const runtimeMode = workspaceProfile?.runtimeMode || workspaceProfile?.runtime_mode || 'member_local'
  return {
    id: memberId,
    memberId,
    userId: user?.uid || user?.id || user?.userId || user?.user_id || '',
    memberRole,
    displayName: userDisplayName(user, profile),
    memberEmail: userEmail(user, profile),
    inviteStatus: 'registered',
    statusLabel: '已注册',
    profileStatus,
    openclawProfile: workspaceProfile?.openclawProfile || workspaceProfile?.openclaw_profile || '',
    openclawProfileId: workspaceProfile?.openclawProfileId || workspaceProfile?.openclaw_profile_id || '',
    runtimeMode,
    runtime_mode: runtimeMode,
    gatewayStatus: workspaceProfile?.gatewayStatus || workspaceProfile?.gateway_status || '',
    gatewayStatusMessage: workspaceProfile?.gatewayStatusMessage || workspaceProfile?.gateway_status_message || '',
    gatewayUrl: workspaceProfile?.gatewayUrl || workspaceProfile?.gateway_url || '',
    organizationName: workspaceProfile?.organizationName || workspaceProfile?.organization_name || '',
    isCurrentMember: true,
  }
}

function cloudProfileStatusLabel(member) {
  if (member?.profileStatus === 'active' && member?.openclawProfile) return '云端已登记'
  if (member?.profileStatus === 'suspended') return '云端已停用'
  return '云端未登记'
}

function localProfileStatusLabel(member, hostStatus) {
  if (!member?.openclawProfile) return '本机未创建'
  if (isMemberLocal(member)) {
    const gateway = statusGatewayStatus(hostStatus) || member.gatewayStatus
    if (gateway === 'online') return '成员本机运行'
    if (gateway === 'degraded') return '成员本机异常'
    return '等待成员本机准备'
  }
  const exists = statusProfileExists(hostStatus)
  const gateway = statusGatewayStatus(hostStatus) || member.gatewayStatus
  if (exists === false) return '本机未创建'
  if (gateway === 'online') return 'Owner 本机在线'
  if (gateway === 'degraded') return 'Owner 本机异常'
  if (exists === true) return '本机已创建，未上线'
  return 'Owner 本机待检测'
}

function isLocalProfileOnline(member, hostStatus) {
  const localGateway = statusGatewayStatus(hostStatus)
  if (localGateway) return localGateway === 'online'
  if (statusProfileExists(hostStatus) === false) return false
  return member?.gatewayStatus === 'online'
}

function profileActionLabel(member, active, checking, hostStatus = null) {
  if (checking) return '检测中'
  if (active) return member?.openclawProfile ? '启动中' : '创建中'
  if (!member?.openclawProfile) return '创建'
  if (isLocalProfileOnline(member, hostStatus)) return '已在线'
  if (statusProfileExists(hostStatus) === false) return '创建并启动'
  if (statusGatewayStatus(hostStatus) === 'degraded' || member.gatewayStatus === 'degraded') return '修复并启动'
  if (statusProfileExists(hostStatus) === true) return '启动'
  return '创建并启动'
}

function DetailRow({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="text-2xs text-tertiary">{label}</div>
      <div className="mt-1 truncate text-sm text-primary">{value || '-'}</div>
    </div>
  )
}

function EyeIcon({ hidden = false }) {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9.25A2.75 2.75 0 1 1 12 14.75 2.75 2.75 0 0 1 12 9.25Z" />
      {hidden && <path strokeLinecap="round" strokeLinejoin="round" d="M4 4l16 16" />}
    </svg>
  )
}

function ConnectionHero({ kind, title, description, latency }) {
  const icon = kind === 'remote' ? '⌘' : '▣'
  const accentClass = kind === 'remote'
    ? 'bg-orange-400/12 text-orange-100'
    : 'bg-emerald-400/12 text-success-text'
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-surface-raised px-4 py-4">
      <div className="flex min-w-0 items-center gap-4">
        <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-lg ${accentClass}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-base font-semibold text-primary">{title}</div>
          <div className="mt-1 text-xs leading-5 text-tertiary">{description}</div>
        </div>
      </div>
      {latency && (
        <span className="inline-flex shrink-0 items-center rounded-full bg-emerald-400/12 px-3 py-1 text-xs font-medium text-success-text">
          {latency}
        </span>
      )}
    </div>
  )
}

function ConnectionRunsRow({ value, helper }) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold text-tertiary">Gateway</div>
      <div className="flex flex-col gap-3 rounded-xl bg-surface-raised px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-base font-semibold text-primary">Uniopc 引擎 runs</div>
          <div className="mt-1 text-xs text-tertiary">Pick whether this app owns a local Gateway or attaches to another host.</div>
        </div>
        <div className="inline-flex h-9 min-w-[220px] items-center justify-between rounded-lg bg-surface-overlay px-3 text-sm text-primary">
          <span>{value}</span>
          <span aria-hidden="true" className="text-tertiary">⌄</span>
        </div>
      </div>
      {helper && <div className="mt-2 text-xs text-tertiary">{helper}</div>}
    </div>
  )
}


const ENVIRONMENT_DETAIL_SECTIONS = [
  { key: 'profile', label: 'Uniopc 引擎 Profile' },
  { key: 'local', label: '本机 Gateway' },
  { key: 'operations', label: '运行中心' },
  { key: 'models', label: '模型' },
  { key: 'version', label: '版本' },
]
const TEAM_DETAIL_SECTIONS = [
  { key: 'plugins', label: '插件管理' },
]
const DETAIL_SECTIONS = [...ENVIRONMENT_DETAIL_SECTIONS, ...TEAM_DETAIL_SECTIONS]
const MEMBER_DETAIL_SECTION_KEYS = new Set(DETAIL_SECTIONS.map(section => section.key))

function sectionFromSearch(search = '', sections = DETAIL_SECTIONS, fallback = 'profile') {
  const section = new URLSearchParams(search).get('section') || fallback
  const sectionKeys = new Set(sections.map(item => item.key))
  return MEMBER_DETAIL_SECTION_KEYS.has(section) && sectionKeys.has(section) ? section : fallback
}

function profileWorkspaceForMember(member = {}) {
  const state = profileWorkspaceStateForMember(member).profileWorkspace
  return {
    ...state,
    isAdminSession: true,
    activeProfile: state.targetOpenClawProfile,
    memberId: state.targetMemberId,
    userId: state.targetUserId,
    user_id: state.targetUserId,
    memberRole: state.targetMemberRole,
    openclawProfileId: state.targetOpenClawProfileId,
    openclawProfile: state.targetOpenClawProfile,
    runtimeMode: state.targetRuntimeMode,
    runtime_mode: state.targetRuntimeMode,
    gatewayPort: state.targetGatewayPort,
    gateway_port: state.targetGatewayPort,
    displayName: state.targetDisplayName,
  }
}

function profileWorkspaceStateForMember(member = {}) {
  return {
    profileWorkspace: {
      targetMemberId: member.memberId || member.member_id || '',
      targetUserId: member.userId || member.user_id || member.member_user_id || '',
      targetMemberRole: member.memberRole || member.member_role || '',
      targetOpenClawProfileId: member.openclawProfileId || member.openclaw_profile_id || '',
      targetOpenClawProfile: member.openclawProfile || member.openclaw_profile || '',
      targetRuntimeMode: normalizeRuntimeMode(member.runtimeMode || member.runtime_mode),
      targetGatewayPort: member.gatewayPort || member.gateway_port || null,
      targetDisplayName: member.displayName || member.display_name || member.memberEmail || member.member_email || '',
    },
  }
}

function profilePluginStatusLabel(plugin) {
  const isCloudAgentPlugin = isCloudAgentPluginId(plugin?.id)
  if (plugin?.status === 'ready') return '可用'
  if (plugin?.status === 'missing_env') return isCloudAgentPlugin ? '未配置' : '配置缺失'
  if (plugin?.status === 'bridge_disabled') return '未配置'
  if (plugin?.status === 'not_installed') return '未安装'
  if (plugin?.enabled) return '已开启'
  return '未开启'
}

function profilePluginStatusClass(plugin) {
  if (plugin?.status === 'ready') return 'border-emerald-400/20 bg-emerald-400/10 text-success-text'
  if (plugin?.status === 'missing_env' || plugin?.status === 'bridge_disabled') return 'border-amber-400/24 bg-amber-400/12 text-warning-text'
  return 'border-default bg-surface-raised text-secondary'
}

function profilePluginActionLabel(plugin, { busy = false } = {}) {
  if (busy) return '更新中...'
  if (!plugin?.installed) return '安装并启用'
  if (plugin?.status === 'missing_env' || plugin?.status === 'bridge_disabled') return '配置并启用'
  if (plugin?.enabled) return '关闭'
  return '启用'
}

function isFoundationProfilePlugin(plugin = {}) {
  return plugin.id === 'uniopc-cloud-workspace'
}

function entitlementIsGlobal(entitlement = {}) {
  const metadata = entitlement?.metadata && typeof entitlement.metadata === 'object' ? entitlement.metadata : {}
  return entitlement?.isGlobal === true ||
    entitlement?.is_global === true ||
    metadata.global_plugin === true ||
    metadata.default_entitlement === true
}

export default function AdminMemberDetail({ selfOnly = false }) {
  const { memberId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { user, profile } = useAuth()
  const workspace = useActiveOpenClawProfile()
  const [member, setMember] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creatingProfile, setCreatingProfile] = useState(false)
  const [checkingProfile, setCheckingProfile] = useState(false)
  const [hostStatus, setHostStatus] = useState(null)
  const [notice, setNotice] = useState('')
  const [memberDetailSection, setMemberDetailSection] = useState(() => sectionFromSearch(location.search, selfOnly ? ENVIRONMENT_DETAIL_SECTIONS : TEAM_DETAIL_SECTIONS, selfOnly ? 'profile' : 'plugins'))
  const [profilePlugins, setProfilePlugins] = useState([])
  const [organizationPluginEntitlements, setOrganizationPluginEntitlements] = useState([])
  const [loadingPlugins, setLoadingPlugins] = useState(false)
  const [pluginActionId, setPluginActionId] = useState('')
  const [pluginPolicyBootstrap, setPluginPolicyBootstrap] = useState(null)
  const [pluginDoctorReport, setPluginDoctorReport] = useState(null)
  const [checkingPluginConsistency, setCheckingPluginConsistency] = useState(false)
  const [reconcilingPluginConsistency, setReconcilingPluginConsistency] = useState(false)
  const [lastAppliedPluginPolicyVersion, setLastAppliedPluginPolicyVersion] = useState(0)
  const catalogRequestScope = JSON.stringify([
    String(user?.uid || ''),
    String(memberId || ''),
    String(member?.openclawProfile || ''),
  ])
  const catalogRequestScopeRef = useRef(catalogRequestScope)
  catalogRequestScopeRef.current = catalogRequestScope
  const canManagePlugins = workspace.isAdmin && !selfOnly
  const ownerLocalProfile = Boolean(member && !isManagedMemberProfile(member))
  const memberLocalRuntime = isMemberLocal(member)
  const detailSections = selfOnly ? ENVIRONMENT_DETAIL_SECTIONS : TEAM_DETAIL_SECTIONS
  const defaultDetailSection = selfOnly ? 'profile' : 'plugins'
  const shouldShowDetailTabs = selfOnly && detailSections.length > 1
  const entitlementByPluginId = new Map(
    organizationPluginEntitlements
      .filter(item => item?.pluginId)
      .map(item => [item.pluginId, item]),
  )
  const localPluginById = new Map(
    profilePlugins
      .filter(plugin => plugin?.id)
      .map(plugin => [plugin.id, plugin]),
  )
  const authorizedProfilePlugins = organizationPluginEntitlements
    .filter(entitlement => entitlement?.pluginId && String(entitlement.status || 'active') === 'active')
    .map(entitlement => {
      const localPlugin = localPluginById.get(entitlement.pluginId)
      if (localPlugin) return localPlugin
      return {
        id: entitlement.pluginId,
        title: entitlement.pluginName || entitlement.pluginId,
        description: entitlement.pluginDescription || entitlement.pluginId,
        enabled: false,
        installed: false,
        status: 'not_installed',
      }
    })
  const visibleProfilePlugins = authorizedProfilePlugins.filter(plugin => canEnableProfilePlugin(plugin))

  useEffect(() => {
    if (!user?.uid || !workspace.workspaceProfile) {
      setLoading(false)
      return
    }
    loadMember()
  }, [user?.uid, workspace.workspaceProfile, workspace.isAdmin, memberId])

  useEffect(() => {
    setMemberDetailSection(sectionFromSearch(location.search, detailSections, defaultDetailSection))
  }, [location.search, selfOnly])

  useEffect(() => {
    invalidateCloudAgentCatalogRequests()
    setReconcilingPluginConsistency(false)
    return () => {
      invalidateCloudAgentCatalogRequests()
    }
  }, [catalogRequestScope])

  useEffect(() => {
    if (selfOnly && memberDetailSection === 'plugins') {
      selectMemberDetailSection('profile')
    }
  }, [selfOnly, memberDetailSection])

  useEffect(() => {
    const organizationId = workspace.workspaceProfile?.organizationId
    if (!canManagePlugins || !organizationId || !member?.openclawProfile) return undefined
    return subscribeWorkspacePolicyVersion(supabase, organizationId, () => {
      loadPluginPolicyBootstrap(member)
        .then(bootstrap => checkPluginConsistency(bootstrap, member))
      .catch(() => null)
    })
  }, [canManagePlugins, workspace.workspaceProfile?.organizationId, member?.openclawProfile])

  async function loadMember(options = {}) {
    if (!user?.uid) return
    const preserveNotice = Boolean(options?.preserveNotice)
    setLoading(true)
    setError('')
    if (!preserveNotice) setNotice('')
    try {
      const nextMember = selfOnly
        ? buildCurrentWorkspaceMember({ user, profile, workspaceProfile: workspace.workspaceProfile })
        : workspace.isAdmin
        ? (await listCloudOrganizationMembers(supabase, user.uid)).find(item => item.memberId === memberId || item.id === memberId) || null
        : (() => {
            const currentMember = buildCurrentWorkspaceMember({ user, profile, workspaceProfile: workspace.workspaceProfile })
            return currentMember.memberId === memberId || currentMember.id === memberId ? currentMember : null
          })()
      setMember(nextMember)
      if (workspace.isAdmin && nextMember?.memberId) {
        loadOrganizationPluginEntitlements().catch(() => null)
      } else {
        setOrganizationPluginEntitlements([])
      }
      if (nextMember?.openclawProfile && isMemberLocal(nextMember)) {
        setHostStatus(null)
        setProfilePlugins([])
        setPluginPolicyBootstrap(null)
        setPluginDoctorReport(null)
      } else if (workspace.isAdmin && nextMember?.openclawProfile) {
        const status = await refreshProfileStatus(nextMember).catch(() => null)
        if (statusProfileExists(status) === false) {
          setProfilePlugins([])
          setPluginPolicyBootstrap(null)
          setPluginDoctorReport(null)
        } else {
          loadProfilePlugins(nextMember, status).catch(() => null)
          loadPluginPolicyBootstrap(nextMember)
            .then(bootstrap => checkPluginConsistency(bootstrap, nextMember, status))
            .catch(() => null)
        }
      } else {
        setProfilePlugins([])
        setPluginPolicyBootstrap(null)
        setPluginDoctorReport(null)
      }
    } catch (err) {
      setError(String(err?.message || err || '读取成员详情失败'))
      setMember(null)
    } finally {
      setLoading(false)
    }
  }

  async function loadProfilePlugins(targetMember = member, targetHostStatus = hostStatus) {
    if (!targetMember?.openclawProfile) {
      setProfilePlugins([])
      return null
    }
    if (statusProfileExists(targetHostStatus) === false) {
      setProfilePlugins([])
      return null
    }
    setLoadingPlugins(true)
    try {
      const snapshot = await engineClient.plugins.listProfile({
        profile: targetMember.openclawProfile,
      })
      const plugins = Array.isArray(snapshot?.plugins) ? snapshot.plugins : []
      setProfilePlugins(plugins)
      return snapshot
    } finally {
      setLoadingPlugins(false)
    }
  }

  async function loadOrganizationPluginEntitlements() {
    if (!user?.uid || !workspace.isAdmin) return []
    const rows = await listMyOrganizationPluginEntitlements(supabase, user.uid)
    setOrganizationPluginEntitlements(rows)
    return rows
  }

  async function loadPluginPolicyBootstrap(targetMember = member) {
    if (!user?.uid || !targetMember?.openclawProfile) return null
    const bootstrap = await getMyWorkspacePluginPolicyBootstrap(supabase, user.uid)
    const scopedBootstrap = {
      ...bootstrap,
      openclawProfile: targetMember.openclawProfile,
    }
    setPluginPolicyBootstrap(scopedBootstrap)
    return scopedBootstrap
  }

  async function checkPluginConsistency(targetBootstrap = pluginPolicyBootstrap, targetMember = member, targetHostStatus = hostStatus) {
    if (!targetMember?.openclawProfile) return null
    if (statusProfileExists(targetHostStatus) === false) {
      setPluginDoctorReport(null)
      return null
    }
    setCheckingPluginConsistency(true)
    setError('')
    try {
      const bootstrap = targetBootstrap || await loadPluginPolicyBootstrap(targetMember)
      const report = await checkProfilePluginConsistency({
        bootstrap: {
          ...bootstrap,
          openclawProfile: targetMember.openclawProfile,
        },
      })
      setPluginDoctorReport(report)
      return report
    } catch (err) {
      setError(String(err?.message || err || '检查 Profile 插件配置失败'))
      return null
    } finally {
      setCheckingPluginConsistency(false)
    }
  }

  async function reconcilePluginConsistency() {
    if (!member?.openclawProfile) return null
    const requestScope = catalogRequestScope
    if (catalogRequestScopeRef.current !== requestScope) return null
    const catalogRequest = beginCloudAgentCatalogRequest(requestScope)
    const commitCurrentRequest = commit => {
      if (catalogRequestScopeRef.current !== requestScope) return false
      return commitCloudAgentCatalogRequest(catalogRequest, commit)
    }
    setReconcilingPluginConsistency(true)
    setError('')
    setNotice('')
    try {
      const bootstrap = await loadPluginPolicyBootstrap(member)
      let catalogWarning = null
      let catalogCommitted = false
      // 先把 catalog 声明的 cloud-agent 插件灌进动态登记表:一键启用要为
      // 它们逐个签发 host credential,不能只认静态内置表。目录只接受
      // Rust trusted-service command 的当前在线响应；失败时静态表兜底。
      try {
        const catalogResponse = await fetchTrustedPluginCatalog()
        const catalogRows = normalizeCloudPluginCatalogRows(
          trustedCatalogRowsForCurrentResponse(catalogResponse),
        )
        catalogCommitted = commitCurrentRequest(() => {
          replaceCloudAgentPluginCatalog(catalogRows)
        })
      } catch (err) {
        catalogCommitted = commitCurrentRequest(() => {
          replaceCloudAgentPluginCatalog([])
          catalogWarning = normalizeTrustedServiceError(err)
        })
      }
      if (!catalogCommitted) return null
      const report = await reconcileProfilePluginConsistency({
        bootstrap: {
          ...bootstrap,
          openclawProfile: member.openclawProfile,
        },
        authEnvForProfile: currentCloudAgentRuntimeAuthEnv,
        isCloudAgentPlugin: isCloudAgentPluginId,
      })
      if (!commitCurrentRequest(() => {
        setPluginDoctorReport(report)
        setLastAppliedPluginPolicyVersion(Number(bootstrap?.policyVersion || 0))
      })) return null
      await loadProfilePlugins(member)
      commitCurrentRequest(() => {
        setNotice(catalogWarning
          ? `已按内置目录启用组织插件；${catalogWarning.message}`
          : '已一键启用当前 Uniopc 引擎 profile 的组织插件配置。')
      })
      return report
    } catch (err) {
      commitCurrentRequest(() => {
        setError(String(err?.message || err || '一键启用组织插件失败'))
      })
      return null
    } finally {
      commitCurrentRequest(() => setReconcilingPluginConsistency(false))
    }
  }

  function canEnableProfilePlugin(plugin) {
    if (!plugin?.id) return false
    if (isFoundationProfilePlugin(plugin)) return true
    return entitlementByPluginId.get(plugin.id)?.status === 'active'
  }

  function isGlobalProfilePlugin(plugin) {
    if (isFoundationProfilePlugin(plugin)) return true
    return entitlementIsGlobal(entitlementByPluginId.get(plugin?.id))
  }

  async function refreshProfileStatus(targetMember = member) {
    if (!targetMember?.openclawProfile) return null
    if (!selfOnly && isMemberLocal(targetMember) && !ownerLocalProfile) {
      setHostStatus(null)
      setNotice('成员本机运行：Uniopc 引擎 和 Gateway 需要由成员自己的电脑完成准备。')
      return null
    }
    setCheckingProfile(true)
    try {
      const status = await engineClient.status.profile({
        input: {
          profile: targetMember.openclawProfile,
          managedMemberProfile: isManagedMemberProfile(targetMember),
        },
      })
      setHostStatus(status)
      return status
    } catch (err) {
      throw err
    } finally {
      setCheckingProfile(false)
    }
  }

  async function createProfile() {
    if (!user?.uid || !member?.memberId) return
    setCreatingProfile(true)
    setError('')
    setNotice('')
    try {
      if (!member.openclawProfile || !member.openclawProfileId) {
        await createMemberOpenClawProfile(supabase, user.uid, member.memberId, {
          profile: buildMemberOpenClawProfileKey(member),
          memberEmail: member.memberEmail,
          displayName: member.displayName,
          runtimeMode: 'member_local',
        })
        await loadMember({ preserveNotice: true })
      }
      setNotice('成员本机运行：Uniopc 引擎 和 Gateway 需要由成员自己的电脑完成准备。')
    } catch (err) {
      setError(String(err?.message || err || '创建 Uniopc 引擎 Profile 失败'))
    } finally {
      setCreatingProfile(false)
    }
  }

  function selectMemberDetailSection(sectionKey) {
    setMemberDetailSection(sectionKey)
    navigate({
      pathname: location.pathname,
      search: sectionKey === defaultDetailSection ? '' : `?section=${sectionKey}`,
    }, { replace: true })
  }

  async function toggleProfilePlugin(plugin, enabled) {
    if (!member?.openclawProfile || !plugin?.id) return
    if (enabled && !canEnableProfilePlugin(plugin)) {
      setError('组织尚未授权该插件，请先联系 Uniopc 平台管理员开通。')
      return
    }
    setPluginActionId(plugin.id)
    setError('')
    setNotice('')
    try {
      const authEnv = enabled && isCloudAgentPluginId(plugin.id)
        ? await currentCloudAgentRuntimeAuthEnv({
            profile: member.openclawProfile,
            pluginIds: [plugin.id],
          })
        : {}
      const snapshot = await engineClient.plugins.setProfile({
        req: {
          profile: member.openclawProfile,
          pluginId: plugin.id,
          enabled,
          ...authEnv,
        },
      })
      setProfilePlugins(Array.isArray(snapshot?.plugins) ? snapshot.plugins : [])
      setNotice(enabled ? `${plugin.title || plugin.id} 已为该 profile 开启。` : `${plugin.title || plugin.id} 已为该 profile 关闭。`)
    } catch (err) {
      setError(String(err?.message || err || '更新 profile 插件配置失败'))
    } finally {
      setPluginActionId('')
    }
  }

  const gatewayStatus = statusGatewayStatus(hostStatus) || member?.gatewayStatus || 'offline'
  const canEnterWorkspace = canEnterOwnProfileWorkspace(member, user)
  const detailRows = selfOnly ? [
    { label: '角色', value: roleLabel(member?.memberRole) },
    { label: '注册状态', value: member?.statusLabel },
    { label: '云端 Profile', value: cloudProfileStatusLabel(member) },
    { label: '本机状态', value: localProfileStatusLabel(member, hostStatus) },
  ] : [
    { label: '角色', value: roleLabel(member?.memberRole) },
    { label: '注册状态', value: member?.statusLabel },
    { label: '云端 Profile', value: cloudProfileStatusLabel(member) },
  ]

  function enterMemberWorkspace() {
    if (!hasProfileWorkspaceEntry(member)) {
      setError('该成员还没有云端 Uniopc 引擎 profile，暂时不能进入 Workspace。')
      return
    }
    if (!canEnterOwnProfileWorkspace(member, user)) {
      setError('成员本机 Workspace 只能由成员本人进入。Owner/Admin 这里只查看和管理云端状态。')
      return
    }
    navigate(profileWorkspacePath({ ...member, isCurrentMember: true }, 'cloud-workbench'), {
      state: profileWorkspaceStateForMember(member),
    })
  }

  return (
    <div className="mx-auto flex h-full max-w-[1180px] flex-col overflow-hidden">
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-subtle pb-5">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold text-primary">{member?.displayName || '成员详情'}</h1>
          <div className="mt-2 truncate text-sm text-tertiary">{member?.memberEmail || '-'}</div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {selfOnly && (
            <button
              type="button"
              onClick={enterMemberWorkspace}
              disabled={!canEnterWorkspace}
              title={canEnterWorkspace ? '进入自己的 Workspace' : '成员本机 Workspace 只能由成员本人进入'}
              className={ACTION.primary}
            >
              进入 Workspace
            </button>
          )}
          <button type="button" onClick={loadMember} disabled={loading} className={ACTION.secondary}>
            刷新
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-danger-text">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm text-success-text">
          {notice}
        </div>
      )}

      {loading || workspace.loading ? (
        <div className="flex h-56 items-center justify-center text-sm text-tertiary">正在读取成员详情...</div>
      ) : !member ? (
        <div className="flex h-56 flex-col items-center justify-center px-6 text-center">
          <div className="text-base font-medium text-primary">成员不存在</div>
        </div>
      ) : (
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
          <section className="border-b border-subtle pb-5">
            <div className="grid gap-4 md:grid-cols-4">
              {detailRows.map(row => (
                <DetailRow key={row.label} label={row.label} value={row.value} />
              ))}
            </div>
          </section>

          {shouldShowDetailTabs && (
            <section className="border-b border-subtle pt-3">
              <div className="flex min-w-0 gap-7 overflow-x-auto">
                {detailSections.map(section => (
                  <button
                    key={section.key}
                    type="button"
                    onClick={() => selectMemberDetailSection(section.key)}
                    className={`shrink-0 border-b-2 pb-3 text-sm font-medium transition-colors ${
                      memberDetailSection === section.key
                        ? 'border-violet-400 text-primary'
                        : 'border-transparent text-tertiary hover:text-primary'
                    }`}
                  >
                    {section.label}
                  </button>
                ))}
              </div>
            </section>
          )}

          {selfOnly && memberDetailSection === 'profile' && (
            <section className="border-b border-subtle py-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-primary">
                    {ownerLocalProfile ? 'Owner 本机 Uniopc 引擎 Profile' : 'Uniopc 引擎 Profile'}
                  </div>
                  <div className="mt-3 grid gap-4 md:grid-cols-2">
                    <DetailRow label="Profile Key" value={member.openclawProfile || '未创建'} />
                    <DetailRow label="Profile ID" value={member.openclawProfileId || '-'} />
                    <DetailRow label="Gateway" value={gatewayStatus} />
                    <DetailRow label="Gateway URL" value={member.gatewayUrl || hostStatus?.gatewayUrl || '-'} />
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={createProfile}
                    disabled={isLocalProfileOnline(member, hostStatus) || creatingProfile || checkingProfile}
                    className={ACTION.primary}
                  >
                    {profileActionLabel(member, creatingProfile, checkingProfile, hostStatus)}
                  </button>
                  <button
                    type="button"
                    onClick={() => refreshProfileStatus().catch(err => setError(String(err?.message || err || '检测 Uniopc 引擎 profile 失败')))}
                    disabled={!member.openclawProfile || checkingProfile}
                    className={ACTION.secondary}
                  >
                    {checkingProfile ? '检测中...' : '检测状态'}
                  </button>
                </div>
              </div>
              {member.gatewayStatusMessage && (
                <div className={`mt-4 rounded-xl border px-4 py-3 text-xs ${statusClass(member.gatewayStatus)}`}>
                  {member.gatewayStatusMessage}
                </div>
              )}
            </section>
          )}

          {selfOnly && memberDetailSection === 'local' && (
            <section className="border-b border-subtle py-5">
              <div className="space-y-4">
                {memberLocalRuntime ? (
                  <>
                    <ConnectionHero
                      kind="local"
                      title="成员本机运行"
                      description={selfOnly ? 'Uniopc 引擎 和 Gateway 由这台电脑准备和运行。' : 'Uniopc 引擎 和 Gateway 由成员自己的电脑准备和运行。'}
                      latency={gatewayStatus === 'online' ? 'online' : null}
                    />

                    <ConnectionRunsRow
                      value={selfOnly ? '这台电脑' : '成员自己的电脑'}
                      helper={selfOnly ? '当前账号使用自己的本机 Uniopc 引擎 和 Gateway。' : 'Owner/Admin 这里只查看云端 profile 状态，不在 Host 本机 provision。'}
                    />

                    <div className="rounded-xl border border-subtle bg-surface-raised px-4 py-4">
                      <div className="text-base font-semibold text-primary">成员本机运行</div>
                      <div className="mt-2 text-xs leading-5 text-tertiary">
                        {selfOnly
                          ? '你需要在这台电脑完成 Uniopc 引擎 准备并启动 Gateway。'
                          : '该成员需要在自己的电脑完成 Uniopc 引擎 准备并启动 Gateway。Owner/Admin 这里只查看状态，不在 Host 本机 provision。'}
                      </div>
                    </div>
                  </>
                ) : null}

              </div>
            </section>
          )}

          {selfOnly && memberDetailSection === 'operations' && (
            <section className="border-b border-subtle py-5">
              {member.openclawProfile ? (
                <Operations embedded profileWorkspaceOverride={profileWorkspaceForMember(member)} />
              ) : (
                <div className="rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-xs leading-5 text-warning-text">
                  需要先创建该成员的 Uniopc 引擎 profile，才能管理运行中心。
                </div>
              )}
            </section>
          )}

          {selfOnly && memberDetailSection === 'models' && (
            <section className="border-b border-subtle py-5">
              {member.openclawProfile ? (
                <ModelSettings embedded profileWorkspaceOverride={profileWorkspaceForMember(member)} />
              ) : (
                <div className="rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-xs leading-5 text-warning-text">
                  需要先创建该成员的 Uniopc 引擎 profile，才能配置模型。
                </div>
              )}
            </section>
          )}

          {selfOnly && memberDetailSection === 'version' && (
            <section className="border-b border-subtle py-5">
              <OpenClawRuntime />
            </section>
          )}

          {selfOnly && ownerLocalProfile && memberDetailSection === 'profile' && !member.openclawProfile && (
            <section className="border-b border-subtle py-5">
              <button
                type="button"
                onClick={createProfile}
                disabled={creatingProfile || checkingProfile}
                className={ACTION.primary}
              >
                {profileActionLabel(member, creatingProfile, checkingProfile, hostStatus)}
              </button>
            </section>
          )}
          {canManagePlugins && memberDetailSection === 'plugins' && (
            <section className="border-b border-subtle py-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-primary">Host 插件配置</div>
                  <div className="mt-2 text-xs leading-5 text-tertiary">
                    在 Host 本机为该成员的 Uniopc 引擎 profile / Gateway 配置插件。Workspace 运行端只读取 Gateway 已暴露的可用工具，不在这里之外管理插件。
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => loadProfilePlugins(member).catch(err => setError(String(err?.message || err || '读取 profile 插件失败')))}
                  disabled={loadingPlugins || !member.openclawProfile}
                  className={ACTION.secondary}
                >
                  {loadingPlugins ? '读取中...' : '刷新插件'}
                </button>
              </div>
              {!member.openclawProfile ? (
                <div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-4 text-xs leading-5 text-warning-text">
                  <div className="text-sm font-semibold text-warning-text">先创建 Uniopc 引擎 Profile</div>
                  <div className="mt-1 text-warning-text/80">
                    该成员还没有 Uniopc 引擎 profile。请先在 Uniopc 引擎 Profile 页创建 profile，创建完成后再配置插件。
                  </div>
                </div>
              ) : (
                <>
                  <div className="mt-4 rounded-xl border border-subtle bg-surface-raised px-4 py-3">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div>
                        <div className="text-sm font-semibold text-primary">组织插件</div>
                        <div className="mt-1 text-xs leading-5 text-tertiary">
                          读取当前组织授权的插件，并一键配置到该成员的本机 Uniopc 引擎 profile。
                        </div>
                        <div className="mt-2 text-xs text-secondary">
                          Policy v{pluginPolicyBootstrap?.policyVersion || 0}
                          {lastAppliedPluginPolicyVersion ? ` · 已应用 v${lastAppliedPluginPolicyVersion}` : ''}
                          {pluginDoctorReport?.status ? ` · ${pluginDoctorReport.status}` : ''}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={reconcilePluginConsistency}
                          disabled={!member.openclawProfile || checkingPluginConsistency || reconcilingPluginConsistency}
                          className={ACTION.primary}
                        >
                          {reconcilingPluginConsistency ? '启用中...' : '一键启用'}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 overflow-hidden rounded-xl border border-subtle bg-surface-sunken">
                    {visibleProfilePlugins.length === 0 ? (
                      <div className="px-4 py-4 text-sm text-tertiary">
                        {loadingPlugins ? '正在读取插件列表...' : '还没有读取到可配置插件。'}
                      </div>
                    ) : visibleProfilePlugins.map(plugin => {
                      const busy = pluginActionId === plugin.id
                      const nextEnabled = !plugin.enabled
                      const entitlement = entitlementByPluginId.get(plugin.id)
                      const isGlobalPlugin = isGlobalProfilePlugin(plugin)
                      const toggleDisabled = busy || loadingPlugins || !plugin.installed
                      return (
                        <div key={plugin.id} className="grid gap-3 border-b border-subtle px-4 py-3 last:border-b-0 lg:grid-cols-[minmax(0,1fr)_auto_auto_auto] lg:items-center">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              {plugin.product?.iconSvg && (
                                // data-URI <img> keeps arbitrary plugin SVGs inert (no script execution).
                                <img
                                  alt=""
                                  className="h-6 w-6 shrink-0 rounded-md"
                                  src={`data:image/svg+xml;utf8,${encodeURIComponent(plugin.product.iconSvg)}`}
                                />
                              )}
                              <div className="truncate text-sm font-medium text-primary">{plugin.product?.displayName || plugin.title || plugin.id}</div>
                            </div>
                            <div className="mt-1 text-xs leading-5 text-tertiary">{plugin.product?.description || plugin.description || plugin.id}</div>
                            {Array.isArray(plugin.product?.skills) && plugin.product.skills.length > 0 && (
                              <div className="mt-1 truncate text-xs leading-5 text-tertiary">
                                内置技能：{plugin.product.skills.map(skill => skill.displayName || skill.id).join('、')}
                              </div>
                            )}
                            {Array.isArray(plugin.product?.recommend) && plugin.product.recommend.length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {plugin.product.recommend
                                  .flatMap(section => (Array.isArray(section.prompts) ? section.prompts : []))
                                  .slice(0, 3)
                                  .map(prompt => (
                                    <span
                                      key={prompt.id}
                                      title={prompt.text}
                                      className="max-w-[240px] truncate rounded-md border border-default px-2 py-0.5 text-2xs text-secondary"
                                    >
                                      {prompt.text}
                                    </span>
                                  ))}
                              </div>
                            )}
                            {isCloudAgentPluginId(plugin.id) && (
                            <div className="mt-1 text-xs leading-5 text-tertiary">
                              Host 一键启用后，Gateway 会暴露可用工具；Workspace 运行端只负责调用。
                            </div>
                          )}
                            {!isFoundationProfilePlugin(plugin) && entitlement?.status === 'active' && (
                              <div className="mt-1 text-xs text-success-text">组织已授权</div>
                            )}
                            {isGlobalPlugin && (
                              <div className="mt-1 text-xs text-success-text">组织默认授权</div>
                            )}
                            {plugin.enabled && Array.isArray(plugin.missingEnv) && plugin.missingEnv.length > 0 && (
                              <div className="mt-1 truncate text-xs text-warning-text">
                                {isCloudAgentPluginId(plugin.id)
                                  ? '未就绪：请点击一键启用。'
                                  : `缺少 ${plugin.missingEnv.join(', ')}`}
                              </div>
                            )}
                          </div>
                          <span className={`inline-flex h-8 w-fit items-center rounded-lg border px-3 text-xs ${profilePluginStatusClass(plugin)}`}>
                            {profilePluginStatusLabel(plugin)}
                          </span>
                          <button
                            type="button"
                            onClick={() => toggleProfilePlugin(plugin, plugin.status === 'missing_env' || plugin.status === 'bridge_disabled' ? true : nextEnabled)}
                            disabled={toggleDisabled}
                            className={!plugin.installed || plugin.enabled ? ACTION.secondary : ACTION.primary}
                          >
                            {profilePluginActionLabel(plugin, { busy })}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </section>
          )}

        </div>
      )}
    </div>
  )
}
