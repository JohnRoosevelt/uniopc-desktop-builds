#!/usr/bin/env node
// Public release settings have one source: the configuration compiled into the app.
import { readFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const ROOT = resolve(import.meta.dirname, '..')

export function resolveDesktopReleaseSettings(env = {}, repoRoot = ROOT) {
  const conf = JSON.parse(readFileSync(resolve(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'))
  const endpoint = new URL(conf.plugins.updater.endpoints[0])
  const match = endpoint.pathname.match(/^\/storage\/v1\/object\/public\/([^/]+)\//)
  if (endpoint.protocol !== 'https:' || !match) throw new Error('Updater endpoint must identify a public HTTPS Storage bucket')
  const identity = env.APPLE_SIGNING_IDENTITY || conf.bundle.macOS.signingIdentity
  const team = env.APPLE_TEAM_ID || identity.match(/\(([A-Z0-9]{10})\)$/)?.[1]
  const values = {
    SUPABASE_URL: env.SUPABASE_URL || endpoint.origin,
    SUPABASE_RELEASE_BUCKET: env.SUPABASE_RELEASE_BUCKET || decodeURIComponent(match[1]),
    APPLE_SIGNING_IDENTITY: identity,
    APPLE_TEAM_ID: team,
  }
  for (const [name, value] of Object.entries(values)) {
    if (!value || /[\r\n\0]/.test(value)) throw new Error(`Invalid public release setting: ${name}`)
  }
  if (!/^[A-Z0-9]{10}$/.test(values.APPLE_TEAM_ID)) throw new Error('Invalid Apple team ID')
  return values
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).join(' ') !== '--github-env' || !process.env.GITHUB_ENV) throw new Error('Use --github-env in a GitHub Actions step')
    const values = resolveDesktopReleaseSettings()
    appendFileSync(process.env.GITHUB_ENV, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(''))
    console.log('Public release settings loaded from src-tauri/tauri.conf.json; no Actions secrets needed for these four fields.')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
