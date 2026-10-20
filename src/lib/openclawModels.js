const PROVIDER_LABELS = {
  'uniopc-official': 'Uniopc 官方模型',
  'openai-codex': 'OpenAI Codex 订阅',
  openai: 'OpenAI API Key',
  'minimax-portal': 'MiniMax 订阅',
  qwen: 'Qwen Coding Plan',
  'bailian-token-plan': '阿里云百炼 Token Plan',
  zai: 'Z.AI / GLM Coding Plan',
  anthropic: 'Anthropic Claude',
  'github-copilot': 'GitHub Copilot',
  google: 'Google Gemini',
  'google-gemini-cli': 'Google Gemini CLI',
  deepseek: 'DeepSeek API Key',
  'kimi-code': 'Kimi Code',
}

const BLOCKED_PROVIDER_STATUSES = new Set(['cooldown', 'disabled', 'expired', 'missing'])
const UNDER_REPORTED_DEFAULT_PROVIDERS = new Set(['qwen', 'bailian-token-plan'])

export const MODEL_SETUP_OPTIONS = [
  {
    id: 'uniopc-official',
    label: 'Uniopc 官方模型',
    description: '默认接入 Uniopc 官方模型，赠送体验额度，无需自备 API Key。',
    provider: 'uniopc-official',
    authType: 'official',
    defaultModel: 'uniopc-official/uniopc-default',
    fields: [],
  },
  {
    id: 'openai-codex',
    label: 'OpenAI Codex 订阅',
    description: '登录 Codex/OpenAI 账号，不需要单独保存 API Key。',
    provider: 'openai-codex',
    authType: 'oauth',
    defaultModel: 'openai/gpt-5.5',
    fields: [],
  },
  {
    id: 'minimax-oauth-cn',
    label: 'MiniMax 订阅登录',
    description: '使用 MiniMax 中国区 OAuth 订阅账号。',
    provider: 'minimax-portal',
    authType: 'oauth',
    defaultModel: 'minimax-portal/MiniMax-M2.7',
    fields: [],
  },
  {
    id: 'bailian-token-plan-cn',
    label: '阿里云百炼 Token Plan',
    description: '使用阿里云百炼 Uniopc 引擎 Token Plan 订阅 Key，走中国区 compatible-mode endpoint。',
    provider: 'bailian-token-plan',
    authType: 'api_key',
    defaultModel: 'bailian-token-plan/qwen3.7-plus',
    fields: ['apiKey'],
  },
  {
    id: 'qwen-coding-cn',
    label: 'Qwen Coding Plan 订阅',
    description: '适合 Uniopc 引擎 官方 Qwen provider 的 Coding Plan 用户；百炼 Token Plan 请选上面的阿里云百炼入口。',
    provider: 'qwen-coding-cn',
    authType: 'api_key',
    defaultModel: 'qwen/qwen3.7-plus',
    fields: ['apiKey'],
  },
  {
    id: 'qwen-standard-cn',
    label: 'Qwen 标准 API Key',
    description: '使用阿里云百炼普通 API Key，走按量付费，不消耗 Coding Plan 订阅。',
    provider: 'qwen-standard-cn',
    authType: 'api_key',
    defaultModel: 'qwen/qwen3.7-plus',
    fields: ['apiKey'],
  },
  {
    id: 'zai-coding-cn',
    label: 'Z.AI / GLM Coding Plan 中国区',
    description: '适合已购买 Z.AI / GLM Coding Plan 的用户。',
    provider: 'zai',
    authType: 'api_key',
    defaultModel: 'zai/glm-5',
    fields: ['apiKey'],
  },
  {
    id: 'kimi-code',
    label: 'Kimi Code',
    description: '适合已有 Kimi Code 订阅 API Key 的用户。',
    provider: 'kimi-code',
    authType: 'api_key',
    defaultModel: 'kimi-code/kimi-k2.5',
    fields: ['apiKey'],
    disabled: true,
  },
  {
    id: 'openai-api',
    label: 'OpenAI API Key',
    description: '使用 OpenAI API Key 调用 GPT 模型。',
    provider: 'openai',
    authType: 'api_key',
    defaultModel: 'openai/gpt-5.4',
    fields: ['apiKey'],
  },
  {
    id: 'anthropic-api',
    label: 'Anthropic API Key',
    description: '使用 Anthropic API Key 调用 Claude 模型。',
    provider: 'anthropic',
    authType: 'api_key',
    defaultModel: 'anthropic/claude-sonnet-4-6',
    fields: ['apiKey'],
  },
  {
    id: 'deepseek-api',
    label: 'DeepSeek API Key',
    description: '使用 DeepSeek API Key；这是普通 API 计费，不是订阅登录。',
    provider: 'deepseek',
    authType: 'api_key',
    defaultModel: 'deepseek/deepseek-v4-flash',
    fields: ['apiKey'],
  },
]

export function getModelSetupOption(id) {
  return MODEL_SETUP_OPTIONS.find(option => option.id === id) || MODEL_SETUP_OPTIONS[0]
}

export function modelSetupOptionsForSelect() {
  return MODEL_SETUP_OPTIONS
}

export function formatOpenClawModelLabel(modelRef) {
  const raw = String(modelRef || '').trim()
  if (!raw) return '未设置'

  const [provider, ...modelParts] = raw.split('/')
  const model = modelParts.join('/')
  if (!provider || !model) return raw

  if (raw === 'openai/gpt-5.5') return `OpenAI Codex 订阅 · ${model}`

  return `${PROVIDER_LABELS[provider] || provider} · ${model}`
}

function providerFromModelRef(modelRef) {
  const raw = String(modelRef || '').trim()
  if (!raw.includes('/')) return ''
  return raw.split('/')[0]
}

function modelNameFromRef(modelRef) {
  const raw = String(modelRef || '').trim()
  if (!raw.includes('/')) return raw || '未设置'
  return raw.split('/').slice(1).join('/') || raw
}

function defaultModelRefFromSnapshot(snapshot, fallbackModelRef = '') {
  return String(
    snapshot?.resolvedDefaultModel ||
      snapshot?.primaryModel ||
      fallbackModelRef ||
      '',
  ).trim()
}

function shouldKeepProfileDefaultModel(snapshot, modelRef) {
  const ref = String(modelRef || '').trim()
  if (!ref) return false
  const provider = providerFromModelRef(ref)
  const runtimeCompatReady = snapshot?.runtimeCompatReady ?? true
  const authProfileReady = runtimeCompatReady !== false && providerReadyFromAuthProfiles(snapshot, provider)
  if (!authProfileReady && !UNDER_REPORTED_DEFAULT_PROVIDERS.has(provider)) return false
  const entry = (Array.isArray(snapshot?.models) ? snapshot.models : [])
    .find(model => String(model?.modelRef || '').trim() === ref)
  const providerStatus = String(entry?.providerStatus || '').trim()
  return !BLOCKED_PROVIDER_STATUSES.has(providerStatus)
}

export function connectedModelSources(snapshot, status) {
  const currentModel = String(
    status?.resolvedDefaultModel ||
      status?.defaultModel ||
      snapshot?.resolvedDefaultModel ||
      snapshot?.primaryModel ||
      '',
  ).trim()
  const currentProvider = providerFromModelRef(currentModel)
  const runtimeCompatReady = snapshot?.runtimeCompatReady ?? true
  const connected = []
  const pushSource = source => {
    if (!source?.id || connected.some(item => item.id === source.id)) return
    connected.push(source)
  }

  for (const provider of Array.isArray(snapshot?.providers) ? snapshot.providers : []) {
    if (!provider?.ready) continue
    const id = String(provider.id || '').trim()
    if (!id) continue
    if (id === 'openai-codex' && runtimeCompatReady === false) continue
    const current = id === currentProvider
    pushSource({
      id,
      label: provider.label || PROVIDER_LABELS[id] || id,
      modelRef: current ? currentModel : provider.recommendedModel || '',
      current,
      status: '已连接',
    })
  }

  if (connected.length === 0 && currentModel && status?.providerReady) {
    pushSource({
      id: currentProvider || currentModel,
      label: PROVIDER_LABELS[currentProvider] || currentProvider || currentModel,
      modelRef: currentModel,
      current: true,
      status: '已连接',
    })
  }

  return connected
}

function authProfileLabels(snapshotOrStatus) {
  const labels = snapshotOrStatus?.authProfileLabels
  return Array.isArray(labels) ? labels.map(label => String(label || '').trim()).filter(Boolean) : []
}

function authProviderPrefixes(provider) {
  return provider === 'openai-codex' ? ['openai-codex:', 'openai:'] : [`${provider}:`]
}

export function readyAuthProfileLabelsForProvider(snapshotOrStatus, provider) {
  const prefixes = authProviderPrefixes(provider)
  return authProfileLabels(snapshotOrStatus)
    .filter(label => prefixes.some(prefix => label.startsWith(prefix)))
    .filter(label => !/\[[^\]]+]/.test(label))
}

export function providerReadyFromAuthProfiles(snapshotOrStatus, provider) {
  return readyAuthProfileLabelsForProvider(snapshotOrStatus, provider).length > 0
}

export function openClawModelOptionsFromSnapshot(snapshot, currentModelRef) {
  const refs = []
  const pushRef = value => {
    const ref = String(value || '').trim()
    if (ref && !refs.includes(ref)) refs.push(ref)
  }

  for (const item of Array.isArray(snapshot?.models) ? snapshot.models : []) {
    if (!item.providerReady) continue
    const catalogAvailable = item.catalogAvailable ?? true
    if (catalogAvailable === false) continue
    pushRef(item.modelRef)
  }

  const profileDefaultRef = defaultModelRefFromSnapshot(snapshot, currentModelRef)
  if (profileDefaultRef && !refs.includes(profileDefaultRef) && shouldKeepProfileDefaultModel(snapshot, profileDefaultRef)) {
    pushRef(profileDefaultRef)
  }

  if (profileDefaultRef && refs.includes(profileDefaultRef)) {
    return [profileDefaultRef, ...refs.filter(ref => ref !== profileDefaultRef)]
  }

  return refs
}

export function availableModelChoicesFromSnapshot(snapshot, currentModelRef = '') {
  const modelEntries = Array.isArray(snapshot?.models) ? snapshot.models : []
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : []
  const providerById = new Map(providers.map(provider => [String(provider?.id || '').trim(), provider]).filter(([id]) => id))
  const currentDefault = defaultModelRefFromSnapshot(snapshot, currentModelRef)
  const refs = openClawModelOptionsFromSnapshot(snapshot, currentDefault)

  return refs.map(ref => {
    const entry = modelEntries.find(model => String(model?.modelRef || '').trim() === ref) || {}
    const providerId = String(entry.provider || providerFromModelRef(ref)).trim()
    const provider = providerById.get(providerId) || {}
    const current = Boolean(currentDefault && ref === currentDefault)
    return {
      id: ref,
      modelRef: ref,
      modelLabel: modelNameFromRef(ref),
      provider: providerId,
      providerLabel: provider.label || PROVIDER_LABELS[providerId] || providerId || '未知来源',
      contextWindow: entry.contextWindow || null,
      current,
      status: current ? '当前默认' : '可切换',
    }
  })
}

export function providerAuthStatusLabel(provider) {
  if (!provider) return '未检测'
  if (provider.ready) return '已就绪'
  const status = String(provider.status || '').trim()
  if (status === 'expired') return '已过期'
  if (status === 'cooldown') return '鉴权冷却中'
  if (status === 'disabled') return '账号暂不可用'
  if (status === 'missing') return '待配置'
  return status || '待配置'
}
