import assert from 'node:assert/strict'
import test from 'node:test'

import { openFenceMarker, repairStreamingMarkdownTail } from './markdownStreamRepair.js'

test('leaves complete markdown untouched', () => {
  const samples = [
    '',
    'plain text',
    '# 标题\n\n- a\n- b',
    '`inline` and **bold** and ~~gone~~',
    '```js\nconst a = 1\n```\ndone',
    'para one\n\npara two with `code` pair',
  ]
  for (const sample of samples) {
    assert.equal(repairStreamingMarkdownTail(sample), sample)
  }
})

test('closes an unfinished fenced code block', () => {
  assert.equal(repairStreamingMarkdownTail('```js\nconst a = 1'), '```js\nconst a = 1\n```')
  assert.equal(repairStreamingMarkdownTail('前文\n\n~~~python\nprint(1)'), '前文\n\n~~~python\nprint(1)\n~~~')
})

test('longer closing fences still close the block', () => {
  assert.equal(openFenceMarker('````md\n```inner\n````'), '')
  assert.equal(openFenceMarker('```js\ncode\n```'), '')
  assert.equal(openFenceMarker('```js\ncode'), '```')
})

test('does not repair inline pairs while inside an open fence', () => {
  const streaming = '```js\nconst bold = "**not markdown'
  assert.equal(repairStreamingMarkdownTail(streaming), `${streaming}\n\`\`\``)
})

test('closes dangling inline code in the tail paragraph', () => {
  assert.equal(repairStreamingMarkdownTail('运行 `npm ins'), '运行 `npm ins`')
})

test('closes dangling bold and strikethrough in the tail paragraph', () => {
  assert.equal(repairStreamingMarkdownTail('这是 **重点'), '这是 **重点**')
  assert.equal(repairStreamingMarkdownTail('这是 ~~删除'), '这是 ~~删除~~')
  assert.equal(repairStreamingMarkdownTail('`a` 然后 **b'), '`a` 然后 **b**')
})

test('earlier complete paragraphs never trigger repair', () => {
  const value = '之前有 **完整加粗**\n\n新段落纯文本'
  assert.equal(repairStreamingMarkdownTail(value), value)
})

test('single stars are left alone (streaming bullets)', () => {
  assert.equal(repairStreamingMarkdownTail('* 第一点\n* 第二'), '* 第一点\n* 第二')
})

test('backtick runs longer than one are not inline code', () => {
  // The tail contains "``" (an empty inline pair boundary) — even count, no repair.
  assert.equal(repairStreamingMarkdownTail('a `` b'), 'a `` b')
})
