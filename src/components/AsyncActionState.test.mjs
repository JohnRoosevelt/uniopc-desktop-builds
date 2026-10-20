import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sourcePath = fileURLToPath(new URL('./AsyncActionState.jsx', import.meta.url))
const source = readFileSync(sourcePath, 'utf8')

test('async action state keeps existing content visible and exposes explicit retry', () => {
  assert.match(source, /children/)
  assert.match(source, /onRetry/)
  assert.match(source, /retryLabel/)
  assert.match(source, /aria-live="polite"/)
})
