// Offset-based Markdown prose inspection: never reserialize shipped skills.
const BRAND = /(?<![A-Za-z0-9_])(?:OpenClaw|OPENCLAW|小龙虾)(?![A-Za-z0-9_])/g

export function isManagedSkillMarkdown(path) {
  const rel = path.replaceAll('\\', '/')
  return /^skills\/(?!.*(?:^|\/)(?:node_modules|LICENSE|THIRD_PARTY)(?:\/|\.|$)).+\.md$/i.test(rel)
}

export function skillBrandOccurrences(source) {
  // Use UTF-16 offsets, like String#slice and RegExp#index.
  const visible = Array(source.length).fill(' ')
  const expose = (start, end) => { for (let i = start; i < end; i++) visible[i] = source[i] }
  const hide = (start, end) => { for (let i = start; i < end; i++) visible[i] = ' ' }
  let body = 0
  if (/^(?:\uFEFF)?---\r?\n/.test(source)) {
    const start = source.indexOf('\n') + 1
    const close = /^---\s*\r?$/gm
    close.lastIndex = start
    const end = close.exec(source)
    if (!end) throw new Error('Unsafe Skill frontmatter: missing closing delimiter')
    const front = source.slice(start, end.index)
    let description = false
    let quote = null
    let descriptionBlock = false
    let offset = start
    for (const line of front.match(/[^\n]*\n|[^\n]+$/g) || []) {
      const content = line.replace(/\r?\n$/, '')
      const key = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/.exec(content)
      if (key) {
        if (quote) throw new Error('Unsafe Skill frontmatter: multiline quoted description')
        description = key[1] === 'description'
        if (description) {
          const value = key[2] || ''
          if (!value.trim()) throw new Error('Unsafe Skill frontmatter: description requires an explicit string scalar')
          descriptionBlock = /^[|>][+-]?(?:\s+#.*)?$/.test(value)
          if (/^[\[{&*!]|^(?:[-?]\s|(?:null|true|false|~|[-+]?\d+(?:\.\d+)?)\s*(?:#.*)?$)/i.test(value)) throw new Error('Unsafe Skill frontmatter description')
          if (/^["']/.test(value)) {
            quote = value[0]
            if (value.length < 2 || value.at(-1) !== quote) throw new Error('Unsafe Skill frontmatter: multiline quoted description')
            quote = null
          }
          expose(offset + content.indexOf(':') + 1, offset + content.length)
        }
      } else if (/^\s*(?:#.*)?$/.test(content)) {
        // Comments and blank lines are never prose.
      } else if (/^[ \t]+\S/.test(content)) {
        if (description) {
          if (!descriptionBlock && /^\s*(?:[-?](?:\s|$)|[^:]+:(?:\s|$)|[\[{&*!])/.test(content)) {
            throw new Error('Unsafe Skill frontmatter: description must be a string scalar')
          }
          expose(offset, offset + content.length)
        }
      } else throw new Error('Unsafe Skill frontmatter syntax')
      offset += line.length
    }
    body = end.index + end[0].length
    if (source[body] === '\n') body++
  }
  expose(body, source.length)
  let fence = null
  let offset = body
  for (const line of source.slice(body).match(/[^\n]*\n|[^\n]+$/g) || []) {
    const containerLine = line.replace(/^(?: {0,3}> ?)+/, '')
    const marker = /^ {0,3}(?:(?:[-+*]|\d+[.)]) +)?(`{3,}|~{3,})(.*)/.exec(containerLine)
    if (fence) {
      hide(offset, offset + line.length)
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null
    } else if (marker) {
      fence = marker[1]
      hide(offset, offset + line.length)
    } else if (/^(?: {4}|\t)/.test(containerLine) || /Copyright|\b(?:portions incorporated into|Portions of OpenClaw were adapted)\b/i.test(line)) {
      hide(offset, offset + line.length)
    }
    offset += line.length
  }
  // Inline code spans can contain newlines and use arbitrary backtick lengths.
  const ticks = [...source.matchAll(/`+/g)].filter(run => visible[run.index] === '`')
  for (let index = 0; index < ticks.length; index++) {
    const opening = ticks[index]
    const closing = ticks.findIndex((run, next) => next > index && run[0].length === opening[0].length)
    if (closing < 0) continue
    hide(opening.index, ticks[closing].index + ticks[closing][0].length)
    index = closing
  }
  for (const match of source.matchAll(/(?:https?:\/\/|mailto:)[^\s<>"']+|<[^>\n]+>|@[\w.-]+\/[\w./-]+/g)) hide(match.index, match.index + match[0].length)
  // Package names and paths are technical tokens, even when their brand segment
  // has no identifier suffix (OpenClaw/plugin, OpenClaw-cli).
  for (const match of source.matchAll(/@?[\w.-]+[\/\\][\w./\\-]+|[\w.]+-[\w.-]+/g)) hide(match.index, match.index + match[0].length)
  const references = new Set()
  const referenceKey = value => value.trim().replace(/\s+/g, ' ').toLowerCase()
  for (const match of source.matchAll(/^ {0,3}\[([^\]\n]+)\]:[^\n]*/gm)) {
    if (visible[match.index + match[0].indexOf('[')] !== '[') continue
    references.add(referenceKey(match[1]))
    hide(match.index, match.index + match[0].length)
  }
  // A full reference has a visible label and a separate immutable identifier.
  // Collapsed/shortcut labels double as identifiers, so keep those intact.
  for (const match of source.matchAll(/\[([^\]\n]*)\]\[([^\]\n]*)\]/g)) {
    if (visible[match.index] !== '[') continue
    const identifierStart = match.index + match[1].length + 2
    hide(match[2] ? identifierStart : match.index, match.index + match[0].length)
  }
  for (const match of source.matchAll(/\[([^\]\n]+)\]/g)) {
    const next = source[match.index + match[0].length]
    if (visible[match.index] === '[' && next !== '[' && next !== '(' && references.has(referenceKey(match[1]))) {
      hide(match.index, match.index + match[0].length)
    }
  }
  // Only complete inline links outside protected code can hide destinations.
  for (const match of source.matchAll(/\[[^\]\n]*\]\(/g)) {
    const destination = match.index + match[0].length - 1
    if (visible[match.index] !== '[' || visible[destination] !== '(') continue
    let depth = 1
    let end = destination + 1
    for (; end < source.length && depth; end++) {
      if (source[end] === '\\') { end++; continue }
      if (source[end] === '(') depth++
      if (source[end] === ')') depth--
    }
    if (depth === 0) hide(destination, end)
  }
  return [...visible.join('').matchAll(BRAND)].map(match => ({ start: match.index, end: match.index + match[0].length, brand: match[0] }))
}

export function rebrandSkillMarkdown(source) {
  let result = source
  for (const { start, end } of skillBrandOccurrences(source).reverse()) result = result.slice(0, start) + 'Uniopc' + result.slice(end)
  return result
}
