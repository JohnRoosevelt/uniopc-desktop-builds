export function isGeneratedEmployeeName(value) {
  const raw = String(value || '').trim()
  return /^employee-[a-z0-9-]{12,}$/i.test(raw)
}

export function displayEmployeeName(employee, fallback = '未命名员工') {
  const raw = String(employee?.name || '').trim()
  if (raw) return raw

  const role = String(employee?.role || '').trim()
  if (role && role !== 'AI员工' && role !== 'AI 员工') return role

  return fallback
}
