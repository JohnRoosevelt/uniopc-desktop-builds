import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveDesktopReleaseSettings } from './desktop-release-settings.mjs'

test('public defaults follow the application endpoint and signing identity, with empty overrides treated as absent', async () => {
  const config = JSON.parse(await readFile(resolve('src-tauri/tauri.conf.json'), 'utf8'))
  const settings = resolveDesktopReleaseSettings({ SUPABASE_URL: '', SUPABASE_RELEASE_BUCKET: '', APPLE_SIGNING_IDENTITY: '', APPLE_TEAM_ID: '' })
  const endpoint = new URL(config.plugins.updater.endpoints[0])
  assert.equal(settings.SUPABASE_URL, endpoint.origin)
  assert.equal(settings.SUPABASE_RELEASE_BUCKET, 'desktop-releases')
  assert.equal(settings.APPLE_SIGNING_IDENTITY, config.bundle.macOS.signingIdentity)
  assert.equal(settings.APPLE_TEAM_ID, config.bundle.macOS.signingIdentity.match(/\(([A-Z0-9]{10})\)$/)[1])
  assert.equal(resolveDesktopReleaseSettings({ APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (123456ABCD)' }).APPLE_TEAM_ID, '123456ABCD')
})

test('rejects invalid updater endpoint and newline injection before writing GitHub environment values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-release-settings-'))
  try {
    await mkdir(join(root, 'src-tauri'))
    const config = JSON.parse(await readFile(resolve('src-tauri/tauri.conf.json'), 'utf8'))
    config.plugins.updater.endpoints = ['http://example.com/anything']
    await writeFile(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify(config))
    assert.throws(() => resolveDesktopReleaseSettings({}, root), /HTTPS Storage bucket/)
    assert.throws(() => resolveDesktopReleaseSettings({ APPLE_TEAM_ID: 'BAD\nOTHER=value' }), /Invalid public/)
    assert.throws(() => resolveDesktopReleaseSettings({ APPLE_TEAM_ID: 'too-short' }), /Invalid Apple/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('actual CLI prepares all four public values for a signed job without Actions secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-release-settings-cli-'))
  try {
    const destination = join(root, 'public.env')
    execFileSync(process.execPath, [resolve('scripts/desktop-release-settings.mjs'), '--github-env'], { env: { ...process.env, GITHUB_ENV: destination } })
    const text = await readFile(destination, 'utf8')
    for (const [name, value] of Object.entries(resolveDesktopReleaseSettings())) assert.ok(text.includes(`${name}=${value}\n`))
    assert.ok(!text.includes('PRIVATE_KEY'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
