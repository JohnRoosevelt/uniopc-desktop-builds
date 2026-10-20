#!/usr/bin/env node
// Conservative content key: changes to any builder, verifier, dependency pin,
// Rust runtime contract, bundled plugin or workflow invalidate the runtime.
import { createHash } from 'node:crypto'
import { readFile, readdir, lstat, appendFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readDeclaredVersion, OPENCLAW_RELEASE_NODE_VERSION, verifyReleaseContract } from './verify-openclaw-release-contract.mjs'
import { verifyRuntimeDirectory } from './verify-uniopc-whitelabel-runtime.mjs'
const ROOT = resolve(import.meta.dirname, '..')
export const RUNTIME_CACHE_PATHS = [
  'src-tauri/resources/uniopc-engine-runtime/uniopc-engine-runtime-win32-x64.tar.gz',
  'src-tauri/resources/uniopc-engine-runtime/uniopc-engine-runtime.catalog.json',
]
async function tree(root, relative, files) {
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    if (['node_modules', '.git', 'target'].includes(entry.name)) continue
    const name = `${relative}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error(`Cache input cannot be a symlink: ${name}`)
    if (entry.isDirectory()) await tree(root, name, files)
    else if (entry.isFile()) files.push(name)
  }
}
export async function runtimeCacheKey({ projectRoot = ROOT, platform = 'win32', arch = 'x64' } = {}) {
  if (!/^[a-z0-9]+$/.test(platform) || !/^[a-z0-9]+$/.test(arch)) throw new Error('Invalid cache platform/architecture')
  const files = ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']
  for (const directory of ['scripts', '.github/workflows', 'src-tauri/src', 'src-tauri/resources/plugins']) await tree(projectRoot, directory, files)
  for (const entry of await readdir(join(projectRoot, 'src-tauri'))) if (/^tauri.*\.json$/.test(entry)) files.push(`src-tauri/${entry}`)
  const hash = createHash('sha256')
  const version = await readDeclaredVersion(projectRoot)
  for (const file of files.sort()) {
    const info = await lstat(join(projectRoot, file))
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Cache inputs must be regular files')
    const bytes = await readFile(join(projectRoot, file))
    hash.update(`${file}\0${bytes.length}\0`); hash.update(bytes)
  }
  return `uniopc-runtime-v1-${platform}-${arch}-openclaw-${version}-node-${OPENCLAW_RELEASE_NODE_VERSION}-${hash.digest('hex')}`
}
export async function verifyCachedRuntime({ projectRoot = ROOT, verifyContract = verifyReleaseContract, verifyBranding = verifyRuntimeDirectory } = {}) {
  const runtimeDirectory = join(projectRoot, 'src-tauri/resources/uniopc-engine-runtime')
  for (const file of RUNTIME_CACHE_PATHS) {
    const info = await lstat(join(projectRoot, file))
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Runtime cache must contain regular files')
  }
  // Verify hash/size and release pins before unpacking for the branding scan.
  await verifyContract({ platform: 'win32', arch: 'x64' }, { projectRoot, runtimeDirectory })
  await verifyBranding(runtimeDirectory)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'key') {
      const key = await runtimeCacheKey()
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `key=${key}\n`)
      console.log(key)
    } else if (process.argv[2] === 'verify') await verifyCachedRuntime()
    else throw new Error('Use key or verify')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
