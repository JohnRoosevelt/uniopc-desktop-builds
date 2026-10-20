export function buildEmployeeCreatePath() {
  return '/employees?create=1'
}

export function shouldOpenEmployeeCreateFromSearch(searchParams) {
  if (!searchParams) return false
  const params =
    searchParams instanceof URLSearchParams
      ? searchParams
      : new URLSearchParams(String(searchParams).replace(/^\?/, ''))
  return params.get('create') === '1'
}
