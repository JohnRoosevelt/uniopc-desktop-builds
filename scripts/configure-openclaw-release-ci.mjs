#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SECRET_NAMES = [
  'UNIOPC_RELEASE_PREPARE_URL',
  'UNIOPC_RELEASE_PREPARE_TOKEN',
  'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY',
  'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY',
]
const VARIABLE_NAME = 'UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID'
const VALUE_NAMES = [...SECRET_NAMES, VARIABLE_NAME]
const SECRET_ENV_NAMES = [...VALUE_NAMES, 'UNIOPC_PLUGIN_AUDIT_RELEASE_NONCE']
const APPROVED_PREPARE_URL = 'https://spb-bp1f48p09a51z42o.supabase.opentrust.net/functions/v1/prepare-openclaw-release'

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function validValues(values) {
  return exactKeys(values, VALUE_NAMES)
    && VALUE_NAMES.every(name => typeof values[name] === 'string' && values[name].trim() && !/[\r\n\0]/.test(values[name]))
    && values.UNIOPC_RELEASE_PREPARE_URL === APPROVED_PREPARE_URL
    && /^openclaw-audit-[0-9a-f]{16}$/.test(values[VARIABLE_NAME])
}

export async function configureReleaseCi({ values, run = runGh } = {}) {
  if (!validValues(values) || typeof run !== 'function') throw new Error('release_ci_values_invalid')
  for (const name of SECRET_NAMES) {
    await run('gh', ['secret', 'set', name], { stdin: values[name] })
  }
  await run('gh', ['variable', 'set', VARIABLE_NAME, '--body', values[VARIABLE_NAME]], { stdin: '' })
  return { updated: [...VALUE_NAMES] }
}

function runGh(command, args, { stdin }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    child.once('error', () => reject(new Error('github_cli_failed')))
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error('github_cli_failed'))
    })
    child.stdin.end(stdin)
  })
}

function parseEnvironment(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    const index = line.indexOf('=')
    if (index <= 0) throw new Error('release_ci_values_invalid')
    values[line.slice(0, index)] = line.slice(index + 1)
  }
  return values
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (!['--secrets-file', '--secrets-env', '--prepare-url'].includes(option) || !argv[index + 1]) throw new Error(usage())
    const key = option.slice(2).replaceAll('-', '_')
    if (args[key]) throw new Error(usage())
    args[key] = argv[index + 1]
    index += 1
  }
  const secretsFile = args.secrets_env || args.secrets_file
  if (!secretsFile || (args.secrets_env && args.secrets_file) || (args.secrets_env && !args.prepare_url)) throw new Error(usage())
  return { secretsFile, prepareUrl: args.prepare_url, secretsEnv: Boolean(args.secrets_env) }
}

function valuesFromSecretEnvironment(text, prepareUrl, { requireBlankSourceUrl = false } = {}) {
  const environment = parseEnvironment(text)
  const expectedKeys = requireBlankSourceUrl ? SECRET_ENV_NAMES : VALUE_NAMES
  if (!exactKeys(environment, expectedKeys)) throw new Error('release_ci_values_invalid')
  if (requireBlankSourceUrl && environment.UNIOPC_RELEASE_PREPARE_URL !== '') throw new Error('release_ci_values_invalid')
  const values = Object.fromEntries(VALUE_NAMES.map(name => [name, environment[name]]))
  if (prepareUrl) values.UNIOPC_RELEASE_PREPARE_URL = prepareUrl
  if (!validValues(values)) throw new Error('release_ci_values_invalid')
  return values
}

function usage() {
  return 'Usage: node scripts/configure-openclaw-release-ci.mjs --secrets-file /absolute/path/to/.env.release-secrets | --secrets-env /absolute/path/to/secrets.env --prepare-url https://server.example/functions/v1/prepare-openclaw-release'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  const values = valuesFromSecretEnvironment(await readFile(resolve(args.secretsFile), 'utf8'), args.prepareUrl, {
    requireBlankSourceUrl: args.secretsEnv,
  })
  const result = await configureReleaseCi({ values })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error.message || error)
    process.exitCode = 1
  })
}
