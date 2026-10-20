import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./apps/PrivateConversionApp.jsx', import.meta.url), 'utf8')

test('private conversion generates release QR codes only', () => {
  assert.match(source, /envVersion: 'release'/)
  assert.doesNotMatch(source, /qrEnvVersion/)
  assert.doesNotMatch(source, /体验版/)
  assert.doesNotMatch(source, /envVersion === 'trial'/)
})
