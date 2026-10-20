// 头像身份：从名字确定性地导出首字母与色相。
//
// 改这套之前，列表里同时并存四种头像体系：AI 一律兜底 🤖（9 位员工里 5 个
// 长得一模一样）、设了 emoji 的用 emoji、人类用同一个紫色渐变块、
// 邮箱账号用邮箱首字符。四种画法混在一列里，谁是谁完全靠读名字。
//
// 现在只有一套：有头像图用图 → 用户主动设了 emoji 用 emoji → 否则生成首字母块。
// 生成的色相由名字哈希决定，同一个人在任何位置、任何时候都是同一个颜色。

// 曾经被当作**默认值写进数据**的占位 emoji（Employees 新建表单预填 🤖，
// 云端 RPC 也拿它兜底），结果 9 位员工里 5 个存的都是它、彼此无法区分。
// 而「机器人」对一队 AI 员工不传达任何信息 —— 全都是 AI，等于没说。
//
// 所以渲染时把它视为"没设过"，让这些员工回落到各自的首字母块。
// 这是纯渲染层判断，数据一个字节都不动，随时可撤回。
// 代价：用户无法再主动选 🤖（想要机器人的可以选 🦾 🛸 🧠，区分度也更高）。
const PLACEHOLDER_EMOJI = new Set(['🤖'])

/** 返回用户"真正设过"的 emoji；占位值和空值都返回空串。 */
export function deliberateEmoji(emoji) {
  const value = String(emoji || '').trim()
  return PLACEHOLDER_EMOJI.has(value) ? '' : value
}

// 色相锁定在蓝—紫—品红这一段（品牌紫 #8b31f5 约在 268°）。
// 不用整个色环：绿/橙/红是语义色（成功/警告/危险）的地盘，
// 头像撞上去会让人误读成状态。
// 均匀铺开 14°，10 档 —— 8 档时 7 个生成头像几乎必然撞色（生日问题）。
const AVATAR_HUES = [200, 214, 228, 242, 256, 270, 284, 298, 312, 326]

/** 名字 → 稳定哈希。FNV-1a，够散且不依赖任何运行时状态。 */
function hashName(name) {
  let hash = 0x811c9dc5
  const source = String(name || '')
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

export function avatarHue(name) {
  return AVATAR_HUES[hashName(name) % AVATAR_HUES.length]
}

/**
 * 取用于显示的首字符。
 * 跳过开头的 emoji / 标点 —— 「橘子🍊」取「橘」而不是空白，
 * 「@张三」取「张」。邮箱取 @ 之前的第一个字符。
 */
export function avatarInitial(name) {
  const source = String(name || '').trim()
  if (!source) return '?'

  const local = source.includes('@') ? source.slice(0, source.indexOf('@')) : source
  // 汉字、假名、谚文、拉丁字母、数字都算"可显示的首字符"
  const match = local.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{L}\p{N}]/u)
  if (!match) return '?'
  return match[0].toUpperCase()
}

/** 供 style 展开：把色相作为自定义属性交给 .ui-avatar-generated 消费。 */
export function avatarHueStyle(name) {
  return { '--ui-avatar-hue': String(avatarHue(name)) }
}
