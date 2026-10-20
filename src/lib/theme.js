/**
 * Uniopc Design Tokens — 组件层
 *
 * Refined minimalism — restraint, precision, consistency, hierarchy.
 * Import class constants from here instead of writing long tailwind strings.
 *
 *   import { LAYOUT, HEADING, CARD, FORM } from '../lib/theme'
 *   <div className={LAYOUT.wide}>
 *     <h2 className={HEADING.page}>...</h2>
 *   </div>
 *
 * 这是设计系统的第 3 层（原始值 → @theme 语义层 → 这里）。
 * 本文件被 14 个页面 import，是全产品视觉的杠杆点：改这里一处，14 页跟着变。
 *
 * 纪律：
 *   - 只用 index.css 的 @theme 生成的语义 utility
 *     （bg-surface-* / border-subtle|default|strong / text-primary|secondary|tertiary
 *      / shadow-* / ease-out / bg-brand …）
 *   - 不写 CSS 变量形式的任意值背景类，不写 white/N 半透明，不写 hex
 *   - 过渡一律显式给 duration 与 ease，不用 transition-all
 */

// ── 页面容器 ──────────────────────────────
export const LAYOUT = {
  wide:     'max-w-[1360px] mx-auto space-y-5',  // Dashboard / Agents
  board:    'max-w-[1520px] mx-auto space-y-5',  // Project (需要看板宽度)
  workspace:'max-w-[1520px] mx-auto h-[calc(100vh-6.5rem)] md:h-[calc(100vh-1.5rem)]', // Conversations / cloud documents
  standard: 'max-w-[1120px] mx-auto space-y-5',
  reading:  'max-w-[760px] mx-auto space-y-5',   // Guide
  narrow:   'max-w-[720px] mx-auto space-y-5',   // Profile
}

// ── 页面结构 ──────────────────────────────
export const PAGE = {
  topbar:      'flex min-h-10 items-center justify-end',
  actions:     'flex flex-wrap items-center gap-2',
  sectionBar:  'flex flex-col gap-2.5 md:flex-row md:items-start md:justify-between',
  modalHeader: 'flex items-start justify-between gap-4',
  cardActions: 'flex shrink-0 flex-wrap items-center justify-end gap-2',
}

// ── 过渡 ──────────────────────────────────
// 显式声明属性 + 时长 + 缓动。transition-all 会连 layout 属性一起动，既慢又抖。
const T_FAST = 'transition-colors duration-[120ms] ease-out'
const T_BASE = 'transition-[background-color,border-color,color,box-shadow] duration-200 ease-out'

// ── 标题层级 ──────────────────────────────
export const HEADING = {
  page:       'text-xl font-semibold tracking-[-0.01em] text-primary',
  section:    'text-lg font-semibold tracking-[-0.01em] text-primary',
  subsection: 'text-sm font-semibold text-secondary',
}

// ── 文本颜色层级 ───────────────────────────
export const TEXT = {
  primary:   'text-primary',
  body:      'text-secondary',
  secondary: 'text-secondary',
  muted:     'text-tertiary',
  disabled:  'text-tertiary opacity-70',
}

// ── 卡片 ──────────────────────────────────
export const CARD = {
  base:        'ui-panel',
  padded:      'ui-panel p-4',
  interactive: `ui-panel ${T_BASE} hover:border-strong hover:bg-state-hover hover:shadow-md`,
}

// ── Surface 阶梯 ──────────────────────────
// 越"高"越亮：sunken < base < raised < overlay < float。
// 旧版这个方向是乱的（border 比 surface 暗、surface-raised 比 surface 更暗）。
export const SURFACE = {
  frame:       'rounded-xl border border-subtle bg-surface-raised ui-elevation-float',
  panel:       'rounded-xl border border-subtle bg-surface-raised ui-elevation-raised',
  panelSoft:   'rounded-lg border border-subtle bg-surface-overlay',
  inset:       'rounded-lg border border-subtle bg-surface-sunken',
  modal:       'rounded-xl border border-default bg-surface-float ui-elevation-modal',
  chip:        'rounded-full border border-subtle bg-surface-overlay text-secondary',
  chipActive:  'rounded-full border border-brand/40 bg-state-selected text-accent-text',
  divider:     'border-subtle',
  input:       `w-full rounded-lg border border-default bg-surface-sunken px-3 py-2.25 text-sm text-primary placeholder:text-tertiary focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-transparent ${T_BASE}`,
  textarea:    `w-full rounded-lg border border-default bg-surface-sunken px-3 py-2.25 text-sm text-primary placeholder:text-tertiary focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-transparent resize-none ${T_BASE}`,
  select:      `w-full rounded-lg border border-default bg-surface-sunken px-3 py-2.25 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-transparent ${T_BASE}`,
}

// ── 按钮 ──────────────────────────────────
export const ACTION = {
  primary:   `inline-flex h-9 items-center justify-center rounded-lg bg-brand px-4 text-sm font-medium text-white ${T_FAST} hover:bg-brand-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base disabled:opacity-50`,
  secondary: `inline-flex h-9 items-center justify-center rounded-lg border border-default bg-surface-overlay px-4 text-sm font-medium text-secondary ${T_FAST} hover:bg-state-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-50`,
  subtle:    `inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-medium text-tertiary ${T_FAST} hover:bg-state-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-50`,
  danger:    `inline-flex h-9 items-center justify-center rounded-lg border border-default bg-danger-surface px-4 text-sm font-medium text-danger-text ${T_FAST} hover:bg-state-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-50`,
  icon:      `inline-flex h-9 w-9 items-center justify-center rounded-lg border border-default bg-surface-overlay text-sm font-medium text-secondary ${T_FAST} hover:bg-state-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-50`,
}

// ── 表单 ──────────────────────────────────
export const FORM = {
  label:    'mb-1 block text-sm font-medium text-secondary',
  input:    'ui-input',
  textarea: 'ui-input resize-none',
  select:   'ui-input',
  hint:     'mt-1 text-xs text-tertiary',
}
