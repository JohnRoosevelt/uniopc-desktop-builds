import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 设计系统 v3 的结构性守卫。
//
// 这套 token 之所以要被测试，是因为它上一次垮掉的方式是"静默的"：
// 有人加一个硬编码深色类，浅色模式就破一处，没有任何报错。
// 下面每条断言都对应一个已经真实发生过的退化。

const cssPath = fileURLToPath(new URL('../index.css', import.meta.url))
const css = readFileSync(cssPath, 'utf8')

/** 抽出某个选择器块里的自定义属性声明 */
function tokensIn(selectorPattern) {
  const match = css.match(selectorPattern)
  assert.ok(match, `找不到选择器块: ${selectorPattern}`)
  const body = match[1]
  const tokens = {}
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[name] = value.trim()
  }
  return tokens
}

const darkTokens = tokensIn(/:root,\s*\n\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)
const lightTokens = tokensIn(/\n\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/)

/** #rrggbb → 相对亮度（sRGB 感知加权，够用即可） */
function luminance(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  assert.ok(m, `不是 6 位十六进制色: ${hex}`)
  const [r, g, b] = [1, 2, 3].map(i => parseInt(m[i], 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const LADDER = [
  '--ui-surface-sunken',
  '--ui-surface-base',
  '--ui-surface-raised',
  '--ui-surface-overlay',
  '--ui-surface-float',
]

test('深色 surface 阶梯单调递增：越"高"越亮', () => {
  // 旧版这里是乱的 —— border(#252221) 比 surface(#302c2b) 暗，
  // 而 surface-raised(#282423) 又比 surface 更暗，"升起"的面反而更深。
  // 层级信号自相矛盾，是界面读不出主次的直接原因。
  const levels = LADDER.map(name => {
    assert.ok(darkTokens[name], `深色缺少 ${name}`)
    return { name, lum: luminance(darkTokens[name]) }
  })
  for (let i = 1; i < levels.length; i += 1) {
    assert.ok(
      levels[i].lum > levels[i - 1].lum,
      `${levels[i].name} 必须比 ${levels[i - 1].name} 亮，实际 ${levels[i].lum.toFixed(4)} <= ${levels[i - 1].lum.toFixed(4)}`,
    )
  }
})

test('浅色 surface 阶梯不倒挂', () => {
  // 浅色下白之上没有更白，raised/overlay/float 允许并列，
  // 但 sunken 必须比 base 暗，否则凹陷面看不出来。
  const sunken = luminance(lightTokens['--ui-surface-sunken'])
  const base = luminance(lightTokens['--ui-surface-base'])
  const raised = luminance(lightTokens['--ui-surface-raised'])
  assert.ok(sunken < base, 'sunken 必须比 base 暗')
  assert.ok(base <= raised, 'base 不能比 raised 亮')
})

test('深浅两套 token 键集完全对称', () => {
  // 缺一个键 = 该主题下静默回退到另一套主题的值，
  // 就是登录页 CTA 变成近黑压紫底（对比度 2.3:1）的那类 bug。
  const themed = name => name.startsWith('--ui-surface-')
    || name.startsWith('--ui-border-')
    || name.startsWith('--ui-text-')
    || name.startsWith('--ui-state-')
    || name.startsWith('--ui-shadow-')
    || name.endsWith('-text')
    || name.endsWith('-surface')
    || name === '--ui-highlight-inset'

  const darkKeys = Object.keys(darkTokens).filter(themed).sort()
  const lightKeys = Object.keys(lightTokens).filter(themed).sort()
  assert.deepEqual(lightKeys, darkKeys, '深浅主题的 token 键集必须一一对应')
})

test('@theme inline 已声明，否则 Tailwind 不会生成任何语义 utility', () => {
  // 根因级守卫：项目装了 Tailwind v4 却从未用过 @theme，
  // 导致 token 定义了但语法上没有便捷路径去用，
  // 于是所有人回退到 bg-[#2b2827] 硬编码。
  assert.match(css, /@theme inline\s*\{/)
  // 必须是 inline —— 普通 @theme 会把值烘死，切主题就失效
  assert.equal(/@theme\s*\{/.test(css.replace(/@theme inline\s*\{/g, '')), false)
})

/** theme.js 去掉注释后的代码 —— 注释里会举反例，不能算违规 */
function themeJsCode() {
  const path = fileURLToPath(new URL('./theme.js', import.meta.url))
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

test('theme.js comments do not contain class-like arbitrary values scanned by Tailwind', () => {
  const path = fileURLToPath(new URL('./theme.js', import.meta.url))
  const source = readFileSync(path, 'utf8')
  assert.doesNotMatch(source, /bg-\[var\(--ui-[^)]+\)\]/)
})

test('不得再出现按类名覆写的主题补丁选择器', () => {
  // P1 删掉了 98 条 `:root[data-theme='light'] .某个硬编码类 { }`。
  // 主题切换必须靠重绑原始值，不是靠追杀 utility —— 一旦有人加回来，
  // "新组件静默破浅色"那类 bug 就会跟着回来。
  //
  // 允许的形态只有两种：声明原始值的 [data-theme='x'] { --ui-*: … }，
  // 以及 @custom-variant。被禁的是 [data-theme='x'] 后面跟类选择器。
  const offenders = [...css.matchAll(/\[data-theme='(?:light|dark)'\][^{,\n]*\.[\w\\[\]#/.-]+/g)]
    .map(m => m[0])
  assert.deepEqual(offenders, [], `发现按类名覆写的主题补丁：\n${offenders.join('\n')}`)
})

test('浅色主题不得靠 !important 抢救', () => {
  // 那 98 条补丁几乎每条都带 !important。数量归零是"没有补丁"的独立佐证。
  // 例外：prefers-reduced-motion 的无障碍覆盖本来就该赢过一切，保留。
  const withoutA11y = css.replace(
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/g,
    '',
  )
  const bangs = (withoutA11y.match(/!important/g) || []).length
  assert.equal(bangs, 0, `index.css 里还有 ${bangs} 处非无障碍用途的 !important`)
})

test('根基准是 13px，且没有东西依赖 rem', () => {
  // 桌面端主力字号是 13px。此前实测 16px 出现 138 次 —— 那是"没设字号
  // 所以继承浏览器默认"的结果，不是有人选的。
  assert.match(css, /html\s*\{[^}]*font-size:\s*13px/)

  // 根基准一改，所有 rem 值就跟着缩水（1.35rem 从 21.6px 变成 17.55px）。
  // 这个坑真实发生过：登录页 hero、tooltip 宽度、输入框内边距全中招。
  // 所以尺寸一律用 px，不用 rem。
  const remUsage = [...css.matchAll(/[\d.]+rem/g)].map(m => m[0])
  assert.deepEqual(remUsage, [], `index.css 里还有 rem：${remUsage.join(', ')}`)
})

test('两套字号刻度必须一致', () => {
  // .ui-text-* 工具类走 --ui-font-size-*，Tailwind utility 走 @theme 的 --text-*。
  // 两套并存过一段时间且值不同，同一个"sm"在两处分别是 13px 和 14px。
  const pick = (name, re) => {
    const m = css.match(re)
    assert.ok(m, `找不到 ${name}`)
    return m[1]
  }
  for (const tier of ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl']) {
    const legacy = pick(`--ui-font-size-${tier}`, new RegExp(`--ui-font-size-${tier}:\\s*(\\d+)px`))
    const modern = pick(`--text-${tier}`, new RegExp(`--text-${tier}:\\s*(\\d+)px`))
    assert.equal(legacy, modern, `${tier} 档两套刻度不一致：${legacy} vs ${modern}`)
  }
})

test('组件层不得出现 white/N 半透明与硬编码色', () => {
  // white/N 天生只对深色成立，浅色下必须靠覆写选择器抢救 ——
  // 那 98 条 :root[data-theme='light'] 补丁就是这么来的。
  const code = themeJsCode()
  assert.equal(/(bg|border|text)-white\//.test(code), false, 'theme.js 不得使用 white/N')
  assert.equal(/#[0-9a-fA-F]{6}/.test(code), false, 'theme.js 不得硬编码十六进制色')
  assert.equal(/\[var\(--ui-/.test(code), false, 'theme.js 应使用语义 utility，而非 CSS 变量任意值')
})

test('过渡显式声明属性，不用 transition-all', () => {
  // transition-all 会把 layout 属性一起动，既慢又抖。
  assert.equal(/transition-all/.test(themeJsCode()), false)
})
