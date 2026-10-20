import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const expectedOrigin = 'https://spb-bp1f48p09a51z42o.supabase.opentrust.net'

test('main-v2 update checks and Tauri updater use only the selected Supabase project', () => {
  const appUpdate = readFileSync(join(root, 'src/lib/appUpdate.js'), 'utf8')
  const tauri = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  const endpoint = appUpdate.match(/const DESKTOP_UPDATER_ENDPOINT = '([^']+)'/)?.[1]

  assert.equal(endpoint, `${expectedOrigin}/functions/v1/desktop-updater`)
  assert.deepEqual(tauri.plugins.updater.endpoints, [
    `${expectedOrigin}/storage/v1/object/public/desktop-releases/imai-desktop/stable/{{target}}/{{arch}}/latest.json`,
  ])
  assert.doesNotMatch(appUpdate, /spb-bp10i1915oj07495/)
  assert.doesNotMatch(JSON.stringify(tauri.plugins.updater), /spb-bp10i1915oj07495/)
})
