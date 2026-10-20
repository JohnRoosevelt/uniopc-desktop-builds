import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('macOS notification permission probing guards non-app binaries and bridges notification center lookup onto the main queue', () => {
  const service = read('src-tauri/src/services/mac_permissions.rs')

  assert.equal(service.includes('std::env::current_exe'), true)
  assert.equal(service.includes('.app/Contents/MacOS'), true)
  assert.equal(service.includes('dispatch_get_main_queue'), true)
  assert.equal(service.includes('dispatch_sync_f'), true)
  assert.equal(service.includes('notification_center'), true)
})
