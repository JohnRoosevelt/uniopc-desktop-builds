#!/usr/bin/env node

// CI glue: take the bundle paths produced by a Tauri build (e.g. tauri-action's
// `artifactPaths` output) and publish them to the Supabase release channel via
// releaseDesktopUpdater — once per arch. A single universal macOS bundle is thus
// published under BOTH darwin/aarch64 and darwin/x86_64, so Apple-silicon and
// Intel Macs each resolve a working installer + auto-update manifest.

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadEnvFile, releaseDesktopUpdater } from './release-desktop-updater.mjs'

// Resolve the updater artifact, installer, and detached signature from a flat
// list of bundle paths. Tauri writes the `.sig` next to its artifact, so it is
// derived rather than required in the list.
export function pickPlatformArtifacts(platform, artifactPaths = []) {
  const paths = artifactPaths.map((value) => String(value)).filter(Boolean)
  if (platform === 'darwin') {
    const updater = paths.find((path) => path.endsWith('.app.tar.gz'))
    const installer = paths.find((path) => path.endsWith('.dmg'))
    if (!updater) throw new Error('No macOS updater artifact (*.app.tar.gz) in artifact paths')
    if (!installer) throw new Error('No macOS installer (*.dmg) in artifact paths')
    return { updaterPath: updater, installerPath: installer, signaturePath: `${updater}.sig` }
  }
  if (platform === 'windows') {
    const setup = paths.find((path) => /-setup\.exe$/i.test(path)) || paths.find((path) => path.toLowerCase().endsWith('.exe'))
    if (!setup) throw new Error('No Windows NSIS installer (*-setup.exe) in artifact paths')
    // On Windows the NSIS installer is itself the updater artifact.
    return { updaterPath: setup, installerPath: setup, signaturePath: `${setup}.sig` }
  }
  if (platform === 'linux') {
    // AppImage only: it is the one Linux bundle the Tauri v2 updater can
    // self-update, and it doubles as the installer download (deb/rpm would
    // need a separate non-updating channel).
    const appImage = paths.find((path) => path.endsWith('.AppImage'))
    if (!appImage) throw new Error('No Linux AppImage (*.AppImage) in artifact paths')
    return { updaterPath: appImage, installerPath: appImage, signaturePath: `${appImage}.sig` }
  }
  throw new Error(`Unsupported platform: ${platform}`)
}

// The stable installer alias the marketing site links to, per platform/arch.
export function installerAliasFileName(platform, arch) {
  if (platform === 'windows') return `Uniopc_${arch}-setup.exe`
  if (platform === 'linux') return `Uniopc_${arch}.AppImage`
  return `Uniopc_${arch}.dmg`
}

export async function ciPublishDesktopArtifacts(options, deps) {
  const {
    platform,
    archs,
    artifactPaths,
    promote = false,
    notes,
    publishedAt,
    env,
    // Optional overrides; default to the repo's real files in CI.
    desktopPackagePath,
    cargoTomlPath,
    tauriConfigPath,
  } = options
  if (!platform) throw new Error('platform is required')
  if (!Array.isArray(archs) || archs.length === 0) throw new Error('at least one arch is required')

  const { updaterPath, installerPath, signaturePath } = pickPlatformArtifacts(platform, artifactPaths)

  const results = []
  for (const arch of archs) {
    const result = await releaseDesktopUpdater(
      {
        app: 'admin',
        target: platform,
        arch,
        artifactPath: updaterPath,
        signaturePath,
        installerPath,
        installerAliasFileName: installerAliasFileName(platform, arch),
        promote,
        notes,
        publishedAt,
        env,
        desktopPackagePath,
        cargoTomlPath,
        tauriConfigPath,
      },
      deps,
    )
    results.push(result)
  }
  return results
}

function parseArgs(argv) {
  const args = { platform: '', archs: [], artifactPaths: [], promote: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    switch (arg) {
      case '--platform':
        args.platform = next
        index += 1
        break
      case '--archs':
        args.archs = String(next || '').split(',').map((value) => value.trim()).filter(Boolean)
        index += 1
        break
      case '--artifact-paths':
        // JSON array (as emitted by tauri-action's artifactPaths output).
        args.artifactPaths = JSON.parse(next)
        index += 1
        break
      case '--notes':
        args.notes = next
        index += 1
        break
      case '--published-at':
        args.publishedAt = next
        index += 1
        break
      case '--promote':
        args.promote = true
        break
      case '--env-file':
        args.envFile = resolve(next)
        index += 1
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const fileEnv = args.envFile ? await loadEnvFile(args.envFile) : {}
  const results = await ciPublishDesktopArtifacts({
    ...args,
    env: { ...process.env, ...fileEnv },
  })
  for (const result of results) {
    console.log(`published ${result.row.target}/${result.row.arch} ${result.row.version} (active=${result.row.active})`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error)
    process.exit(1)
  })
}
