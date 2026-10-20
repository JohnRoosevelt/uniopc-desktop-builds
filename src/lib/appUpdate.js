import { getVersion } from '@tauri-apps/api/app'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

const DESKTOP_UPDATER_ENDPOINT = 'https://spb-bp1f48p09a51z42o.supabase.opentrust.net/functions/v1/desktop-updater'
const DEFAULT_UPDATE_CHANNEL = 'stable'
const LATEST_VERSION_PROBE = '0.0.0'

// The Supabase gateway rejects /functions/v1/* without an apikey, even for
// no-verify-jwt functions. Send the (public) anon key on updater probes.
function updaterAuthHeaders() {
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!anonKey) return {}
  return { apikey: anonKey, Authorization: `Bearer ${anonKey}` }
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '')
}

export function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split(/[.-]/)
  const rightParts = normalizeVersion(right).split(/[.-]/)
  const maxLength = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] || '0'
    const rightPart = rightParts[index] || '0'
    const leftNumber = Number.parseInt(leftPart, 10)
    const rightNumber = Number.parseInt(rightPart, 10)

    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1
      continue
    }

    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1
  }

  return 0
}

export function isVersionNewer(latestVersion, currentVersion) {
  if (!latestVersion || !currentVersion) return false
  return compareVersions(latestVersion, currentVersion) > 0
}

function updaterTarget() {
  if (navigator.userAgent.includes('Mac')) return 'darwin'
  if (navigator.userAgent.includes('Windows')) return 'windows'
  return 'linux'
}

function updaterArch() {
  const platform = navigator.userAgentData?.platform || navigator.platform || ''
  const userAgent = navigator.userAgent || ''
  if (/arm|aarch64/i.test(platform) || /arm|aarch64/i.test(userAgent)) return 'aarch64'
  return 'x86_64'
}

function candidateArchs(target, arch) {
  if (target !== 'darwin') return [arch]
  return Array.from(new Set([arch, 'aarch64', 'x86_64']))
}

export async function fetchLatestAppUpdateMetadata({
  target = updaterTarget(),
  arch = updaterArch(),
  channel = DEFAULT_UPDATE_CHANNEL,
} = {}) {
  let lastError = null
  let latest = null
  for (const candidateArch of candidateArchs(target, arch)) {
    const url = `${DESKTOP_UPDATER_ENDPOINT}/${target}/${candidateArch}/${LATEST_VERSION_PROBE}?channel=${encodeURIComponent(channel)}`
    try {
      const response = await fetch(url, { headers: { accept: 'application/json', ...updaterAuthHeaders() } })
      if (response.status === 204 || response.status === 404) continue
      if (!response.ok) throw new Error(`Uniopc 最新版本检查失败 (${response.status})`)
      const metadata = await response.json()
      if (!latest || isVersionNewer(metadata?.version, latest?.version)) {
        latest = metadata
      }
    } catch (error) {
      lastError = error
    }
  }
  if (latest) return latest
  if (lastError) throw lastError
  return null
}

export async function getAppUpdateStatus({ channel = DEFAULT_UPDATE_CHANNEL } = {}) {
  const currentVersion = await getVersion()
  const [latestResult, updateResult] = await Promise.allSettled([
    fetchLatestAppUpdateMetadata({ channel }),
    check(),
  ])

  const latest = latestResult.status === 'fulfilled' ? latestResult.value : null
  const update = updateResult.status === 'fulfilled' ? updateResult.value : null
  // The signed Tauri manifest is the only source that may make an update
  // actionable. `desktop-updater` is operational metadata; it can briefly be
  // ahead while a release is being promoted, but it cannot install anything.
  const latestVersion = update?.version || latest?.version || null
  const available = Boolean(update) && isVersionNewer(update.version, currentVersion)
  const pendingPublication = !update && isVersionNewer(latest?.version, currentVersion)

  if (!available) {
    if (latestResult.status === 'rejected' && updateResult.status === 'rejected') {
      throw updateResult.reason || latestResult.reason
    }
    return {
      currentVersion,
      latestVersion: latestVersion || currentVersion,
      available: false,
      version: latestVersion || currentVersion,
      notes: '',
      message: pendingPublication
        ? `Uniopc ${latest.version} 已登记，安装包正在发布；请稍后重新检查。`
        : 'Uniopc 已是最新版本。',
      update: null,
      updateCheckError: updateResult.status === 'rejected' ? String(updateResult.reason?.message || updateResult.reason || '') : '',
      pendingPublication,
    }
  }

  return {
    currentVersion,
    latestVersion,
    available: true,
    version: latestVersion,
    notes: update?.body || latest?.notes || '',
    message: `发现 Uniopc 新版本 ${latestVersion}。`,
    update,
    updateCheckError: updateResult.status === 'rejected' ? String(updateResult.reason?.message || updateResult.reason || '') : '',
    pendingPublication: false,
  }
}

// The updater bundle embeds the OpenClaw runtime (~130MB). Over the domestic
// reverse-proxy path this transfer is slow and reset-prone, so a single
// download attempt frequently fails ("error sending request for url").
const UPDATE_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000 // 30 min — sized for the big bundle on a slow link
const UPDATE_DOWNLOAD_MAX_ATTEMPTS = 4

export async function installAppUpdate(update, onEvent) {
  if (!update) throw new Error('没有可安装的 Uniopc 更新。')
  // Use the official split download()/install() API so a dropped download can be
  // retried WITHOUT reinstalling, and give the download phase its own generous
  // timeout — otherwise the (short) check() timeout is reused and prematurely
  // kills a large transfer (tauri-apps/plugins-workspace#2372). The official
  // updater has no resume, so each retry restarts the transfer.
  let lastError = null
  for (let attempt = 1; attempt <= UPDATE_DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      await update.download(onEvent, { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS })
      lastError = null
      break
    } catch (error) {
      lastError = error
      if (attempt < UPDATE_DOWNLOAD_MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
      }
    }
  }
  if (lastError) throw lastError
  await update.install()
}

export async function relaunchApp() {
  await relaunch()
}
