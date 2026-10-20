// 把可能带 markdown / 换行 / 长路径的文本压成适合单行截断展示的摘要。
//
// 起因：员工列表里直接渲染原始描述，于是列表上出现
// `- **项目开发：** 负责全栈项目的需求分析、架构设计...`
// —— 星号和列表符号原样漏出来。项目卡片同理，「项目目录」字段是三个
// 绝对路径拼在一起，占掉两行还读不出信息。
//
// 这里只做展示层压平，不改数据；点进详情看到的仍是原文。

// 目录名里可以有空格（这台机器上就是 "New project 2"），所以不能拿空格当
// 路径分隔符。改用"空格后面紧跟 /"作为两条路径之间的边界，先切块再压缩，
// 块内就只剩一条路径了。
const PATH_BOUNDARY = /(?= \/)/
const LONG_PATH = /\/(?:[^/\n]+\/){2,}([^/\n]+)/g

/** 长绝对路径只留最后一段：/Users/lan/Documents/New project 2/uniopc-admin → …/uniopc-admin */
function shortenPaths(text) {
  return text
    .split(PATH_BOUNDARY)
    .map(chunk => chunk.replace(LONG_PATH, (match, tail) => `…/${tail}`))
    .join('')
}

function stripMarkdown(text) {
  return text
    // 代码块整段丢掉：单行摘要里放不下，留着只会漏出反引号
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    // 图片先于链接处理，否则 ![alt](url) 会留下一个孤立的 !
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    // 行首的标题 / 引用 / 列表符号
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '')
    // 分隔线整行去掉
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, ' ')
}

/**
 * @param {string} text 原始描述
 * @param {number} maxLength 超出后截断并加省略号；0 表示不截断
 */
export function plainSummary(text, maxLength = 0) {
  const source = String(text || '')
  if (!source.trim()) return ''

  let out = stripMarkdown(source)
  out = shortenPaths(out)
  // 换行折成分隔点：多条要点压到一行时，用 · 比空格更能保住"这是几条"的结构
  out = out.replace(/\s*\n+\s*/g, ' · ')
  out = out.replace(/\s{2,}/g, ' ').trim()
  // 折行可能在首尾留下孤立的分隔点
  out = out.replace(/^(?:·\s*)+/, '').replace(/(?:\s*·)+$/, '').trim()

  if (maxLength > 0 && out.length > maxLength) {
    return `${out.slice(0, maxLength).trimEnd()}…`
  }
  return out
}
