#!/usr/bin/env node

import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, open, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SECRET_KEYS = [
  'UNIOPC_RELEASE_PREPARE_URL',
  'UNIOPC_RELEASE_PREPARE_TOKEN',
  'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY',
  'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY',
  'UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID',
  'UNIOPC_PLUGIN_AUDIT_RELEASE_NONCE',
]

function requireOutputPath(outputPath) {
  const value = String(outputPath || '').trim()
  if (!value) throw new Error('release_secret_output_invalid')
  return value
}

function runIcacls(args) {
  return new Promise((resolvePromise, reject) => {
    execFile('icacls', args, { windowsHide: true }, error => {
      if (error) reject(new Error('release_secret_file_permissions_invalid'))
      else resolvePromise()
    })
  })
}

async function restrictToOwner(path) {
  if (process.platform === 'win32') {
    const domain = String(process.env.USERDOMAIN || '').trim()
    const username = String(process.env.USERNAME || '').trim()
    if (!domain || !username) throw new Error('release_secret_file_permissions_invalid')
    await runIcacls([path, '/inheritance:r', '/grant:r', `${domain}\\${username}:(F)`])
    return 0o600
  }
  await chmod(path, 0o600)
  const mode = (await stat(path)).mode & 0o777
  if (mode !== 0o600) throw new Error('release_secret_file_permissions_invalid')
  return mode
}

export async function generateReleaseSecrets(outputPath, { prepareUrl = '', updaterPrivateKey = '' } = {}, {
  openFile = open,
  restrictFile = restrictToOwner,
} = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' })
  const publicDer = publicKey.export({ format: 'der', type: 'spki' })
  const privateValue = privateDer.toString('base64')
  const publicValue = publicDer.toString('base64')
  if (updaterPrivateKey && privateValue === updaterPrivateKey) throw new Error('audit_key_must_not_match_updater_key')
  const keyId = `openclaw-audit-${createHash('sha256').update(publicDer).digest('hex').slice(0, 16)}`
  const values = {
    UNIOPC_RELEASE_PREPARE_URL: String(prepareUrl).trim(),
    UNIOPC_RELEASE_PREPARE_TOKEN: randomBytes(32).toString('base64'),
    UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY: privateValue,
    UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY: publicValue,
    UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID: keyId,
    UNIOPC_PLUGIN_AUDIT_RELEASE_NONCE: randomBytes(32).toString('base64'),
  }
  const text = `${SECRET_KEYS.map(key => `${key}=${values[key]}`).join('\n')}\n`
  const path = requireOutputPath(outputPath)
  const handle = await openFile(path, 'wx', 0o600)
  try {
    const mode = await restrictFile(path)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    return { mode, keyId, valuesPrinted: false, privateKeyEqualsUpdaterKey: false }
  } finally {
    await handle.close()
  }
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return { help: true }
    if (!['--output', '--prepare-url'].includes(option)) throw new Error(`Unknown option: ${option}`)
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${option}`)
    args[option.slice(2).replaceAll('-', '_')] = value
    index += 1
  }
  if (!args.output) throw new Error('Missing required option: --output')
  return args
}

function usage() {
  return 'Usage: node scripts/generate-openclaw-release-secrets.mjs --output /absolute/path/to/.env.release-secrets [--prepare-url https://server.example/functions/v1/prepare-openclaw-release]'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  const result = await generateReleaseSecrets(resolve(args.output), { prepareUrl: args.prepare_url })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error.message || error)
    process.exitCode = 1
  })
}
