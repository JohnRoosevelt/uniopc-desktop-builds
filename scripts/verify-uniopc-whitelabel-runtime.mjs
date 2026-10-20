#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RUNTIME_DIR = join(PROJECT_ROOT, 'src-tauri', 'resources', 'uniopc-engine-runtime')
const CATALOG = 'uniopc-engine-runtime.catalog.json'
const BRANDED_ENGINE_ROOT = /^tools\/node(?:-v[^/]+)?\/(?:lib\/)?node_modules\/uniopc-engine(?:\/|$)/i
const LEGAL_ATTRIBUTION_LINES = [
  'Copyright (c) 2026 OpenClaw Foundation',
  'portions incorporated into OpenClaw source, beyond normal package-manager',
  'Portions of OpenClaw were adapted from Pi / pi-mono, and OpenClaw also depends',
  'OPENCLAW_ATTRIBUTION_PRODUCT = "OpenClaw"',
  '"MM-API-Source": "OpenClaw"',
  '"MM-API-Source":"OpenClaw"',
  '"X-OpenRouter-Title": "OpenClaw"',
  '"X-OpenRouter-Title":"OpenClaw"',
]
export function assertRuntimeEntryNamesBranded(names) {
  const violations = names.map(name => name.replace(/^\.\//, '')).filter(name => (
    /openclaw|小龙虾/i.test(name)
    && (/\/@openclaw(?:\/|$)/i.test(name) || /\/(?:openclaw\.mjs|openclaw\.plugin\.json)$/i.test(name)
      || (BRANDED_ENGINE_ROOT.test(name) && /\/dist\/.*openclaw[^/]*\.(?:js|mjs|cjs|d\.ts|d\.mts|png)$/i.test(name) && !/\/openclaw\.plugin\.json$/i.test(name))
      || !BRANDED_ENGINE_ROOT.test(name))
  ))
  assert.deepEqual(violations, [], `Unbranded runtime path(s): ${violations.join(', ')}`)
}

export function assertRuntimeWorkspaceTemplatesPackaged(names) {
  const normalized = names.map(name => name.replace(/^\.\//, ''))
  const templateRoot = normalized.find(name => /^tools\/node(?:-v[^/]+)?\/(?:lib\/)?node_modules\/uniopc-engine\/docs\/reference\/templates\/AGENTS\.md$/.test(name))
  assert.ok(templateRoot, 'Runtime archive must include the AGENTS.md workspace template')
  const templateDirectory = templateRoot.slice(0, -'AGENTS.md'.length)
  for (const required of ['SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md']) {
    assert.ok(normalized.includes(`${templateDirectory}${required}`), `Runtime archive must include ${required}`)
  }
}

export function listResidualRuntimePaths(names) {
  const residuals = new Set()
  for (const rawName of names) {
    const name = rawName.replace(/^\.\//, '')
    if (!/openclaw|小龙虾/i.test(name)) continue
    const scoped = name.match(/^tools\/node(?:-v[^/]+)?\/(?:lib\/)?node_modules\/@openclaw\/[^/]+/i)
    residuals.add(scoped?.[0] || name)
  }
  return [...residuals].sort()
}

export function assertRuntimeTextBranded(text, label = 'runtime text') {
  let checked = text
  for (const allowed of LEGAL_ATTRIBUTION_LINES) checked = checked.split(allowed).join('')
  // Match visible brand words, while leaving OpenClaw-derived code identifiers
  // and protocol constants intact for upstream package self-resolution.
  const match = checked.match(/(?<![A-Za-z0-9_])OpenClaw(?![A-Za-z0-9_])|小龙虾/)
  assert.equal(match, null, `Unbranded user-facing runtime string in ${label}: ${match?.[0]}`)
}

function assertRuntimeFileTextBranded(text, label) {
  const lines = text.split(/\r?\n/)
  const violations = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    let line = lines[lineIndex]
    for (const allowed of LEGAL_ATTRIBUTION_LINES) line = line.split(allowed).join('')
    if (/(?<![A-Za-z0-9_])OpenClaw(?![A-Za-z0-9_])|小龙虾/i.test(line)) {
      violations.push(`${label}:${lineIndex + 1}`)
    }
  }
  return violations
}

const USER_VISIBLE_METADATA_KEYS = new Set(['description', 'displayName', 'title', 'productName', 'shortDescription'])
const INTERNAL_TEXT_ALLOWLIST = [
  {
      path: /\/uniopc-engine\/dist\/control-ui[^/]*\.js$/i,
    reason: 'Compiled Control UI retains internal API/property identifiers; standalone UI brand words are patched during bundle preparation.',
  },
  {
    path: /\/node_modules\/@uniopc\/[^/]+\/dist\/[^/]+\.m?js$/i,
    reason: 'Bundled upstream AI SDK code retains immutable package and protocol identifiers.',
  },
  {
    path: /\/pnpm-workspace\.yaml$/i,
    reason: 'Upstream workspace configuration uses package aliases required by the installed dependency graph.',
  },
]

export function classifyInternalTextPath(path) {
  return INTERNAL_TEXT_ALLOWLIST.find(rule => rule.path.test(`/${path.replace(/^\//, '')}`))?.reason ?? null
}

function countBrandOccurrences(text) {
  return [...text.matchAll(/OpenClaw|小龙虾/gi)].length
}

function collectVisibleMetadata(value, key = '', found = []) {
  if (typeof value === 'string') {
    if (USER_VISIBLE_METADATA_KEYS.has(key)) found.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectVisibleMetadata(item, key, found)
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) collectVisibleMetadata(child, childKey, found)
  }
  return found
}

function isReadableText(buffer) {
  if (buffer.includes(0)) return false
  const decoded = buffer.toString('utf8')
  return !decoded.includes('\uFFFD')
}

async function walk(directory, callback) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path, callback)
    else if (entry.isFile()) await callback(path)
  }
}

function tarBin() {
  if (process.platform !== 'win32') return 'tar'
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return join(root, 'System32', 'tar.exe')
}

export async function verifyRuntimeDirectory(runtimeDirectory = RUNTIME_DIR) {
  const catalogText = await readFile(join(runtimeDirectory, CATALOG), 'utf8')
  const textViolations = assertRuntimeFileTextBranded(catalogText, CATALOG)
  const catalog = JSON.parse(catalogText)
  assert.ok(Array.isArray(catalog.artifacts) && catalog.artifacts.length > 0, 'runtime catalog must contain artifacts')
  const residualPaths = new Set()
  const internalTextResiduals = new Map()
  for (const artifact of catalog.artifacts) {
    assert.ok(/^uniopc-engine-runtime-[a-z0-9-]+\.tar\.gz$/i.test(artifact.archive), `unbranded archive name required: ${artifact.archive}`)
    const archive = join(runtimeDirectory, artifact.archive)
    const names = execFileSync(tarBin(), ['-tzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split(/\r?\n/).filter(Boolean)
    assertRuntimeEntryNamesBranded(names)
    assertRuntimeWorkspaceTemplatesPackaged(names)
    for (const name of listResidualRuntimePaths(names)) residualPaths.add(name)
    const stage = await mkdtemp(join(tmpdir(), 'uniopc-runtime-brand-scan-'))
    try {
      execFileSync(tarBin(), ['-xzf', archive, '-C', stage], { stdio: 'ignore' })
      await walk(stage, async path => {
        const rel = path.slice(stage.length + 1).replaceAll('\\', '/')
        const normalized = rel.replace(/^\.\//, '')
        const bytes = await readFile(path).catch(() => null)
        if (bytes === null || !isReadableText(bytes)) return
        const text = bytes.toString('utf8')
        const internalReason = classifyInternalTextPath(normalized)
        if (internalReason) {
          const count = countBrandOccurrences(text)
          if (count) internalTextResiduals.set(normalized, { count, reason: internalReason })
          return
        }
        if (/\.json$/i.test(normalized)) {
          try {
            const metadata = JSON.parse(text)
            if (/\/cli-startup-metadata\.json$/i.test(normalized)) {
              for (const key of ['browserHelpText', 'secretsHelpText', 'nodesHelpText', 'rootHelpText']) {
                if (typeof metadata[key] !== 'string') throw new Error(`Missing ${key} in ${normalized}`)
                try { assertRuntimeTextBranded(metadata[key], `${normalized}:${key}`) }
                catch { textViolations.push(`${normalized}:${key}`) }
              }
              if (!metadata.subcommandHelpText || typeof metadata.subcommandHelpText !== 'object') {
                throw new Error(`Missing subcommandHelpText in ${normalized}`)
              }
              for (const [command, help] of Object.entries(metadata.subcommandHelpText)) {
                if (typeof help !== 'string') throw new Error(`Invalid help text for ${command} in ${normalized}`)
                try { assertRuntimeTextBranded(help, `${normalized}:subcommandHelpText.${command}`) }
                catch { textViolations.push(`${normalized}:subcommandHelpText.${command}`) }
              }
            }
            for (const value of collectVisibleMetadata(metadata)) {
              textViolations.push(...assertRuntimeFileTextBranded(value, normalized))
            }
          } catch {
            // Non-JSON files with a JSON-like suffix are checked as readable text below.
            textViolations.push(...assertRuntimeFileTextBranded(text, normalized))
          }
        } else if (/\.(?:js|mjs)$/i.test(normalized)
          && /\/dist\//i.test(`/${normalized}`)
          && /\/node_modules\/uniopc-engine\//i.test(`/${normalized}`)) {
          try {
            assertRuntimeTextBranded(text, normalized)
          } catch {
            textViolations.push(normalized)
          }
        } else if (/\.(?:html|txt|xml|yaml|yml|toml)$/i.test(normalized)
          || /\/docs\/reference\/templates\/[^/]+\.md$/i.test(normalized)) {
          textViolations.push(...assertRuntimeFileTextBranded(text, normalized))
        }
      })
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }
  assert.deepEqual(textViolations, [], `Unbranded runtime text occurrence(s):\n${textViolations.join('\n')}`)
  return {
    artifactCount: catalog.artifacts.length,
    residualPaths: [...residualPaths].sort(),
    internalTextResiduals: [...internalTextResiduals.entries()].sort(([a], [b]) => a.localeCompare(b)),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2]
  if (target === '--help' || target === '-h') {
    console.log('Usage: node scripts/verify-uniopc-whitelabel-runtime.mjs [runtime-directory]')
    process.exit(0)
  }
  verifyRuntimeDirectory(target ? resolve(target) : RUNTIME_DIR)
    .then(result => {
      console.log(`Uniopc runtime branding verified (${result.artifactCount} artifact(s)).`)
      console.log(`Allowed upstream package path residuals (${result.residualPaths.length}):`)
      for (const path of result.residualPaths) console.log(`  ${path}`)
      console.log(`Allowed upstream internal text residuals (${result.internalTextResiduals.length} file(s)):`)
      for (const [path, entry] of result.internalTextResiduals) {
        console.log(`  ${path} (${entry.count} occurrence(s)): ${entry.reason}`)
      }
    })
    .catch(error => { console.error(error); process.exitCode = 1 })
}
