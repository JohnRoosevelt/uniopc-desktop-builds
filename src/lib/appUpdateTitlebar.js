export function titlebarAppUpdateViewModel({ currentVersion = '', phase = 'idle', available = false, progress = '', error = '' } = {}) {
  const version = String(currentVersion || '').replace(/^v/i, '')
  const labels = {
    checking: '检查中...', latest: '已是最新版本 · 检查更新', pending: '安装包发布中 · 重新检查',
    downloading: progress || '正在下载更新...', installing: '正在安装更新...', restarting: '正在重启...',
    installed: '重启完成更新', error: '检查失败 · 重试', installError: '更新失败 · 重试',
  }
  const action = phase === 'installed' ? 'relaunch' : (available && !['checking', 'error'].includes(phase)) ? 'install' : 'check'
  return {
    label: `${version ? `v${version} · ` : ''}${labels[phase] || (available ? '更新' : '检查更新')}`,
    disabled: ['checking', 'downloading', 'installing', 'restarting'].includes(phase),
    action,
    error,
  }
}

// One synchronous owner for every entry point, independent of React render timing.
export function createAppUpdateController({ check, install, relaunch, isNewer, onChange }) {
  let active = true
  let locked = false
  let state = { phase: 'idle', currentVersion: '', available: false, update: null, error: '', confirmInstall: false }
  const publish = (patch) => {
    if (!active) return
    state = { ...state, ...patch }
    onChange(state)
  }
  const canInstall = (value) => Boolean(value?.update && value.available && !value.updateCheckError && isNewer(value.update.version, value.currentVersion))
  async function refresh() {
    if (!active || locked || state.confirmInstall || ['installed', 'restarting'].includes(state.phase)) return
    locked = true
    publish({ phase: 'checking', error: '' })
    try {
      const next = await check()
      if (!active) return
      if (next.updateCheckError) throw new Error(next.updateCheckError)
      const available = canInstall(next)
      publish({ ...next, available, update: available ? next.update : null, phase: next.pendingPublication ? 'pending' : available ? 'idle' : 'latest' })
    } catch (error) {
      publish({ phase: 'error', available: false, update: null, error: `检查更新失败：${error?.message || error}` })
    } finally { locked = false }
  }
  async function restart() {
    if (!active || locked || state.phase !== 'installed') return
    locked = true
    publish({ phase: 'restarting', error: '' })
    try { await relaunch() } catch (error) {
      publish({ phase: 'installed', error: `更新已安装，重启失败：${error?.message || error}` })
    } finally { locked = false }
  }
  async function confirm() {
    if (!active || locked || !state.confirmInstall || !canInstall(state)) return
    locked = true
    publish({ confirmInstall: false, phase: 'downloading', error: '', progress: '' })
    let downloaded = 0
    let total = 0
    try {
      await install(state.update, (event) => {
        if (event.event === 'Started') {
          downloaded = 0
          total = event.data?.contentLength || 0
          publish({ phase: 'downloading', progress: '' })
        } else if (event.event === 'Progress') {
          downloaded += event.data?.chunkLength || 0
          publish({ progress: total > 0 ? `正在下载 ${Math.min(100, Math.floor(downloaded / total * 100))}%` : '正在下载更新...' })
        } else if (event.event === 'Finished') publish({ phase: 'installing', progress: '' })
      })
      if (!active) return
      publish({ phase: 'installed', progress: '' })
      locked = false
      await restart()
    } catch (error) {
      publish({ phase: 'installError', error: `安装更新失败：${error?.message || error}` })
    } finally { locked = false }
  }
  return {
    refresh, confirm,
    setVersion: (currentVersion) => publish({ currentVersion: state.currentVersion || currentVersion }),
    cancel: () => { if (!locked) publish({ confirmInstall: false }) },
    click: () => {
      if (!active || locked) return
      if (state.phase === 'installed') return restart()
      if (canInstall(state)) publish({ confirmInstall: true })
      else return refresh()
    },
    dispose: () => { active = false },
  }
}
