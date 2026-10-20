import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('./MobileConnect.jsx', import.meta.url), 'utf8')

test('mobile LAN restart failure renders the backend authoritative state', () => {
  const handler = source
    .split('async function handleToggleLan(next)')[1]
    .split('// On profile change')[0]

  assert.match(handler, /authoritativeEnabled/)
  assert.match(handler, /recoveryRequired/)
  assert.match(handler, /openclaw_mobile_lan_status/)
  assert.doesNotMatch(handler, /setAllowConnect\(!next\)/)
})
