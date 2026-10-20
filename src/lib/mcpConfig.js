export const MCP_TRANSPORTS = [
  { id: 'stdio', label: 'Stdio' },
  { id: 'sse', label: 'SSE / HTTP' },
  { id: 'streamable-http', label: 'Streamable HTTP' },
]

export function parseKeyValueLines(text = '') {
  const result = {}
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const index = line.indexOf('=')
    if (index <= 0) {
      throw new Error('请输入 KEY=value 格式。')
    }
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (!key) throw new Error('请输入 KEY=value 格式。')
    if (!value) continue
    result[key] = value
  }
  return result
}

export function keyValueTextToRows(text = '', defaultNames = []) {
  const rows = String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const index = line.indexOf('=')
      if (index < 0) return { name: line, value: '' }
      return {
        name: line.slice(0, index).trim(),
        value: line.slice(index + 1).trim(),
      }
    })
    .filter(row => row.name || row.value)

  if (rows.length > 0) return rows
  const defaults = defaultNames
    .map(name => String(name || '').trim())
    .filter(Boolean)
    .map(name => ({ name, value: '' }))
  return defaults.length > 0 ? defaults : [{ name: '', value: '' }]
}

export function keyValueRowsToText(rows = []) {
  return rows
    .map(row => ({
      name: String(row?.name || '').trim(),
      value: String(row?.value || '').trim(),
    }))
    .filter(row => row.name || row.value)
    .map(row => {
      if (!row.name) throw new Error('Name 不能为空。')
      if (!row.value) return ''
      return `${row.name}=${row.value}`
    })
    .filter(Boolean)
    .join('\n')
}

export function stringifyKeyValueMap(map = {}) {
  return Object.entries(map || {})
    .filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

export function parseArgs(text = '') {
  return String(text || '')
    .split('\n')
    .map(item => item.trim())
    .filter(Boolean)
}

export function inferMcpTransport(config = {}) {
  if (config.command) return 'stdio'
  if (config.transport === 'streamable-http' || config.type === 'http') return 'streamable-http'
  return 'sse'
}

export function emptyMcpForm() {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    argsText: '',
    envText: '',
    cwd: '',
    url: '',
    headersText: '',
    connectionTimeoutMs: '',
  }
}

export function configToForm(config = {}, name = '') {
  const transport = inferMcpTransport(config)
  return {
    name,
    transport,
    command: config.command || '',
    argsText: Array.isArray(config.args) ? config.args.join('\n') : '',
    envText: stringifyKeyValueMap(config.env),
    cwd: config.cwd || config.workingDirectory || '',
    url: config.url || '',
    headersText: stringifyKeyValueMap(config.headers),
    connectionTimeoutMs: config.connectionTimeoutMs ? String(config.connectionTimeoutMs) : '',
  }
}

export function buildMcpConfigFromForm(form) {
  if (form.transport === 'stdio') {
    const config = { command: String(form.command || '').trim() }
    const args = parseArgs(form.argsText)
    const env = parseKeyValueLines(form.envText)
    const cwd = String(form.cwd || '').trim()
    if (args.length > 0) config.args = args
    if (Object.keys(env).length > 0) config.env = env
    if (cwd) config.cwd = cwd
    return config
  }

  const config = { url: String(form.url || '').trim() }
  const headers = parseKeyValueLines(form.headersText)
  if (form.transport === 'streamable-http') config.transport = 'streamable-http'
  if (Object.keys(headers).length > 0) config.headers = headers
  const timeoutText = String(form.connectionTimeoutMs || '').trim()
  if (timeoutText) {
    const timeout = Number(timeoutText)
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new Error('connectionTimeoutMs 必须是正整数。')
    }
    config.connectionTimeoutMs = timeout
  }
  return config
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = stableJson(value[key])
      return result
    }, {})
}

export function mcpConfigEquivalent(left, right) {
  return JSON.stringify(stableJson(left || {})) === JSON.stringify(stableJson(right || {}))
}

export function maskSecretValue(key, value) {
  const lower = String(key || '').toLowerCase()
  const raw = String(value || '')
  if (!/(token|secret|key|authorization)/.test(lower) && !raw.startsWith('Bearer ')) return raw
  if (raw.startsWith('Bearer ')) return 'Bearer ******'
  if (raw.length <= 4) return '******'
  return `${raw.slice(0, 2)}******${raw.slice(-2)}`
}
