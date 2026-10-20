function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '')
}

export function titlebarAppUpdateViewModel({
  currentVersion = '',
  latestVersion = '',
  available = false,
  busy = false,
  installed = false,
} = {}) {
  if (installed) {
    return {
      kind: 'restarting',
      label: '重启中...',
      actionable: false,
      disabled: true,
    }
  }

  if (available) {
    return {
      kind: 'update',
      label: busy ? '更新中...' : '更新',
      actionable: true,
      disabled: busy,
    }
  }

  const version = normalizeVersion(currentVersion || latestVersion)
  return {
    kind: 'version',
    label: version ? `v${version}` : '',
    actionable: false,
    disabled: false,
  }
}
