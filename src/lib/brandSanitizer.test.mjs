import assert from 'node:assert/strict'
import test from 'node:test'

import { sanitizeBrand } from './brandSanitizer.js'

test('brand sanitizer removes upstream names from user-visible assistant content', () => {
  const raw = [
    'OpenClaw Gateway is starting.',
    'Run openclaw doctor --non-interactive.',
    'Then run openclaw secrets apply and openclaw backup create.',
    'Update @openclaw/codex or visit docs.openclaw.ai.',
  ].join('\n')

  const displayed = sanitizeBrand(raw)

  assert.doesNotMatch(displayed, /openclaw/i)
  assert.match(displayed, /Uniopc 本地服务/)
  assert.match(displayed, /运行环境诊断/)
  assert.match(displayed, /应用模型密钥/)
  assert.match(displayed, /创建本地备份/)
  assert.match(displayed, /Uniopc 模型组件/)
})

test('brand sanitizer removes the upstream CLI name from a displayed tool payload', () => {
  const displayed = sanitizeBrand('{"command":"openclaw plugins list --json"}')

  assert.equal(displayed, '{"command":"Uniopc plugins list --json"}')
  assert.doesNotMatch(displayed, /openclaw/i)
})

test('brand sanitizer hides private state media paths from assistant prose', () => {
  const displayed = sanitizeBrand(
    'outputPath: /Users/alice/Library/Application Support/Uniopc/state-v8/openclaw-2026_8_1/profile-a/media/uniopc-superip/superip-42.mp4',
  )

  assert.equal(displayed, 'outputPath: 本地视频：superip-42.mp4')
  assert.doesNotMatch(displayed, /state-v8|openclaw|\/Users\/alice/i)
})

test('brand sanitizer preserves non-string values and unrelated product names', () => {
  assert.equal(sanitizeBrand(null), null)
  assert.equal(sanitizeBrand('使用 Uniopc AI 助理'), '使用 Uniopc AI 助理')
})
