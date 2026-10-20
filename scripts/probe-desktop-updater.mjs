#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

function requiredText(value, code) {
  const text = String(value || '').trim()
  if (!text || /[\r\n\0]/.test(text)) throw new Error(code)
  return text
}

function canonicalContract(status, offeredVersion) {
  return JSON.stringify({ offeredVersion, status })
}

function updaterRequestUrl(endpoint, currentVersion) {
  let url
  try {
    url = new URL(requiredText(endpoint, 'updater_endpoint_invalid'))
  } catch {
    throw new Error('updater_endpoint_invalid')
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('updater_endpoint_https_required')
  }
  const version = requiredText(currentVersion, 'updater_current_version_invalid')
  if (url.pathname.includes('{{current_version}}')) {
    url.pathname = url.pathname.replace('{{current_version}}', encodeURIComponent(version))
  } else {
    url.searchParams.set('current_version', version)
  }
  return url.toString()
}

export async function probeDesktopUpdater({ endpoint, currentVersion, fetch: fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('updater_fetch_invalid')
  const response = await fetchImpl(updaterRequestUrl(endpoint, currentVersion), {
    method: 'GET',
    redirect: 'error',
  })
  if (!response || !Number.isInteger(response.status)) throw new Error('updater_response_invalid')
  if (response.status !== 200 && response.status !== 204) {
    throw new Error(`updater_probe_http_${response.status}`)
  }
  let offeredVersion = ''
  if (response.status === 200) {
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new Error('updater_response_invalid')
    }
    offeredVersion = requiredText(payload?.version, 'updater_response_invalid')
  }
  const status = response.status
  return {
    status,
    offeredVersion,
    contractSha256: createHash('sha256').update(canonicalContract(status, offeredVersion)).digest('hex'),
  }
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return { help: true }
    if (!['--endpoint', '--current-version'].includes(option) || !argv[index + 1]) {
      throw new Error('updater_probe_arguments_invalid')
    }
    const key = option.slice(2).replaceAll('-', '')
    if (args[key]) throw new Error('updater_probe_arguments_invalid')
    args[key] = argv[index + 1]
    index += 1
  }
  return { endpoint: args.endpoint, currentVersion: args.currentversion }
}

function usage() {
  return 'Usage: node scripts/probe-desktop-updater.mjs --endpoint https://server.example/updater --current-version 0.4.0'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  console.log(JSON.stringify(await probeDesktopUpdater(args)))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message || error)
    process.exitCode = 1
  })
}
