import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useAuth } from '../hooks/useAuth'
import { profileWorkspaceNavigationState } from '../hooks/useProfileWorkspace'
import AppUpdateTitlebarControl from './AppUpdateTitlebarControl'
import { useGlobalArtifacts, GlobalArtifactsToggle, GlobalArtifactsPanel } from './GlobalArtifactsControl'
import { VoiceToDocumentSessionProvider } from './VoiceToDocumentSession'
import { fetchLlmCreditBalance } from '../lib/uniopcOfficialModel'
import { useRuntimeStatusStore } from '../lib/runtimeStatus'
const UPDATE_CHECK_CHANNEL = 'stable'
const IS_WINDOWS = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
const IS_LINUX = typeof navigator !== 'undefined' && !IS_WINDOWS && navigator.userAgent.includes('Linux')
// Keep the running artifact obvious: Vite injects DEV only for `tauri dev`,
// while every packaged installer is built in production mode.
const BUILD_FLAVOR = import.meta.env.DEV ? '开发测试版' : '正式版'
// Windows and Linux builds run with decorations: false (tauri.windows.conf.json /
// tauri.linux.conf.json), so the native window controls are drawn in-app and the
// titlebar has no macOS traffic-light inset to avoid.
const HAS_INAPP_WINDOW_CONTROLS = IS_WINDOWS || IS_LINUX

function NavIcon({ children, compact = false }) {
  return <span className={`flex ${compact ? 'h-4 w-4' : 'h-5 w-5'} shrink-0 items-center justify-center`}>{children}</span>
}

function TitlebarIconButton({ children, onClick, title, className = '', disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`
        inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-transparent
        text-tertiary
        transition-colors hover:bg-state-hover hover:text-primary
        disabled:pointer-events-none disabled:opacity-35
        ${className}
      `}
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  )
}

function startWindowDrag(event) {
  if (event.button !== 0) return
  event.preventDefault()
  getCurrentWindow().startDragging().catch(() => {})
}

function WindowsControlButton({ children, onClick, title, closeButton = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`
        inline-flex h-full w-[46px] items-center justify-center bg-transparent
        text-secondary transition-colors
        ${closeButton
          ? 'hover:bg-surface-float hover:text-primary'
          : 'hover:bg-state-hover hover:text-primary'}
      `}
    >
      {children}
    </button>
  )
}

// Windows and Linux builds run with decorations: false (tauri.windows.conf.json /
// tauri.linux.conf.json), so the native window controls are drawn here inside
// the in-app titlebar row.
function WindowsWindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const appWindow = getCurrentWindow()
    let cancelled = false
    let unlisten = null
    const syncMaximized = () => {
      appWindow
        .isMaximized()
        .then(value => {
          if (!cancelled) setMaximized(value)
        })
        .catch(() => {})
    }
    syncMaximized()
    appWindow
      .onResized(syncMaximized)
      .then(fn => {
        if (cancelled) {
          fn()
          return
        }
        unlisten = fn
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [])

  return (
    <div className="pointer-events-auto absolute right-0 top-0 z-20 flex h-full items-stretch">
      <WindowsControlButton title="最小化" onClick={() => getCurrentWindow().minimize().catch(() => {})}>
        <svg className="h-[10px] w-[10px]" fill="none" stroke="currentColor" strokeWidth={1.1} viewBox="0 0 10 10">
          <path d="M0.5 5h9" />
        </svg>
      </WindowsControlButton>
      <WindowsControlButton
        title={maximized ? '还原' : '最大化'}
        onClick={() => getCurrentWindow().toggleMaximize().catch(() => {})}
      >
        {maximized ? (
          <svg className="h-[10px] w-[10px]" fill="none" stroke="currentColor" strokeWidth={1.1} viewBox="0 0 10 10">
            <path d="M2.5 2.5v-2h7v7h-2" />
            <rect x="0.5" y="2.5" width="7" height="7" />
          </svg>
        ) : (
          <svg className="h-[10px] w-[10px]" fill="none" stroke="currentColor" strokeWidth={1.1} viewBox="0 0 10 10">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </WindowsControlButton>
      <WindowsControlButton title="关闭" closeButton onClick={() => getCurrentWindow().close().catch(() => {})}>
        <svg className="h-[10px] w-[10px]" fill="none" stroke="currentColor" strokeWidth={1.1} viewBox="0 0 10 10">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </WindowsControlButton>
    </div>
  )
}

function routeMatches(pathname, target, options = {}) {
  if (options.exact) {
    return pathname === target
  }
  return pathname === target || pathname.startsWith(`${target}/`)
}

function deriveRouteTitle(pathname, navItems, t) {
  const matched = navItems.find(item => routeMatches(pathname, item.to, { exact: item.exact }))
  if (matched) {
    return matched.label
  }
  if (pathname.startsWith('/projects/')) return t('nav.conversations')
  if (pathname.startsWith('/employees')) return t('nav.employees')
  if (pathname === '/workbench') return t('nav.conversations')
  if (pathname.startsWith('/cloud-workbench')) return t('nav.conversations')
  if (pathname.startsWith('/cloud-documents')) return t('nav.cloudDocuments')
  if (pathname.startsWith('/plugins')) return t('nav.plugins')
  if (pathname.startsWith('/mcphub')) return t('nav.mcp')
  if (pathname.startsWith('/apps')) return t('nav.applications')
  if (pathname.startsWith('/profiles/') && pathname.includes('/cloud-project/')) return t('nav.conversations')
  if (pathname.startsWith('/profiles/') && pathname.includes('/cloud-workbench')) return t('nav.conversations')
  if (pathname.startsWith('/profiles/') && pathname.includes('/cloud-documents')) return t('nav.cloudDocuments')
  if (pathname.startsWith('/profiles/') && pathname.includes('/plugins')) return t('nav.plugins')
  if (pathname.startsWith('/profiles/') && pathname.includes('/mcphub')) return t('nav.mcp')
  if (pathname.startsWith('/profiles/') && pathname.includes('/environment')) return '运行环境'
  if (pathname.startsWith('/profiles/') && pathname.includes('/openclaw-runtime')) return '运行环境'
  if (pathname.startsWith('/profiles/') && pathname.includes('/host-permissions')) return '本机权限'
  if (pathname.startsWith('/admin')) return t('nav.admin')
  if (pathname.startsWith('/openclaw-runtime')) return '运行环境'
  if (pathname.startsWith('/host-permissions')) return '本机权限'
  if (pathname.startsWith('/workshops')) return t('nav.workbench')
  if (pathname.startsWith('/studio')) return t('nav.workbench')
  if (pathname.startsWith('/models')) return t('nav.models')
  if (pathname.startsWith('/mobile') || (pathname.startsWith('/profiles/') && pathname.includes('/mobile'))) return t('nav.mobile')
  return t('brand.name')
}

function profileRouteBase(pathname = '') {
  const match = String(pathname || '').match(/^\/profiles\/([^/]+)/)
  return match ? `/profiles/${match[1]}` : ''
}

function cleanText(value = '') {
  return String(value || '').trim()
}

function accountDisplayName({ user = null, profile = null } = {}) {
  return cleanText(profile?.nickname) ||
    cleanText(user?.displayName) ||
    cleanText(user?.user_metadata?.display_name) ||
    cleanText(user?.email) ||
    '未命名用户'
}

function accountEmail({ user = null, profile = null } = {}) {
  return cleanText(user?.email) || cleanText(profile?.email) || cleanText(user?.phone) || cleanText(profile?.phone)
}

function accountAvatarUrl({ user = null, profile = null } = {}) {
  return cleanText(profile?.avatar_url) ||
    cleanText(profile?.avatarUrl) ||
    cleanText(user?.user_metadata?.avatar_url) ||
    cleanText(user?.user_metadata?.picture)
}

function accountInitial(name = '') {
  return cleanText(name).slice(0, 1).toUpperCase() || '?'
}

function routeEntryFromLocation(location) {
  return {
    path: `${location.pathname || '/'}${location.search || ''}${location.hash || ''}`,
    state: location.state || null,
  }
}

function routeEntriesMatch(a = null, b = null) {
  return Boolean(a && b && a.path === b.path)
}

function shouldRecordRouteEntry(entry = null) {
  if (!entry?.path) return false
  if (entry.path === '/projects' || entry.path.startsWith('/projects?') || entry.path.startsWith('/projects#')) return false
  return true
}

function internalBackRouteEntry(entry = null) {
  if (!entry?.path) return null
  let url = null
  try {
    url = new URL(entry.path, 'http://uniopc.local')
  } catch {
    return null
  }
  const isCloudDocuments = url.pathname === '/cloud-documents' ||
    (url.pathname.startsWith('/profiles/') && url.pathname.includes('/cloud-documents'))
  if (!isCloudDocuments) return null
  if (!url.searchParams.has('document') && !url.searchParams.has('new')) return null
  url.searchParams.delete('document')
  url.searchParams.delete('new')
  return {
    path: `${url.pathname}${url.search}${url.hash}`,
    state: entry.state || null,
  }
}

export default function Layout() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { user, profile } = useAuth()
  const runtimeCleanupWarning = useRuntimeStatusStore().openClaw.status?.runtimeCleanupWarning
  const profileBase = profileRouteBase(location.pathname)
  const profileRouteState = location.state?.profileWorkspace
    ? profileWorkspaceNavigationState({ ...location.state.profileWorkspace, isAdminSession: true })
    : undefined
  const profileRoutePath = childPath => {
    const child = String(childPath || '').replace(/^\/+/, '')
    return profileBase ? `${profileBase}/${child}` : `/profiles/me/${child}`
  }
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Always launch expanded (icons + labels). Collapsing is an in-session action
  // and is intentionally not restored across launches.
  const [collapsed, setCollapsed] = useState(false)
  // Shared state for the 产物 hub: the titlebar toggle and the docked panel.
  const artifactsHub = useGlobalArtifacts()
  const lastRouteEntryRef = useRef(null)
  const backStackRef = useRef([])
  const forwardStackRef = useRef([])
  const pendingHistoryMoveRef = useRef(null)
  const [routeHistoryState, setRouteHistoryState] = useState({ canBack: false, canForward: false })
  const [llmBalance, setLlmBalance] = useState(null)

  // Keep the sidebar credit balance roughly live: refresh on mount, on route
  // change, and on a light interval. Only users who use the official model have
  // a wallet, so a null balance simply renders nothing.
  useEffect(() => {
    if (!user?.uid && !user?.id) return undefined
    let cancelled = false
    const refresh = () => {
      fetchLlmCreditBalance()
        .then(balance => { if (!cancelled && typeof balance === 'number') setLlmBalance(balance) })
        .catch(() => null)
    }
    refresh()
    const timer = window.setInterval(refresh, 60000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [user?.uid, user?.id, location.pathname])

  function updateRouteHistoryState() {
    setRouteHistoryState({
      canBack: backStackRef.current.length > 0,
      canForward: forwardStackRef.current.length > 0,
    })
  }

  useEffect(() => {
    const entry = routeEntryFromLocation(location)
    const lastEntry = lastRouteEntryRef.current
    if (!lastEntry) {
      lastRouteEntryRef.current = entry
      updateRouteHistoryState()
      return
    }
    if (routeEntriesMatch(lastEntry, entry)) return
    if (pendingHistoryMoveRef.current) {
      pendingHistoryMoveRef.current = null
      lastRouteEntryRef.current = entry
      updateRouteHistoryState()
      return
    }
    if (shouldRecordRouteEntry(lastEntry)) {
      backStackRef.current = backStackRef.current.filter(item => !routeEntriesMatch(item, lastEntry))
      backStackRef.current.push(lastEntry)
    }
    forwardStackRef.current = []
    lastRouteEntryRef.current = entry
    updateRouteHistoryState()
  }, [location])

  function navigateToHistoryEntry(entry) {
    navigate(entry.path, { state: entry.state || undefined })
  }

  function navigateBackInApp() {
    const current = lastRouteEntryRef.current
    const internalTarget = internalBackRouteEntry(current)
    if (internalTarget) {
      if (shouldRecordRouteEntry(current)) forwardStackRef.current.push(current)
      pendingHistoryMoveRef.current = 'back'
      updateRouteHistoryState()
      navigateToHistoryEntry(internalTarget)
      return
    }
    const target = backStackRef.current.pop()
    if (!target) return
    if (shouldRecordRouteEntry(current)) forwardStackRef.current.push(current)
    pendingHistoryMoveRef.current = 'back'
    updateRouteHistoryState()
    navigateToHistoryEntry(target)
  }

  function navigateForwardInApp() {
    const target = forwardStackRef.current.pop()
    if (!target) return
    const current = lastRouteEntryRef.current
    if (shouldRecordRouteEntry(current)) backStackRef.current.push(current)
    pendingHistoryMoveRef.current = 'forward'
    updateRouteHistoryState()
    navigateToHistoryEntry(target)
  }

  function toggleCollapsed() {
    setCollapsed(prev => !prev)
  }

  const navGroups = useMemo(() => {
    return [
      {
        title: t('nav.groupWork'),
        items: [
        {
          to: profileRoutePath('conversations'),
          label: t('nav.conversations'),
          exact: true,
          icon: (
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 9.75a.375.375 0 11-.75 0 .375.375 0 01.75 0zm3.75 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm3.75 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 12c0 4.142-4.03 7.5-9 7.5a10.58 10.58 0 01-3.626-.63L3 21l1.932-4.186C3.72 15.52 3 13.85 3 12c0-4.142 4.03-7.5 9-7.5s9 3.358 9 7.5z" />
            </svg>
          ),
        },
        {
          to: profileRoutePath('cloud-documents'),
          label: t('nav.cloudDocuments'),
          exact: true,
          icon: (
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 3.75h6.75L19.5 9v9.75A1.5 1.5 0 0118 20.25H7.5A1.5 1.5 0 016 18.75V5.25A1.5 1.5 0 017.5 3.75z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 3.75V9h5.25M9 13.5h6M9 16.5h4.5" />
            </svg>
          ),
        },
        // 定时任务紧跟对话:它就是「给 AI 员工排班」,和对话是同一批员工、同一个引擎,
        // 只是把「现在做」换成「按时做」。放在插件之前,因为它是日常使用面而非配置面。
        {
          to: profileRoutePath('automations'),
          label: t('nav.automations'),
          exact: true,
          icon: (
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="8.25" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5V12l3 1.75" />
            </svg>
          ),
        },
        {
          to: '/plugins',
          label: t('nav.plugins'),
          matches: pathname => pathname.startsWith('/mcphub') ||
            (pathname.startsWith('/profiles/') && (pathname.includes('/plugins') || pathname.includes('/mcphub'))),
          icon: (
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 01-.657.643 48.39 48.39 0 01-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 01-.658.663v0c-.355 0-.676-.186-.959-.401-.29-.221-.634-.349-1.003-.349-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 01-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 00.657-.643v0c0-.355-.186-.676-.401-.959-.221-.29-.349-.633-.349-1.003 0-1.035 1.007-1.875 2.25-1.875s2.25.84 2.25 1.875c0 .37-.128.713-.349 1.003-.215.283-.401.604-.401.959v0a.64.64 0 00.657.643 48.39 48.39 0 004.163-.3c-.186-1.613-.293-3.25-.315-4.907a.656.656 0 01.658-.663v0c.355 0 .676.186.959.401.29.221.634.349 1.003.349 1.035 0 1.875-1.007 1.875-2.25s-.84-2.25-1.875-2.25c-.37 0-.713.128-1.003.349-.283.215-.604.401-.959.401v0a.656.656 0 01-.658-.663 48.389 48.389 0 00-.37-5.36c-1.227.09-2.463.17-3.706.24z" />
            </svg>
          ),
        },
        // 应用紧跟插件:插件是能力来源,应用是用这些能力做出来的成品工作台
        // (超级IP / 字幕提取 / 公域获客 / 同行监听 / 私域转化),与小程序「应用」tab 同源。
        {
          to: '/apps',
          label: t('nav.applications'),
          matches: pathname => pathname.startsWith('/apps'),
          icon: (
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
              <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
              <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
              <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
              <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
            </svg>
          ),
        },
        // 移动端放在「工作」组末尾:它是一次性的配对设置,不是日常使用的工作区。
        {
          to: profileRoutePath('mobile'),
          label: t('nav.mobile'),
          exact: true,
          icon: (
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
              <rect x="7" y="3" width="10" height="18" rx="2" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 18h2" />
            </svg>
          ),
        },
      ].filter(Boolean),
    },
  ].filter(group => group.items.length > 0)
  }, [profileBase, t])

  const flatNavItems = useMemo(() => navGroups.flatMap(group => group.items), [navGroups])
  const currentTitle = deriveRouteTitle(location.pathname, flatNavItems, t)
  const accountName = accountDisplayName({ user, profile })
  const accountSubtitle = accountEmail({ user, profile })
  const accountAvatar = accountAvatarUrl({ user, profile })
  const accountTooltip = accountSubtitle ? `${accountName} · ${accountSubtitle}` : accountName
  const sidebarWidth = collapsed ? 'w-[68px]' : 'w-[186px]'
  const contentIsFullBleed = location.pathname.startsWith('/conversations') || (
    location.pathname.startsWith('/profiles/') && location.pathname.includes('/conversations')
  )

  return (
    <VoiceToDocumentSessionProvider>
    <div className="relative flex h-screen flex-col overflow-hidden bg-surface-base text-primary">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-[70] h-[36px] bg-transparent">
        <div
          data-tauri-drag-region
          onMouseDown={startWindowDrag}
          className="pointer-events-auto absolute inset-0 z-0"
        />
        <div className={`pointer-events-auto absolute top-[7px] z-10 hidden items-center gap-3 md:flex ${HAS_INAPP_WINDOW_CONTROLS ? 'left-[16px]' : 'left-[84px]'}`}>
          <TitlebarIconButton
            onClick={toggleCollapsed}
            title={collapsed ? '展开侧边栏' : '收起侧边栏'}
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <rect x="4.25" y="4.75" width="15.5" height="14.5" rx="2.25" />
              <path strokeLinecap="round" d="M9.25 5v14" />
            </svg>
          </TitlebarIconButton>
          <TitlebarIconButton
            onClick={navigateBackInApp}
            title="上一页"
            disabled={!routeHistoryState.canBack}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.9} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
          </TitlebarIconButton>
          <TitlebarIconButton
            onClick={navigateForwardInApp}
            title="下一页"
            disabled={!routeHistoryState.canForward}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.9} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
          </TitlebarIconButton>
        </div>
        <div
          data-tauri-drag-region
          onMouseDown={startWindowDrag}
          title={currentTitle}
          className={`pointer-events-auto absolute top-[8px] z-10 hidden max-w-[320px] items-center gap-2 text-sm font-medium leading-5 text-primary md:flex ${collapsed ? 'left-[184px]' : 'left-[206px]'}`}
        >
          <span className="max-w-[220px] truncate" title={currentTitle}>{currentTitle}</span>
          <span className={`rounded border px-1.5 py-px text-[10px] font-medium leading-4 ${import.meta.env.DEV ? 'border-amber-400/50 bg-amber-400/10 text-amber-700 dark:text-amber-300' : 'border-emerald-400/50 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300'}`}>
            {BUILD_FLAVOR}
          </span>
        </div>
        <AppUpdateTitlebarControl
          channel={UPDATE_CHECK_CHANNEL}
          rightClassName={HAS_INAPP_WINDOW_CONTROLS ? 'right-[188px]' : 'right-[52px]'}
        />
        <GlobalArtifactsToggle hub={artifactsHub} rightClassName={HAS_INAPP_WINDOW_CONTROLS ? 'right-[156px]' : 'right-[18px]'} />
        {HAS_INAPP_WINDOW_CONTROLS && <WindowsWindowControls />}
      </div>

      {runtimeCleanupWarning && (
        <div role="status" className="mx-4 mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-primary">
          {runtimeCleanupWarning}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
      {sidebarOpen && (
        <div
          className="fixed inset-x-0 bottom-0 top-[56px] z-40 bg-scrim backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`
          fixed bottom-0 left-0 top-[56px] z-50 flex ${sidebarWidth} flex-col bg-surface-base
          transition-[transform,width] duration-200
          md:static md:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <div className="flex-1 overflow-y-auto px-2.5 pb-3.5 pt-3.5 md:pt-[56px]">
          <div className="space-y-4">
            {navGroups.map(group => (
              <section key={group.title || group.items.map(item => item.to).join('|')}>
                {!collapsed && group.title && (
                  <div className="px-3 pb-1.5 text-2xs font-medium tracking-[0.08em] text-tertiary">
                    {group.title}
                  </div>
                )}
                <div className="space-y-1">
                  {group.items.map(item => {
                    const itemClassName = isActive => `
                      flex items-center ${collapsed ? 'justify-center px-2 py-2.25 text-sm' : item.compact ? 'gap-2 px-2.5 py-1.5 text-xs' : 'gap-3 px-3 py-2.25 text-sm'} transition-colors
                      rounded-lg
                      ${isActive
                        ? 'bg-surface-float text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
                        : 'text-secondary hover:bg-state-hover hover:text-primary'}
                    `
                    const itemContent = isActive => (
                      <>
                        {!item.hideIcon && item.icon && (
                          <NavIcon compact={item.compact}>
                            <span className={isActive ? 'text-violet-400' : 'text-secondary'}>
                              {item.icon}
                            </span>
                          </NavIcon>
                        )}
                        {!collapsed && <span className={`truncate ${item.labelClassName || ''}`}>{item.label}</span>}
                      </>
                    )

                    return (
                    <div key={item.to}>
                      <NavLink
                        to={item.to}
                        state={item.to.startsWith('/profiles/') ? profileRouteState : undefined}
                        end={item.exact}
                        onClick={() => setSidebarOpen(false)}
                        title={collapsed ? item.label : undefined}
                        className={({ isActive }) => itemClassName(isActive || Boolean(item.matches?.(location.pathname)))}
                      >
                        {({ isActive }) => {
                          const active = isActive || Boolean(item.matches?.(location.pathname))
                          return itemContent(active)
                        }}
                      </NavLink>
                    </div>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>

        </div>

        <div className="shrink-0 border-t border-subtle px-2.5 py-2.5">
          <div className={`flex items-center ${collapsed ? 'flex-col gap-1.5' : 'gap-1.5'}`}>
            <NavLink
              to={profileRoutePath('settings/profile')}
              state={profileRouteState}
              title={accountTooltip}
              aria-label={accountTooltip}
              className={({ isActive }) => `
                sidebar-account-row flex min-h-[44px] min-w-0 flex-1 items-center rounded-lg transition-colors
                ${collapsed ? 'w-full justify-center px-2' : 'gap-2.5 px-2.5'}
                ${isActive ? 'bg-surface-float text-primary' : 'text-secondary hover:bg-state-hover hover:text-primary'}
              `}
            >
              <span className="sidebar-account-avatar flex h-[28px] w-[28px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-violet-400/14 text-2xs font-semibold text-accent-text ring-1 ring-white/8">
                {accountAvatar ? (
                  <img src={accountAvatar} alt={accountName} className="h-full w-full object-cover" />
                ) : (
                  accountInitial(accountName)
                )}
              </span>
              {!collapsed && (
                <span className="min-w-0 flex-1">
                  <span className="sidebar-account-name block truncate text-sm font-medium text-primary">
                    {accountName}
                  </span>
                  {llmBalance != null && (
                    <span className="mt-0.5 inline-flex items-center gap-0.5 rounded-full bg-violet-400/12 px-1.5 py-px text-2xs font-medium text-accent-text ring-1 ring-violet-300/20">
                      <span aria-hidden="true">⚡</span>
                      {Math.round(llmBalance * 100) / 100} credits
                    </span>
                  )}
                </span>
              )}
            </NavLink>
            <NavLink
              to={profileRoutePath('settings')}
              state={profileRouteState}
              title={t('nav.settings')}
              aria-label={t('nav.settings')}
              className={({ isActive }) => `
                flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors
                ${isActive ? 'bg-surface-float text-primary' : 'text-secondary hover:bg-state-hover hover:text-primary'}
              `}
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </NavLink>
          </div>
        </div>

      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-surface-base">
        <header className="flex h-14 items-center border-b border-subtle bg-surface-base px-4 md:hidden">
          <button onClick={() => setSidebarOpen(true)} className="-ml-2 rounded-md p-2 text-secondary transition-colors hover:bg-state-hover hover:text-primary">
            <svg className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="ml-3">
            <div className="text-sm font-medium text-primary">{currentTitle}</div>
          </div>
        </header>

        <main className="flex-1 overflow-hidden bg-surface-base pl-0 pr-3 pb-3 pt-[36px]">
          <div className="flex h-full overflow-hidden rounded-xl border border-subtle bg-surface-raised shadow-[var(--ui-shadow-frame)]">
            <div className={`h-full min-w-0 flex-1 ${contentIsFullBleed ? 'overflow-hidden p-0' : 'overflow-auto p-5'}`}>
              <Outlet />
            </div>
            {/* 产物 panel is docked inside the same frame, split from the content
                by a vertical divider line (no gap). */}
            <GlobalArtifactsPanel hub={artifactsHub} />
          </div>
        </main>
      </div>

      </div>
    </div>
    </VoiceToDocumentSessionProvider>
  )
}
