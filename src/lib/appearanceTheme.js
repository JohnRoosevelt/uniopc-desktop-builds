export const APPEARANCE_THEME_KEY = 'imai.appearance.theme'
export const APPEARANCE_THEMES = ['light', 'dark', 'system']

function normalizeTheme(value) {
  return APPEARANCE_THEMES.includes(value) ? value : 'system'
}

export function getStoredAppearanceTheme() {
  if (typeof window === 'undefined') return 'system'
  try {
    return normalizeTheme(window.localStorage.getItem(APPEARANCE_THEME_KEY))
  } catch {
    return 'system'
  }
}

export function resolveAppearanceTheme(theme = getStoredAppearanceTheme()) {
  const normalized = normalizeTheme(theme)
  if (normalized !== 'system') return normalized
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function applyAppearanceTheme(theme = getStoredAppearanceTheme()) {
  if (typeof document === 'undefined') return resolveAppearanceTheme(theme)
  const normalized = normalizeTheme(theme)
  const resolved = resolveAppearanceTheme(normalized)
  const root = document.documentElement

  root.dataset.appearanceTheme = normalized
  root.dataset.theme = resolved
  root.style.colorScheme = resolved

  return resolved
}

export function setStoredAppearanceTheme(theme) {
  const normalized = normalizeTheme(theme)
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(APPEARANCE_THEME_KEY, normalized)
    } catch {}
  }
  applyAppearanceTheme(normalized)
  return normalized
}

export function subscribeSystemAppearanceTheme(callback) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const media = window.matchMedia('(prefers-color-scheme: light)')
  const handleChange = () => callback(resolveAppearanceTheme('system'))

  if (media.addEventListener) {
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }

  media.addListener(handleChange)
  return () => media.removeListener(handleChange)
}
