import { fetchOpenClawEmployees } from './openclawEmployees.js'

export function normalizeEmployeeProfile(profile = null) {
  const value = typeof profile === 'string' ? profile.trim() : ''
  return value || null
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows : []
}

// AI employees are a personal Owner resource. Project assignees and project
// member pools intentionally do not participate in loading the directory.
export async function loadEmployeeDirectory({
  profile = null,
  force = false,
  source = 'runtime',
  loadCloudEmployees = null,
  fetchEmployees = fetchOpenClawEmployees,
  syncCloudEmployees = null,
} = {}) {
  const normalizedProfile = normalizeEmployeeProfile(profile)

  if (source === 'cloud') {
    const employees = normalizeRows(await loadCloudEmployees?.())
    return {
      profile: normalizedProfile,
      employees,
      cachedEmployees: [],
      hadCachedRows: false,
      source: 'cloud',
    }
  }

  const employees = normalizeRows(await fetchEmployees({
    force: Boolean(force),
    profile: normalizedProfile,
    syncCloudEmployees,
  }))

  return {
    profile: normalizedProfile,
    employees,
    cachedEmployees: [],
    hadCachedRows: false,
    source: 'runtime',
  }
}
