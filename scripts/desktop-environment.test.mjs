import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { loadEnv } from 'vite'

const root = process.cwd()
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

function projectRef(key) {
  try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).ref } catch { return null }
}

test('development and production frontend modes use their matching backend projects', () => {
  const development = loadEnv('dev', root, 'VITE_')
  const production = loadEnv('prod', root, 'VITE_')
  assert.equal(new URL(development.VITE_SUPABASE_URL).hostname, 'spb-bp10i1915oj07495.supabase.opentrust.net')
  assert.equal(projectRef(development.VITE_SUPABASE_ANON_KEY), 'spb-bp10i1915oj07495')
  assert.equal(new URL(development.VITE_PLUGINS_SUPABASE_URL).hostname, 'spb-bp1gvnmm7m9oat33.supabase.opentrust.net')
  assert.equal(projectRef(development.VITE_PLUGINS_SUPABASE_ANON_KEY), 'spb-bp1gvnmm7m9oat33')
  assert.equal(new URL(production.VITE_SUPABASE_URL).hostname, 'spb-bp1f48p09a51z42o.supabase.opentrust.net')
  assert.equal(projectRef(production.VITE_SUPABASE_ANON_KEY), 'spb-bp1f48p09a51z42o')
  assert.equal(new URL(production.VITE_PLUGINS_SUPABASE_URL).hostname, 'spb-bp159ozk3o51rv4v.supabase.opentrust.net')
  assert.equal(projectRef(production.VITE_PLUGINS_SUPABASE_ANON_KEY), 'spb-bp159ozk3o51rv4v')
})

test('normal development and release commands select explicit Vite modes', () => {
  assert.match(packageJson.scripts.dev, /vite --mode dev/)
  assert.match(packageJson.scripts.build, /vite\.js build --mode prod/)
})
