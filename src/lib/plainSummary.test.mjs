import test from 'node:test'
import assert from 'node:assert/strict'
import { plainSummary } from './plainSummary.js'

test('压平 markdown 列表 —— 员工列表上曾直接漏出星号', () => {
  const raw = [
    '- **项目开发：** 负责全栈项目的需求分析、架构设计',
    '- **技术实现：** 前端界面开发、后端 API 设计',
  ].join('\n')
  assert.equal(
    plainSummary(raw),
    '项目开发： 负责全栈项目的需求分析、架构设计 · 技术实现： 前端界面开发、后端 API 设计',
  )
})

test('长绝对路径只留末段 —— 项目卡片曾把三个全路径拼成两行', () => {
  const raw = '项目目录 /Users/lan/Documents/New project 2/uniopc-admin /Users/lan/Documents/New project 2/uniopc-desktop'
  assert.equal(plainSummary(raw), '项目目录 …/uniopc-admin …/uniopc-desktop')
})

test('剥掉行内标记但保留文字', () => {
  assert.equal(plainSummary('用 `npm test` 跑**全部**测试'), '用 npm test 跑全部测试')
  assert.equal(plainSummary('见 [文档](https://example.com/a/b/c)'), '见 文档')
  assert.equal(plainSummary('![封面](https://example.com/x.png) 标题'), '封面 标题')
})

test('标题与引用降为正文', () => {
  assert.equal(plainSummary('## 小节\n> 引用一句'), '小节 · 引用一句')
})

test('首尾不留孤立分隔点', () => {
  assert.equal(plainSummary('\n\n正文\n\n'), '正文')
  assert.equal(plainSummary('---\n正文'), '正文')
})

test('截断带省略号且不留尾随空格', () => {
  assert.equal(plainSummary('负责微信小店 数据分析 选品', 8), '负责微信小店 数…')
  assert.equal(plainSummary('短', 8), '短')
})

test('空输入返回空串而不是 undefined', () => {
  assert.equal(plainSummary(''), '')
  assert.equal(plainSummary(null), '')
  assert.equal(plainSummary('   \n  '), '')
})
