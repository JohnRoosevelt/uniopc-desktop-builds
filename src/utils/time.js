import i18next from 'i18next'

const MONTH_NAMES_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Relative time
 * e.g. "Just now", "3 min ago", "Yesterday", "Jan 15"
 */
export function relativeTime(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diff = Math.floor((now - date) / 1000)

  if (diff < 60) return i18next.t('time.just_now')
  if (diff < 3600) return i18next.t('time.minutes_ago', { count: Math.floor(diff / 60) })
  if (diff < 86400) return i18next.t('time.hours_ago', { count: Math.floor(diff / 3600) })
  if (diff < 172800) return i18next.t('time.yesterday')

  const month = date.getMonth()
  const day = date.getDate()
  if (i18next.language === 'zh') return i18next.t('time.date_format', { month: month + 1, day })
  return `${MONTH_NAMES_EN[month]} ${day}`
}

/**
 * Format date
 * e.g. "Jan 15" or "Jan 15 14:00"
 */
export function formatDate(dateStr, includeTime = false) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const month = date.getMonth()
  const day = date.getDate()

  let base
  if (i18next.language === 'zh') {
    base = i18next.t('time.date_format', { month: month + 1, day })
  } else {
    base = `${MONTH_NAMES_EN[month]} ${day}`
  }

  if (!includeTime) return base
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${base} ${hours}:${minutes}`
}
