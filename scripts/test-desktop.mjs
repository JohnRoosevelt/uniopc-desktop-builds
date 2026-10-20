#!/usr/bin/env node

import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { existsSync } from 'node:fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const desktopRoot = path.resolve(__dirname, '..')

function siblingSupabaseDir() {
  return [
    path.resolve(desktopRoot, '../uniopc-supabase/supabase'),
    path.resolve(desktopRoot, '../../../uniopc-supabase/supabase'),
    path.resolve(desktopRoot, '.deps/uniopc-supabase/supabase'),
  ].find(candidate => existsSync(candidate)) || ''
}

const supabaseSourceContractEnv = siblingSupabaseDir()
  ? { UNIOPC_SUPABASE_DIR: siblingSupabaseDir() }
  : {}

const jsTestGlobs = [
  'src/lib/*.test.mjs',
  'src/pages/*.test.mjs',
  'src/pages/Studio/Socials/*.test.mjs',
  'src/pages/PrivateConversion/*.test.mjs',
  // 插件源码与测试已迁至 uniopc-plugins 仓(2026-07-30),在该仓 npm test 执行。
]

export const defaultSuites = [
  {
    id: 'js',
    label: 'desktop JS unit and source-contract tests',
    command: process.execPath,
    args: ['--test', ...jsTestGlobs],
    env: supabaseSourceContractEnv,
  },
  {
    id: 'smoke-unit',
    // 发布/门禁脚本的单测过去从没被任何 suite 跑到(ci-publish 那份写了却从不执行),
    // 这里一并收进来 —— 发版链路的守卫自己不受测,等于没有守卫。
    label: 'Tauri smoke runner and release script unit tests',
    command: process.execPath,
    args: ['--test', 'scripts/*.test.mjs'],
  },
  {
    id: 'rust',
    label: 'Tauri Rust command and service tests',
    command: process.execPath,
    args: ['scripts/test-rust.mjs'],
  },
]

// A clean release checkout has no local runtime archive, audit-worker image,
// operator fixture or backend checkout. Those checks remain in smoke-unit;
// release-unit verifies the installer/update pipeline without those inputs.
export const releaseUnitSuite = {
  id: 'release-unit',
  label: 'Desktop installer, signing, candidate publication and updater unit tests',
  command: process.execPath,
  args: ['--test',
    'scripts/e2e-tauri.test.mjs',
    'scripts/desktop-release-workflow.test.mjs',
    'scripts/build-desktop-validation.test.mjs',
    'scripts/prepare-desktop-updater-release.test.mjs',
    'scripts/release-desktop-updater.test.mjs',
    'scripts/check-updater-signing-keys.test.mjs',
    'scripts/verify-updater-signing-key.test.mjs',
    'scripts/desktop-windows-recovery.test.mjs',
    'scripts/desktop-candidate-promotion.test.mjs',
    'scripts/desktop-release-control.test.mjs',
    'scripts/verify-openclaw-release-contract.test.mjs',
    'scripts/ci-publish-desktop-artifacts.test.mjs',
    'scripts/build-desktop-release.test.mjs',
    'scripts/desktop-release-candidate.test.mjs',
    'scripts/desktop-release-settings.test.mjs',
    'scripts/desktop-updater-routing.test.mjs',
    'scripts/probe-desktop-updater.test.mjs',
    'scripts/verify-desktop-prerequisites.test.mjs',
    'scripts/prepare-bundled-plugin-dependencies.test.mjs',
  ],
}

export function resolveSuiteSelection(selection = []) {
  const requested = selection.length ? selection : ['all']
  if (requested.includes('all')) return [...defaultSuites]

  return requested.map(id => {
    const available = [...defaultSuites, releaseUnitSuite]
    const suite = available.find(item => item.id === id)
    if (!suite) {
      const known = available.map(item => item.id).concat('all').join(', ')
      throw new Error(`Unknown desktop test suite "${id}". Known suites: ${known}`)
    }
    return suite
  })
}

export function buildTestPlan(selection = []) {
  return resolveSuiteSelection(selection).map(suite => ({ ...suite }))
}

function runSuite(suite) {
  return new Promise(resolve => {
    console.log(`\n[desktop-test] ${suite.id}: ${suite.label}`)

    const commands = [
      ...(suite.preflight ?? []),
      { command: suite.command, args: suite.args },
    ]
    let commandIndex = 0

    const runNext = () => {
      const current = commands[commandIndex]
      console.log(`[desktop-test] ${current.command} ${current.args.join(' ')}`)

      const child = spawn(current.command, current.args, {
        cwd: desktopRoot,
        env: { ...process.env, ...suite.env },
        stdio: 'inherit',
      })

      child.on('exit', code => {
        if (code !== 0) {
          resolve(code ?? 1)
          return
        }
        commandIndex += 1
        if (commandIndex >= commands.length) {
          resolve(0)
        } else {
          runNext()
        }
      })
      child.on('error', error => {
        console.error(`[desktop-test] failed to start ${suite.id}: ${error.message}`)
        resolve(1)
      })
    }

    runNext()
  })
}

export async function runTestPlan(selection = []) {
  const plan = buildTestPlan(selection)
  for (const suite of plan) {
    const code = await runSuite(suite)
    if (code !== 0) return code
  }
  return 0
}

if (process.argv[1] === __filename) {
  runTestPlan(process.argv.slice(2))
    .then(code => {
      process.exitCode = code
    })
    .catch(error => {
      console.error(error)
      process.exitCode = 1
    })
}
