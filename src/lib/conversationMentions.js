export const MENTION_KINDS = {
  plugin: 'Plugin',
  mcp: 'MCP',
  skill: 'Skill',
  doc: 'Document',
}

const MENTION_KIND_ORDER = {
  plugin: 0,
  mcp: 1,
  skill: 2,
  doc: 3,
}

const MENTION_KIND_PATTERN = 'doc'
const COMMAND_KIND_PATTERN = 'plugin|mcp|skill'
const TOKEN_NAME_PATTERN = '[A-Za-z0-9_.@/-]+'
const QUERY_NAME_PATTERN = '[A-Za-z0-9_.@/:-]'
const DOCUMENT_MENTION_PATTERN = new RegExp(`@(${MENTION_KIND_PATTERN}):(?:《([^》\\r\\n]+)》|(${TOKEN_NAME_PATTERN}))`, 'g')
const COMMAND_TOKEN_PATTERN = new RegExp(`(^|\\s)/(?:(${COMMAND_KIND_PATTERN}):)?(${TOKEN_NAME_PATTERN})`, 'g')

function normalizeMentionKind(kind) {
  return Object.prototype.hasOwnProperty.call(MENTION_KINDS, kind) ? kind : 'mcp'
}

export function mentionToken(mention) {
  const kind = normalizeMentionKind(mention?.kind)
  const name = String(mention?.name || '').trim()
  const label = String(mention?.label || mention?.title || '').trim()
  if (kind === 'doc' && label && !/[》\r\n]/.test(label)) return `@${kind}:《${label}》`
  return name ? `@${kind}:${name}` : ''
}

function splitPluginCommandName(name) {
  const raw = String(name || '').trim()
  if (!raw) return { name: '', pluginId: '', toolName: null }
  const dotIndex = raw.indexOf('.')
  if (dotIndex <= 0 || dotIndex === raw.length - 1) {
    return { name: raw, pluginId: raw, toolName: null }
  }
  return {
    name: raw,
    pluginId: raw.slice(0, dotIndex),
    toolName: raw.slice(dotIndex + 1),
  }
}

function normalizeSlashInvocation(kind, name) {
  if (kind !== 'plugin') return { kind, name }
  const parsed = splitPluginCommandName(name)
  return {
    kind,
    name: parsed.name,
    pluginId: parsed.pluginId,
    toolName: parsed.toolName,
  }
}

export function slashInvocationKey(invocation) {
  const kind = normalizeMentionKind(invocation?.kind)
  if (kind === 'plugin') {
    const parsed = splitPluginCommandName(invocation?.name)
    const pluginId = String(invocation?.pluginId || parsed.pluginId || '').trim()
    const toolName = invocation?.toolName ? String(invocation.toolName).trim() : parsed.toolName || ''
    return pluginId ? `plugin:${pluginId}:${toolName}` : ''
  }
  const name = String(invocation?.name || '').trim()
  return name ? `${kind}:${name}` : ''
}

export function commandToken(mention) {
  const kind = normalizeMentionKind(mention?.kind)
  if (kind === 'plugin') {
    const pluginId = String(mention?.pluginId || mention?.name || '').trim()
    const toolName = mention?.toolName ? String(mention.toolName).trim() : ''
    const name = toolName ? `${pluginId}.${toolName}` : pluginId
    return name ? `/plugin:${name}` : ''
  }
  const name = String(mention?.name || '').trim()
  return name ? `/${kind}:${name}` : ''
}

function extractTokens(text, pattern, kindIndex = 2, nameIndex = 3) {
  const seen = new Set()
  const mentions = []
  for (const match of String(text || '').matchAll(pattern)) {
    const explicitKind = match[kindIndex]
    if (!explicitKind) continue
    const name = String(match[nameIndex] || '').trim()
    if (!name) continue
    const key = `${explicitKind}:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    mentions.push({ kind: explicitKind, name })
  }
  return mentions
}

export function extractConversationMentions(text) {
  const seen = new Set()
  const mentions = []
  for (const match of String(text || '').matchAll(DOCUMENT_MENTION_PATTERN)) {
    const title = String(match[2] || '').trim()
    const id = String(match[3] || '').trim()
    const name = title || id
    if (!name) continue
    const key = `doc:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    mentions.push(title
      ? { kind: 'doc', name, reference: 'title' }
      : { kind: 'doc', name })
  }
  return mentions
}

export function extractConversationToolInvocations(text) {
  const seen = new Set()
  return extractTokens(text, COMMAND_TOKEN_PATTERN)
    .map(item => normalizeSlashInvocation(item.kind, item.name))
    .filter(item => {
      const key = slashInvocationKey(item)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function activeMentionQuery(text, cursor = String(text || '').length) {
  const beforeCursor = String(text || '').slice(0, cursor)
  const match = beforeCursor.match(/(^|\s)@([A-Za-z0-9_.@/-]*)$/)
  if (!match) return null
  return {
    query: match[2] || '',
    start: beforeCursor.length - (match[2] || '').length - 1,
    end: cursor,
  }
}

export function activeCommandQuery(text, cursor = String(text || '').length) {
  const beforeCursor = String(text || '').slice(0, cursor)
  const match = beforeCursor.match(new RegExp(`(^|\\s)/(${QUERY_NAME_PATTERN}*)$`))
  if (!match) return null
  return {
    query: match[2] || '',
    start: beforeCursor.length - (match[2] || '').length - 1,
    end: cursor,
  }
}

export function insertMentionToken(text, cursor, mention) {
  const value = String(text || '')
  const active = activeMentionQuery(value, cursor) || { start: cursor, end: cursor }
  const token = mentionToken(mention)
  if (!token) return value
  return `${value.slice(0, active.start)}${token} ${value.slice(active.end)}`
}

export function insertCommandToken(text, cursor, mention) {
  const value = String(text || '')
  const active = activeCommandQuery(value, cursor) || { start: cursor, end: cursor }
  const token = commandToken(mention)
  if (!token) return value
  return `${value.slice(0, active.start)}${token} ${value.slice(active.end)}`
}

export function filterMentionOptions(query, options = []) {
  const rawQuery = String(query || '').trim().toLowerCase()
  const prefixMatch = rawQuery.match(/^(plugin|mcp|skill|doc):(.*)$/)
  const requiredKind = prefixMatch ? prefixMatch[1] : null
  const normalized = prefixMatch ? prefixMatch[2].trim() : rawQuery
  return options
    .filter(option => option?.name)
    .filter(option => !requiredKind || option.kind === requiredKind)
    .filter(option => {
      if (!normalized) return true
      const haystack = [
        option.kind,
        option.name,
        option.label,
        option.description,
        option.summary,
      ].join(' ').toLowerCase()
      return haystack.includes(normalized)
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return (MENTION_KIND_ORDER[left.kind] ?? 99) - (MENTION_KIND_ORDER[right.kind] ?? 99)
      }
      return String(left.name).localeCompare(String(right.name))
    })
}

// The menu itself scrolls, so dropping capabilities here makes installed
// plugins unreachable as soon as the profile has more than eight entries.
export function visibleMentionOptions(query, options = []) {
  return filterMentionOptions(query, options)
}

// Which skills an agent can actually use right now.
//
// Two rules the engine applies that the UI previously got wrong:
//
//  1. `agents.list[].skills` is an OPTIONAL allowlist. Omitting it means the
//     agent sees every eligible skill (`skills check` reports "Excluded by
//     agent allowlist: 0"); it is a narrowing filter, never an opt-in gate.
//     Treating "no allowlist" as "nothing assigned" hid all 40 usable skills.
//  2. Plugin-provided skills are the same capability as the plugin entry the
//     menu already lists, so they must not appear a second time under their
//     internal skill name (「演示文稿」 and `pptx` are one thing, not two).
export function selectAgentVisibleSkills(skills = [], assignedSkillNames = new Set(), plugins = []) {
  const allowlist = assignedSkillNames instanceof Set
    ? assignedSkillNames
    : new Set(Array.isArray(assignedSkillNames) ? assignedSkillNames : [])
  const pluginProvided = new Set()
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    const names = plugin?.skillNames || plugin?.skill_names
    for (const name of Array.isArray(names) ? names : []) {
      const trimmed = String(name || '').trim()
      if (trimmed) pluginProvided.add(trimmed)
    }
  }
  return (Array.isArray(skills) ? skills : []).filter(skill => {
    const name = String(skill?.name || '').trim()
    if (!name) return false
    if (skill.disabled || skill.eligible === false) return false
    if (allowlist.size > 0 && !allowlist.has(name)) return false
    return !pluginProvided.has(name)
  })
}

export function filterPluginMentionOptionsByProfile(options = [], profilePlugins = null) {
  if (!Array.isArray(profilePlugins)) return options
  const enabledPluginIds = new Set(
    profilePlugins
      .filter(plugin => plugin?.enabled)
      .map(plugin => String(plugin.id || plugin.pluginId || '').trim())
      .filter(Boolean),
  )
  return options.filter(option => {
    if (option?.kind !== 'plugin') return true
    const id = String(option.id || option.name || '').trim()
    return Boolean(id && enabledPluginIds.has(id))
  })
}

function cleanOptionText(value) {
  return String(value || '').trim()
}

function normalizedDocumentTitle(value) {
  return cleanOptionText(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000《》〈〉「」『』“”‘’"'`]/g, '')
    .replace(/[。．.!！?？,，、:：;；]/g, '')
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function titleIsExplicitlyRequested(text, title) {
  const rawText = String(text || '').normalize('NFKC')
  const rawTitle = cleanOptionText(title).normalize('NFKC')
  if (!rawTitle) return false

  // Quoting a document title is unambiguous. In ordinary prose, require a
  // nearby document operation so short titles cannot be granted incidentally.
  const titleWithoutTerminalPunctuation = rawTitle.replace(/[。．.!！?？]+$/, '') || rawTitle
  const escaped = `${escapeRegExp(titleWithoutTerminalPunctuation)}[。．.!！?？]*`
  const quoted = new RegExp(`[《「『“”"']\\s*${escaped}\\s*[》」』“”"']`)
  const operation = new RegExp(
    `(?:阅读|读取|读|查看|打开|分析|总结|概括|编辑|修改|改名|重命名|整理|根据)\\s*[《「『“”"']?\\s*${escaped}`,
  )
  return quoted.test(rawText) || operation.test(rawText)
}

function chineseOrdinal(value) {
  const digits = new Map([
    ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5],
    ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10],
  ])
  const normalized = String(value || '').trim()
  if (/^\d+$/.test(normalized)) return Number(normalized)
  if (digits.has(normalized)) return digits.get(normalized)
  if (/^十[一二三四五六七八九]$/.test(normalized)) return 10 + digits.get(normalized[1])
  if (/^[二三四五六七八九]十$/.test(normalized)) return digits.get(normalized[0]) * 10
  if (/^[二三四五六七八九]十[一二三四五六七八九]$/.test(normalized)) {
    return digits.get(normalized[0]) * 10 + digits.get(normalized[2])
  }
  return 0
}

function explicitlyRequestedDocumentOrdinal(text) {
  const rawText = String(text || '').normalize('NFKC')
  const requested = rawText.match(
    /(?:阅读|读取|读|查看|看|打开|分析|总结|概括|编辑|修改|改名|重命名|整理|根据)[^。！？!?]{0,16}?第\s*([一二三四五六七八九十\d]+)\s*篇/,
  ) || rawText.match(
    /(?:^|[。！？!?])\s*(?:比如|例如|就)?\s*第\s*([一二三四五六七八九十\d]+)\s*篇/,
  )
  return requested ? chineseOrdinal(requested[1]) : 0
}

// Turn only a uniquely named document that the user explicitly asks to use
// into a structured mention. The bridge's per-turn allowlist remains intact.
export function inferDocumentTitleMentions(text, options = [], existingMentions = []) {
  const explicitIds = new Set(
    (Array.isArray(existingMentions) ? existingMentions : [])
      .filter(mention => normalizeMentionKind(mention?.kind) === 'doc')
      .map(mention => cleanOptionText(mention?.name))
      .filter(Boolean),
  )
  const candidatesByTitle = new Map()
  for (const option of Array.isArray(options) ? options : []) {
    if (normalizeMentionKind(option?.kind) !== 'doc') continue
    const id = cleanOptionText(option?.name || option?.id)
    const title = cleanOptionText(option?.label || option?.title)
    const key = normalizedDocumentTitle(title)
    // One-character titles are easily incidental; duplicate titles need @ so
    // the user, rather than the model, decides which document to open.
    if (!id || explicitIds.has(id) || key.length < 2) continue
    const candidates = candidatesByTitle.get(key) || []
    candidates.push({ id, title, option })
    candidatesByTitle.set(key, candidates)
  }

  const inferred = []
  const ordinal = explicitlyRequestedDocumentOrdinal(text)
  const documentOptions = (Array.isArray(options) ? options : []).filter(option => (
    normalizeMentionKind(option?.kind) === 'doc'
  ))
  const ordinalOption = ordinal > 0 ? documentOptions[ordinal - 1] : null
  if (ordinalOption) {
    const id = cleanOptionText(ordinalOption?.name || ordinalOption?.id)
    if (id && !explicitIds.has(id)) {
      inferred.push({
        kind: 'doc',
        name: id,
        label: mentionLabel(ordinalOption),
        summary: cleanOptionText(ordinalOption.summary),
        trigger: 'ordinal',
      })
      explicitIds.add(id)
    }
  }
  for (const candidates of candidatesByTitle.values()) {
    if (candidates.length !== 1) continue
    const candidate = candidates[0]
    if (!titleIsExplicitlyRequested(text, candidate.title)) continue
    inferred.push({
      kind: 'doc',
      name: candidate.id,
      label: mentionLabel(candidate.option),
      summary: cleanOptionText(candidate.option.summary),
      trigger: 'title',
    })
  }
  return inferred
}

function mentionLabel(mention = {}) {
  return cleanOptionText(mention.label || mention.title || mention.displayName || mention.name)
}

function mentionLineLabel(kind) {
  if (kind === 'doc') return 'Document'
  return ''
}

function mentionLine(mention = {}) {
  const kind = normalizeMentionKind(mention.kind)
  const label = mentionLineLabel(kind)
  const name = cleanOptionText(mention.name)
  const display = mentionLabel(mention)
  if (kind === 'doc' && display && display !== name) {
    return `- ${label}: \`${display}\` (\`${name}\`)`
  }
  return `- ${label}: \`${name}\``
}

const PLUGIN_STATUS_LABELS = {
  ready: '已就绪 Uniopc 引擎 Plugin',
  not_installed: '未安装',
  disabled: '未启用',
  bridge_disabled: '工具桥未开启',
  missing_env: '待配置(缺环境变量)',
  runtime_blocked: '运行时策略未放行',
  runtime_inspect_failed: '运行时探测失败',
  runtime_missing: '运行时缺少工具',
  unauthorized: '未授权',
}

export function pluginStatusLabel(status) {
  const key = String(status || '').trim()
  return PLUGIN_STATUS_LABELS[key] || (key ? `不可用(${key})` : '不可用')
}

export function buildMentionResourceOptions(resources = {}, { commandMode = false } = {}) {
  const toolPlugins = Array.isArray(resources.toolPlugins) ? resources.toolPlugins : []
  const plugins = Array.isArray(resources.plugins) ? resources.plugins : []
  const mcps = Array.isArray(resources.mcps) ? resources.mcps : []
  const skills = Array.isArray(resources.skills) ? resources.skills : []
  const documents = Array.isArray(resources.documents) ? resources.documents : []

  const documentOptions = documents.map(document => ({
      kind: 'doc',
      id: document.id,
      name: document.id,
      label: document.title || document.name || document.id,
      summary: document.summary || document.description || document.folder_path,
      description: '我的文档',
    }))

  if (!commandMode) return documentOptions

  const toolPluginOptions = toolPlugins.filter(plugin => {
    // Infrastructure plugins (e.g. uniopc-gatekeeper's before_tool_call hook)
    // are READY yet expose neither tools nor skills — there is nothing to "/"
    // invoke, and the send path correctly rejects them ("没有可用工具"). Keep
    // them out of the capability menu instead of offering a dead entry. Only
    // ready-and-empty is hidden: a non-ready plugin may have its tools list
    // cleared (e.g. unauthorized probes) and must stay visible with reasons.
    if (plugin.status !== 'ready') return true
    const hasSkills = Boolean(plugin.hasSkills ?? plugin.has_skills)
    const hasTools = Array.isArray(plugin.tools) && plugin.tools.length > 0
    return hasSkills || hasTools
  }).map(plugin => {
    const ready = plugin.status === 'ready'
    // The Rust snapshot serializes camelCase (readinessReasons/hasSkills);
    // accept snake_case too for older payloads and test fixtures.
    const readinessReasons = Array.isArray(plugin.readinessReasons)
      ? plugin.readinessReasons
      : Array.isArray(plugin.readiness_reasons) ? plugin.readiness_reasons : []
    const hasSkills = Boolean(plugin.hasSkills ?? plugin.has_skills)
    const hasTools = Array.isArray(plugin.tools) && plugin.tools.length > 0
    // Skill-pack plugins (skills, no tool contract) are fully usable — label
    // them as such so neither the user nor the model reads "no tools" as broken.
    const readyDescription = hasSkills && !hasTools
      ? '已就绪技能包(通过 Skill 提供能力)'
      : '已就绪 Uniopc 引擎 Plugin'
    return {
      kind: 'plugin',
      id: plugin.id,
      name: plugin.id,
      pluginId: plugin.id,
      toolName: null,
      label: plugin.title || plugin.id,
      summary: plugin.description,
      status: plugin.status || '',
      disabled: !ready,
      readinessReasons,
      description: ready ? readyDescription : pluginStatusLabel(plugin.status),
    }
  })
  // Fall back to the legacy plugins list only when the Gateway reported no
  // tool-capability plugins at all; otherwise the toolPlugins list (ready or
  // not) is authoritative and non-ready entries are shown disabled with a
  // reason so the user can see why a plugin is unavailable.
  const pluginOptions = toolPlugins.length
    ? toolPluginOptions
    : plugins.map(plugin => ({
      kind: 'plugin',
      id: plugin.id || plugin.name,
      name: plugin.id || plugin.name,
      label: plugin.title || plugin.name || plugin.id,
      summary: plugin.description,
      status: 'ready',
      disabled: false,
      readinessReasons: [],
      description: 'Uniopc 引擎 Plugin',
    }))

  return [
    ...pluginOptions,
    ...mcps.map(server => ({
      kind: 'mcp',
      name: server.name,
      label: server.name,
      summary: server.summary,
      description: commandMode ? '已配置 MCP server' : server.transport,
    })),
    ...skills.map(skill => ({
      kind: 'skill',
      name: skill.name,
      label: skill.name,
      summary: skill.description,
      description: commandMode ? '可调用 Skill' : skill.eligible === false ? '当前不可分配' : '可用 Skill',
    })),
  ]
}

export function mergeMentionResources(current = {}, patch = {}) {
  return {
    plugins: Array.isArray(patch.plugins) ? patch.plugins : Array.isArray(current.plugins) ? current.plugins : [],
    mcps: Array.isArray(patch.mcps) ? patch.mcps : Array.isArray(current.mcps) ? current.mcps : [],
    skills: Array.isArray(patch.skills) ? patch.skills : Array.isArray(current.skills) ? current.skills : [],
    toolPlugins: Array.isArray(patch.toolPlugins) ? patch.toolPlugins : Array.isArray(current.toolPlugins) ? current.toolPlugins : [],
    documents: Array.isArray(patch.documents) ? patch.documents : Array.isArray(current.documents) ? current.documents : [],
  }
}

export function mentionResourcesLoadingAfterCoreResult({
  loading,
  toolPlugins = [],
  pendingMcp = false,
  pendingSkills = false,
} = {}) {
  if (!loading) return false
  if (Array.isArray(toolPlugins) && toolPlugins.some(plugin => plugin?.status === 'ready')) return false
  return Boolean(pendingMcp || pendingSkills)
}

export function shouldRefreshSlashMentionResources({ trigger, profile, employeeId, refreshedKey = '' } = {}) {
  const normalizedProfile = String(profile || '').trim()
  const normalizedEmployeeId = String(employeeId || '').trim()
  if (trigger !== 'slash' || !normalizedProfile || !normalizedEmployeeId) return false
  return refreshedKey !== `${normalizedProfile}:${normalizedEmployeeId}`
}

export function enrichConversationMentions(mentions = [], options = []) {
  const optionByKey = new Map()
  const documentOptionsByTitle = new Map()
  for (const option of Array.isArray(options) ? options : []) {
    const kind = normalizeMentionKind(option?.kind)
    const name = cleanOptionText(option?.name || option?.id)
    if (!name) continue
    optionByKey.set(`${kind}:${name}`, option)
    if (kind === 'doc') {
      const title = cleanOptionText(option?.label || option?.title)
      if (title) documentOptionsByTitle.set(title, [...(documentOptionsByTitle.get(title) || []), option])
    }
  }

  return (Array.isArray(mentions) ? mentions : [])
    .map(mention => {
      const kind = normalizeMentionKind(mention?.kind)
      const name = cleanOptionText(mention?.name)
      if (!name) return null
      if (kind !== 'doc') return null

      const matchingByTitle = mention?.reference === 'title'
        ? documentOptionsByTitle.get(name) || []
        : []
      // A title is only a safe display alias when it resolves to one document.
      // Duplicate names remain un-authorized rather than selecting an arbitrary file.
      const option = matchingByTitle.length === 1
        ? matchingByTitle[0]
        : optionByKey.get(`${kind}:${name}`)
      if (!option) return null
      const { reference: _reference, ...normalizedMention } = mention
      return {
        ...normalizedMention,
        kind,
        name: cleanOptionText(option?.name || option?.id),
        label: mentionLabel(option),
        summary: cleanOptionText(option.summary),
      }
    })
    .filter(Boolean)
}

export function buildMentionContext(mentions = []) {
  const seen = new Set()
  const unique = []
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    const kind = normalizeMentionKind(mention?.kind)
    if (kind !== 'doc') continue
    const name = cleanOptionText(mention?.name)
    if (!name) continue
    const key = `${kind}:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ ...mention, kind, name })
  }
  if (!unique.length) return ''
  const lines = unique.map(mentionLine)
  return [
    '用户本轮显式 @ 了以下文档上下文：',
    ...lines,
    '请优先按这些 @ 引用理解用户上下文；文档不可用时，说明原因并给出替代方案。',
  ].join('\n')
}

export function buildToolInvocationContext(invocations = []) {
  const unique = extractConversationToolInvocations(
    invocations.map(commandToken).filter(Boolean).join(' '),
  )
  if (!unique.length) return ''
  const lines = unique.map(mention => {
    const label = mention.kind === 'plugin'
      ? 'Uniopc 引擎 plugin'
      : mention.kind === 'skill'
        ? 'Skill'
        : 'MCP server'
    return `- ${label}: \`${mention.name}\``
  })
  return [
    '用户本轮显式 / 调用了以下已安装能力：',
    ...lines,
    '请把这些 / 调用视为用户明确要求使用的能力。插件能力有两种形态：注册为工具(tools)，或作为技能包以 Skill 提供(如 pptx、docx、pdf)。若没有同名工具，先检查你已加载的 Skill 并直接使用，不要因为没有工具就报告插件不可用；只有工具和 Skill 都不存在时，才说明缺失的 ready 条件。',
  ].join('\n')
}

// Wheel/trackpad scrolling in the mention menu must never strand the highlighted
// row off-screen. Given the viewport and each row's geometry, returns the index
// the selection should move to (or the current one when it is still visible).
export function nearestVisibleMentionIndex({ viewport, items = [], activeIndex = 0 } = {}) {
  if (!viewport || !Array.isArray(items) || items.length === 0) return activeIndex
  const visible = items.filter(item => item.top >= viewport.top - 1 && item.bottom <= viewport.bottom + 1)
  if (visible.length === 0) return activeIndex
  const active = items.find(item => item.index === activeIndex)
  if (active && visible.some(item => item.index === activeIndex)) return activeIndex
  const scrolledPastActive = active ? active.top < viewport.top : true
  const target = scrolledPastActive ? visible[0] : visible[visible.length - 1]
  return Number.isInteger(target?.index) ? target.index : activeIndex
}
