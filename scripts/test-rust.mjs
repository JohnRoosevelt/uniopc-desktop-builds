#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyDesktopPrerequisites } from './verify-desktop-prerequisites.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(scriptDir, '..')
const manifestPath = path.join(desktopRoot, 'src-tauri', 'Cargo.toml')
const windowsManifestPath = path.join(desktopRoot, 'src-tauri', 'tests', 'windows-test.manifest')

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return result
}

function findWindowsManifestTool() {
  const fromPath = run('where.exe', ['mt.exe'])
  if (fromPath.status === 0) {
    const first = fromPath.stdout.split(/\r?\n/u).find(Boolean)
    if (first) return first
  }

  const kitsRoot = path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Windows Kits',
    '10',
    'bin',
  )
  if (!existsSync(kitsRoot)) return ''

  return readdirSync(kitsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(kitsRoot, entry.name, 'x64', 'mt.exe'))
    .filter(existsSync)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .at(0) || ''
}

function renderCargoOutput(stdout) {
  const executables = new Set()
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line) continue
    try {
      const message = JSON.parse(line)
      if (message.reason === 'compiler-message' && message.message?.rendered) {
        process.stderr.write(message.message.rendered)
      }
      if (message.reason === 'compiler-artifact' && message.profile?.test && message.executable) {
        executables.add(message.executable)
      }
    } catch {
      process.stdout.write(`${line}\n`)
    }
  }
  return [...executables]
}

function compileTests() {
  const result = run('cargo', [
    'test',
    '--manifest-path',
    manifestPath,
    '--no-run',
    '--message-format=json',
  ])
  process.stderr.write(result.stderr)
  const executables = renderCargoOutput(result.stdout)
  if (result.status !== 0) process.exit(result.status ?? 1)
  return executables
}

function embedWindowsManifest(executables) {
  if (process.platform !== 'win32') return
  const mt = findWindowsManifestTool()
  if (!mt) throw new Error('Windows SDK mt.exe is required to run the Rust test harnesses')

  for (const executable of executables) {
    const result = run(mt, [
      '-nologo',
      '-manifest',
      windowsManifestPath,
      `-outputresource:${executable};#1`,
    ])
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}

verifyDesktopPrerequisites({ execFileSync })

const executables = compileTests()
embedWindowsManifest(executables)

for (const executable of executables) {
  const result = run(executable, [])
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const docTests = run('cargo', ['test', '--manifest-path', manifestPath, '--doc'])
process.stdout.write(docTests.stdout)
process.stderr.write(docTests.stderr)
process.exitCode = docTests.status ?? 1
