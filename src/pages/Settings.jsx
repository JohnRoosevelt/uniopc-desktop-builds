import { useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../hooks/useAuth'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import { profileWorkspaceNavigationState, useProfileWorkspace } from '../hooks/useProfileWorkspace'
import { getAppUpdateStatus, installAppUpdate, relaunchApp } from '../lib/appUpdate'
import { updateMyCloudOrganizationName } from '../lib/cloudWorkspace'
import { supabase } from '../lib/supabase'
import {
  APPEARANCE_THEMES,
  applyAppearanceTheme,
  getStoredAppearanceTheme,
  setStoredAppearanceTheme,
  subscribeSystemAppearanceTheme,
} from '../lib/appearanceTheme'

const LANGUAGE_KEY = 'imai.language'
const SECTIONS = ['general', 'appearance', 'connection', 'profile', 'language', 'updates', 'organization']

function settingsSectionPath(pathname = '', section = 'general') {
  const normalizedPath = String(pathname || '').replace(/\/+$/, '')
  const profileSettingsMatch = normalizedPath.match(/^(\/profiles\/[^/]+\/settings)(?:\/[^/]+)?$/)
  return profileSettingsMatch ? `${profileSettingsMatch[1]}/${section}` : `/settings/${section}`
}

// 「本机权限」页管理的是 macOS TCC 权限(麦克风/语音识别/自动化),在
// Windows/Linux 上没有对应物 —— 入口整个隐藏,而不是渲染一页禁用按钮。
const HOST_PERMISSIONS_SUPPORTED =
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

// System-management entries (运行环境 / 我的团队 / 本机权限) live on profile-scoped
// sibling routes, not settings sections, so build the path off the profile base.
function profileScopedPath(pathname = '', child = '') {
  const normalizedPath = String(pathname || '').replace(/\/+$/, '')
  const match = normalizedPath.match(/^(\/profiles\/[^/]+)\/settings/)
  const base = match ? match[1] : '/profiles/me'
  return `${base}/${String(child).replace(/^\/+/, '')}`
}

function SettingsIcon({ type }) {
  const common = 'h-4 w-4'
  if (type === 'general') {
    return (
      <svg className={common} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    )
  }
  if (type === 'profile') {
    return (
      <svg className={common} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 7.5a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.5 20.25a7.5 7.5 0 0115 0" />
      </svg>
    )
  }
  if (type === 'appearance') {
    return (
      <svg className={common} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3.75a8.25 8.25 0 00-8.25 8.25c0 3.728 3.023 6.75 6.75 6.75h1.125a1.875 1.875 0 000-3.75H10.5a1.5 1.5 0 010-3h3a1.875 1.875 0 100-3.75h-1.5" />
        <path strokeLinecap="round" d="M7.5 10.5h.01M9.75 7.5h.01M14.25 7.5h.01" />
      </svg>
    )
  }
  if (type === 'connection') {
    return (
      <svg className={common} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 12h7.5M7.5 8.25h-.75a3.75 3.75 0 000 7.5h.75M16.5 8.25h.75a3.75 3.75 0 010 7.5h-.75" />
      </svg>
    )
  }
  if (type === 'updates') {
    return (
      <svg className={common} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v10.25m0 0l-4-4m4 4l4-4M5.25 18.75h13.5" />
      </svg>
    )
  }
  if (type === 'language') {
    return (
      <svg className={common} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 5.25h7.5M8.25 4.5v1.5m2.25 0c-.603 2.187-2.051 4.213-4.5 6m1.5-3c.75 1.125 1.875 2.25 3.75 3.75M13.5 19.5l4.5-10.5 4.5 10.5M15 16.5h6" />
      </svg>
    )
  }
  if (type === 'environment') {
    return (
      <svg className={common} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 4.75h10.5A2.25 2.25 0 0119.5 7v10a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 17V7a2.25 2.25 0 012.25-2.25z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 9h7.5M8.25 12h4.5M8.25 15h7.5" />
      </svg>
    )
  }
  if (type === 'host-permissions') {
    return (
      <svg className={common} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3.75l7.25 2.7v5.3c0 4.35-2.9 7.05-7.25 8.5-4.35-1.45-7.25-4.15-7.25-8.5v-5.3L12 3.75z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.25 12.25l1.75 1.75 3.75-4" />
      </svg>
    )
  }
  return (
    <svg className={common} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}

function SettingNavButton({ item, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-base font-medium transition-colors ${
        active ? 'bg-state-hover text-primary' : 'text-secondary hover:bg-state-hover hover:text-primary'
      }`}
    >
      <SettingsIcon type={item.id} />
      <span>{item.label}</span>
    </button>
  )
}

function FieldLabel({ children }) {
  return <label className="mb-1.5 block text-xs font-medium text-tertiary">{children}</label>
}

function TextInput(props) {
  return (
    <input
      {...props}
      className={`h-9 w-full rounded-lg border border-default bg-surface-sunken px-3 text-sm text-primary outline-none transition-colors placeholder:text-tertiary focus:border-violet-400/35 ${props.className || ''}`}
    />
  )
}

function TextArea(props) {
  return (
    <textarea
      {...props}
      className={`min-h-20 w-full resize-none rounded-lg border border-default bg-surface-sunken px-3 py-2 text-sm leading-5 text-primary outline-none transition-colors placeholder:text-tertiary focus:border-violet-400/35 ${props.className || ''}`}
    />
  )
}

function SettingsCard({ children, className = '' }) {
  return <div className={`rounded-xl border border-default bg-surface-raised p-4 ${className}`}>{children}</div>
}

function SettingsRow({ title, subtitle, children, divider = true }) {
  return (
    <div className={`flex flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:justify-between ${divider ? 'border-b border-subtle' : ''}`}>
      <div className="min-w-0">
        <div className="text-base font-semibold text-primary">{title}</div>
        {subtitle && <div className="mt-1 text-sm leading-5 text-secondary">{subtitle}</div>}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  )
}

function profileRoleLabel(workspaceProfile) {
  const role = String(workspaceProfile?.memberRole || '').trim().toLowerCase()
  if (role === 'owner' || workspaceProfile?.isOwner) return 'Owner'
  if (role === 'admin' || workspaceProfile?.isAdmin) return 'Admin'
  return 'Member'
}

function ProfileMetaItem({ label, value, accent = false }) {
  return (
    <div className="min-w-0">
      <div className="text-2xs font-medium text-tertiary">{label}</div>
      <div className={`mt-1 truncate text-sm font-medium ${accent ? 'text-accent-text' : 'text-secondary'}`}>{value}</div>
    </div>
  )
}

function ThemePreview({ mode, label, active, onClick }) {
  const previewStyle = mode === 'system'
    ? { background: 'linear-gradient(90deg, #f5f5f4 0 50%, #222325 50% 100%)' }
    : undefined
  return (
    <button type="button" onClick={onClick} className="group text-left">
      <div className={`h-24 w-40 overflow-hidden rounded-xl border transition-colors ${active ? 'border-violet-400/70' : 'border-subtle group-hover:border-strong'}`}>
        <div className={`flex h-full ${mode === 'light' ? 'bg-stone-100' : mode === 'dark' ? 'bg-surface-overlay' : ''}`} style={previewStyle}>
          <div className={`h-full w-14 ${mode === 'light' ? 'bg-stone-200' : mode === 'dark' ? 'bg-surface-raised' : 'bg-stone-200'}`}>
            <div className="mt-3 flex gap-1 px-3">
              <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
              <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </div>
            <div className="mt-5 space-y-2 px-3">
              <div className={`h-1.5 w-8 rounded ${mode === 'dark' ? 'bg-surface-float' : 'bg-stone-300'}`} />
              <div className={`h-1.5 w-6 rounded ${mode === 'dark' ? 'bg-surface-float' : 'bg-stone-300'}`} />
            </div>
          </div>
          <div className="flex-1 px-4 pt-7">
            <div className={`h-2 w-20 rounded ${mode === 'light' ? 'bg-stone-300' : 'bg-surface-float'}`} />
            <div className={`mt-3 h-2 w-24 rounded ${mode === 'light' ? 'bg-stone-300' : 'bg-surface-float'}`} />
            <div className={`mt-3 h-2 w-14 rounded ${mode === 'light' ? 'bg-stone-300' : 'bg-surface-float'}`} />
          </div>
        </div>
      </div>
      <div className={`mt-2 text-center text-sm font-medium ${active ? 'text-primary' : 'text-tertiary'}`}>{label}</div>
    </button>
  )
}

function LanguageOption({ label, description, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors ${
        active ? 'border-violet-400/60 bg-violet-400/10' : 'border-subtle bg-surface-overlay hover:border-default hover:bg-state-hover'
      }`}
    >
      <span>
        <span className="block text-base font-medium text-primary">{label}</span>
        <span className="mt-1 block text-xs text-tertiary">{description}</span>
      </span>
      <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${active ? 'border-violet-300 bg-violet-300 text-[#171717]' : 'border-strong text-transparent'}`}>
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </span>
    </button>
  )
}

export default function Settings() {
  const { t, i18n } = useTranslation()
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { user, profile, updateProfile, signOut } = useAuth()
  const activeOpenClaw = useActiveOpenClawProfile()
  const profileWorkspace = useProfileWorkspace()
  const profileWorkspaceState = profileWorkspaceNavigationState(profileWorkspace)
  const activeSection = params.section || 'profile'
  const [nickname, setNickname] = useState(profile?.nickname || '')
  const [organizationName, setOrganizationName] = useState('')
  const [theme, setTheme] = useState(getStoredAppearanceTheme)
  const [language, setLanguage] = useState(() => {
    try {
      const saved = localStorage.getItem(LANGUAGE_KEY)
      if (saved === 'en' || saved === 'zh') return saved
    } catch {}
    return i18n.language === 'en' ? 'en' : 'zh'
  })
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingOrganization, setSavingOrganization] = useState(false)
  const [appUpdateBusy, setAppUpdateBusy] = useState(false)
  const [appUpdate, setAppUpdate] = useState(null)
  const [appUpdateStatus, setAppUpdateStatus] = useState(null)
  const [appUpdateInstalled, setAppUpdateInstalled] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const updateChannel = 'stable'
  const workspaceProfile = profileWorkspace || activeOpenClaw.workspaceProfile
  const canEditOrganization = Boolean(workspaceProfile?.isAdmin)
  const organizationDisplayName = organizationName || workspaceProfile?.organizationName || '组织资料'
  const organizationTypeLabel = workspaceProfile?.organizationTypeName || workspaceProfile?.organizationTypeKey || '-'
  const profileOrganizationName = activeOpenClaw.loading
    ? '读取中...'
    : workspaceProfile?.organizationName || '未加入组织'
  const profileIdentityLabel = activeOpenClaw.loading ? '读取中...' : profileRoleLabel(workspaceProfile)

  const settingsGroups = [
    {
      title: 'Basics',
      items: [
        { id: 'general', label: t('settings.general') },
        { id: 'appearance', label: t('settings.appearance') },
        { id: 'connection', label: 'Connection' },
      ],
    },
    {
      title: t('settings.my_account'),
      items: [
        { id: 'profile', label: t('settings.profile') },
        { id: 'language', label: t('settings.language') },
        { id: 'updates', label: t('settings.updates') },
      ],
    },
    ...(canEditOrganization ? [{
      title: organizationDisplayName,
      items: [{ id: 'organization', label: '组织资料' }],
    }] : []),
    {
      title: '系统管理',
      items: [
        { id: 'environment', label: '运行环境', route: 'environment' },
        ...(HOST_PERMISSIONS_SUPPORTED
          ? [{ id: 'host-permissions', label: '本机权限', route: 'host-permissions' }]
          : []),
      ],
    },
  ]

  useEffect(() => {
    setNickname(profile?.nickname || '')
  }, [profile?.nickname])

  useEffect(() => {
    setOrganizationName(workspaceProfile?.organizationName || '')
  }, [workspaceProfile?.organizationId, workspaceProfile?.organizationName])

  useEffect(() => subscribeSystemAppearanceTheme(() => {
    applyAppearanceTheme(theme)
  }), [theme])

  if (!SECTIONS.includes(activeSection)) {
    return (
      <Navigate
        to={settingsSectionPath(location.pathname, 'general')}
        replace
        state={profileWorkspaceState}
      />
    )
  }

  if (activeSection === 'organization' && !canEditOrganization) {
    return (
      <Navigate
        to={settingsSectionPath(location.pathname, 'general')}
        replace
        state={profileWorkspaceState}
      />
    )
  }

  function selectSection(section, item = null) {
    if (item?.route) {
      const target = profileScopedPath(location.pathname, item.route)
      navigate(target, { state: profileWorkspaceState })
      return
    }
    const target = settingsSectionPath(location.pathname, section)
    navigate(target, { state: profileWorkspaceState })
  }

  async function saveProfile(event) {
    event.preventDefault()
    setSavingProfile(true)
    setError('')
    setMessage('')
    try {
      await updateProfile({ nickname })
      setMessage(t('settings.profile_saved'))
    } catch (err) {
      setError(String(err?.message || err || t('settings.profile_save_failed')))
    } finally {
      setSavingProfile(false)
    }
  }

  async function saveOrganization(event) {
    event.preventDefault()
    if (!user?.uid || !canEditOrganization) return
    if (!organizationName.trim()) {
      setError('请输入组织显示名称。')
      setMessage('')
      return
    }

    setSavingOrganization(true)
    setError('')
    setMessage('')
    try {
      const nextProfile = await updateMyCloudOrganizationName(supabase, user.uid, organizationName)
      setOrganizationName(nextProfile.organizationName || organizationName.trim())
      setMessage('组织资料已保存。')
    } catch (err) {
      setError(String(err?.message || err || '保存组织资料失败'))
    } finally {
      setSavingOrganization(false)
    }
  }

  function saveTheme(nextTheme) {
    const savedTheme = setStoredAppearanceTheme(nextTheme)
    setTheme(savedTheme)
    setMessage(t('settings.appearance_saved'))
    setError('')
  }

  function saveLanguage(nextLanguage) {
    setLanguage(nextLanguage)
    try { localStorage.setItem(LANGUAGE_KEY, nextLanguage) } catch {}
    i18n.changeLanguage(nextLanguage)
    setMessage(t('settings.language_saved', { lng: nextLanguage }))
    setError('')
  }

  async function checkAppUpdates() {
    setAppUpdateBusy(true)
    setAppUpdateInstalled(false)
    setError('')
    setMessage('')
    try {
      const status = await getAppUpdateStatus({ channel: updateChannel })
      setAppUpdateStatus(status)
      setAppUpdate(status.update)
      setMessage(status.message)
    } catch (err) {
      setError(String(err?.message || err || '检测 Uniopc 更新失败'))
    } finally {
      setAppUpdateBusy(false)
    }
  }

  async function updateApp() {
    setAppUpdateBusy(true)
    setError('')
    setMessage('')
    let installedUpdate = false
    try {
      let update = appUpdate
      if (!update) {
        const status = await getAppUpdateStatus({ channel: updateChannel })
        setAppUpdateStatus(status)
        setAppUpdate(status.update)
        update = status.update
      }
      await installAppUpdate(update)
      installedUpdate = true
      setAppUpdateInstalled(true)
      setMessage('Uniopc 更新已安装，正在重启。')
      try {
        await relaunchApp()
      } catch (restartError) {
        setError(String(restartError?.message || restartError || '自动重启 Uniopc 失败，请手动重启应用。'))
        setAppUpdateBusy(false)
      }
    } catch (err) {
      setError(String(err?.message || err || '安装 Uniopc 更新失败'))
      setAppUpdateBusy(false)
    } finally {
      if (!installedUpdate) setAppUpdateBusy(false)
    }
  }

  useEffect(() => {
    if (activeSection !== 'updates' || appUpdateStatus || appUpdateBusy) return
    checkAppUpdates()
  }, [activeSection, appUpdateBusy, appUpdateStatus, updateChannel])

  return (
    <div className="h-[calc(100vh-6.5rem)] md:h-[calc(100vh-1.5rem)]">
      <section className="grid h-full min-h-[640px] overflow-hidden rounded-2xl border border-subtle bg-surface-raised lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="border-b border-subtle bg-surface-raised px-3 py-5 lg:border-b-0 lg:border-r">
          <div className="space-y-6">
            {settingsGroups.map(group => (
              <div key={group.title}>
                <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-[0.04em] text-tertiary">{group.title}</div>
                <div className="space-y-1">
                  {group.items.map(item => (
                    <SettingNavButton
                      key={item.id}
                      item={item}
                      active={!item.route && item.id === activeSection}
                      onClick={() => selectSection(item.id, item)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </aside>

        <main className="min-h-0 overflow-y-auto px-6 py-6">
          <div className="max-w-[1080px]">
            {(message || error) && (
              <div className={`mb-4 rounded-lg border px-3 py-2 text-sm ${error ? 'border-rose-400/20 bg-rose-500/10 text-danger-text' : 'border-emerald-400/18 bg-emerald-400/10 text-success-text'}`}>
                {error || message}
              </div>
            )}

            {activeSection === 'profile' && (
              <section>
                <h2 className="text-xl font-semibold text-primary">{t('settings.profile')}</h2>
                <form onSubmit={saveProfile} className="mt-4 rounded-xl border border-subtle bg-surface-sunken p-5">
                  <div className="flex items-center gap-5">
                    <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-sky-500 text-2xl font-semibold text-white">
                      {profile?.nickname?.[0] || '?'}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-secondary">{profile?.nickname || t('settings.default_user')}</div>
                      <div className="mt-1 text-sm text-tertiary">{user?.phone || user?.email || t('settings.local_account')}</div>
                    </div>
                  </div>
                  <div className="mt-5 grid max-w-[720px] gap-3 rounded-lg border border-subtle bg-surface-overlay px-4 py-3 sm:grid-cols-2">
                    <ProfileMetaItem label="身份" value={profileIdentityLabel} accent />
                    <ProfileMetaItem label="组织" value={profileOrganizationName} />
                  </div>
                  <div className="mt-5 max-w-[720px]">
                    <FieldLabel>{t('settings.name')}</FieldLabel>
                    <TextInput value={nickname} onChange={event => setNickname(event.target.value)} />
                  </div>
                  <div className="mt-5 flex max-w-[720px] justify-end gap-2">
                    <button type="button" onClick={signOut} className="inline-flex h-9 items-center rounded-lg border border-default bg-surface-overlay px-3 text-sm font-medium text-secondary transition-colors hover:bg-state-hover hover:text-primary">
                      {t('settings.sign_out')}
                    </button>
                    <button type="submit" disabled={savingProfile} className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-surface-raised transition-colors hover:opacity-90 disabled:opacity-50">
                      {savingProfile ? t('common.saving') : t('settings.update_profile')}
                    </button>
                  </div>
                </form>
              </section>
            )}

            {activeSection === 'appearance' && (
              <section>
                <h2 className="text-xl font-semibold text-primary">{t('settings.appearance')}</h2>
                <SettingsCard className="mt-5">
                  <div className="text-sm font-medium text-secondary">{t('settings.theme')}</div>
                  <div className="mt-4 flex flex-wrap gap-5">
                    {APPEARANCE_THEMES.map(mode => (
                      <ThemePreview key={mode} mode={mode} label={t(`settings.theme_${mode}`)} active={theme === mode} onClick={() => saveTheme(mode)} />
                    ))}
                  </div>
                  <p className="mt-4 text-xs leading-5 text-tertiary">{t('settings.theme_hint')}</p>
                </SettingsCard>
              </section>
            )}

            {activeSection === 'connection' && (
              <section>
                <h2 className="text-xl font-semibold text-primary">Connection</h2>
                <p className="mt-2 text-sm leading-5 text-tertiary">Runtime health lives in Operations.</p>
                <div className="mt-5 overflow-hidden rounded-xl border border-default bg-surface-raised">
                  <SettingsRow title="Uniopc 引擎" subtitle="Check runtime health, open the dashboard, and manage Browser Runtime." divider={false}>
                    <button type="button" onClick={() => navigate('/operations')} className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-surface-raised transition-colors hover:opacity-90">
                      Open Operations
                    </button>
                  </SettingsRow>
                </div>
              </section>
            )}

            {activeSection === 'language' && (
              <section>
                <h2 className="text-xl font-semibold text-primary">{t('settings.language')}</h2>
                <SettingsCard className="mt-5 max-w-[720px]">
                  <div className="text-sm font-medium text-secondary">{t('settings.language_display')}</div>
                  <div className="mt-4 grid gap-3">
                    <LanguageOption
                      label={t('settings.language_zh')}
                      description={t('settings.language_zh_desc')}
                      active={language === 'zh'}
                      onClick={() => saveLanguage('zh')}
                    />
                    <LanguageOption
                      label={t('settings.language_en')}
                      description={t('settings.language_en_desc')}
                      active={language === 'en'}
                      onClick={() => saveLanguage('en')}
                    />
                  </div>
                  <p className="mt-4 text-xs leading-5 text-tertiary">{t('settings.language_hint')}</p>
                </SettingsCard>
              </section>
            )}

            {activeSection === 'updates' && (
              <section>
                <h2 className="text-xl font-semibold text-primary">{t('settings.updates')}</h2>
                <p className="mt-2 text-sm leading-5 text-tertiary">{t('settings.updates_desc')}</p>
                <SettingsCard className="mt-8">
                  <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div>
                      <div className="text-base font-medium text-primary">Uniopc</div>
                      <div className="mt-1 text-sm leading-5 text-tertiary">
                        {t('settings.current_version')}：{appUpdateStatus?.currentVersion || t('settings.waiting_check')} · {t('settings.latest_version')}：{appUpdateStatus?.latestVersion || appUpdateStatus?.version || t('settings.waiting_check')}
                      </div>
                      {appUpdateStatus?.message && (
                        <div className="mt-2 text-xs text-tertiary">{appUpdateStatus.message}</div>
                      )}
                      {appUpdateStatus?.updateCheckError && appUpdateStatus?.available && !appUpdateStatus?.update && (
                        <div className="mt-2 text-xs text-amber-500">安装器检查暂未完成，可重试检查后更新。</div>
                      )}
                      {appUpdateStatus?.notes && (
                        <div className="mt-2 max-w-2xl whitespace-pre-wrap text-xs leading-5 text-tertiary">{appUpdateStatus.notes}</div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <button type="button" onClick={checkAppUpdates} disabled={appUpdateBusy} className="inline-flex h-9 items-center rounded-lg border border-default bg-surface-overlay px-3 text-sm font-medium text-secondary transition-colors hover:bg-state-hover disabled:opacity-50">
                        {appUpdateBusy ? t('settings.checking') : t('settings.check_now')}
                      </button>
                      <button type="button" onClick={updateApp} disabled={appUpdateBusy || !appUpdateStatus?.available || appUpdateInstalled} className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-surface-raised transition-colors hover:opacity-90 disabled:opacity-50">
                        {appUpdateInstalled ? '重启中...' : t('settings.update')}
                      </button>
                    </div>
                  </div>
                </SettingsCard>
              </section>
            )}

            {activeSection === 'organization' && canEditOrganization && (
              <section>
                <h2 className="text-xl font-semibold text-primary">组织资料</h2>
                <p className="mt-2 text-sm leading-5 text-tertiary">组织显示名称可由 owner/admin 调整，组织类型不可修改。</p>
                <form onSubmit={saveOrganization} className="mt-5 rounded-xl border border-subtle bg-surface-sunken p-5">
                  <div className="grid max-w-[720px] gap-4">
                    <div>
                      <FieldLabel>组织显示名称</FieldLabel>
                      <TextInput value={organizationName} onChange={event => setOrganizationName(event.target.value)} disabled={!canEditOrganization} />
                    </div>
                    <div>
                      <FieldLabel>组织类型</FieldLabel>
                      <TextInput value={organizationTypeLabel} disabled />
                      <p className="mt-2 text-xs leading-5 text-tertiary">组织类型不可修改。如需调整行业框架，请联系 Uniopc 平台管理员重新开通。</p>
                    </div>
                  </div>
                  <div className="mt-5 flex max-w-[720px] justify-end">
                    <button type="submit" disabled={savingOrganization || !canEditOrganization} className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-surface-raised transition-colors hover:opacity-90 disabled:opacity-50">
                      {savingOrganization ? t('common.saving') : t('common.save')}
                    </button>
                  </div>
                </form>
              </section>
            )}

          </div>
        </main>
      </section>
    </div>
  )
}
