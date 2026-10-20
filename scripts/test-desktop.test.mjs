import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildTestPlan,
  defaultSuites,
  resolveSuiteSelection,
} from './test-desktop.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const desktopRoot = repoRoot

const desktopPackage = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))
const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

test('default desktop test suites are layered and ordered', () => {
  assert.deepEqual(defaultSuites.map(suite => suite.id), [
    'js',
    'smoke-unit',
    'rust',
  ])
})

test('all selection expands to every default suite', () => {
  assert.deepEqual(resolveSuiteSelection(['all']).map(suite => suite.id), [
    'js',
    'smoke-unit',
    'rust',
  ])
})

test('release gate covers installer and updater contracts without local integration fixtures', () => {
  const [suite] = buildTestPlan(['release-unit'])
  assert.equal(suite.command, process.execPath)
  for (const file of ['e2e-tauri', 'desktop-release-candidate', 'build-desktop-release', 'verify-updater-signing-key', 'desktop-updater-routing']) {
    assert.ok(suite.args.includes(`scripts/${file}.test.mjs`), file)
  }
  assert.ok(suite.args.slice(1).every(file => fs.existsSync(path.join(desktopRoot, file))))
  assert.ok(!suite.args.includes('scripts/*.test.mjs'))
  assert.ok(!suite.args.some(file => /audit-openclaw-plugin|validate-openclaw-release-live|configure-openclaw-release-ci|test-desktop\.test/.test(file)))
  assert.deepEqual(buildTestPlan(['smoke-unit'])[0].args, ['--test', 'scripts/*.test.mjs'])
})

test('buildTestPlan exposes commands without executing them', () => {
  const plan = buildTestPlan(['js', 'rust'])

  assert.equal(plan.length, 2)
  assert.equal(plan[0].id, 'js')
  assert.equal(plan[0].command, process.execPath)
  assert.equal(plan[1].preflight, undefined)
  assert.equal(plan[1].command, process.execPath)
  assert.deepEqual(plan[1].args, ['scripts/test-rust.mjs'])
})

test('Rust test wrapper performs the Windows perl prerequisite check', () => {
  const wrapper = fs.readFileSync(path.join(repoRoot, 'scripts/test-rust.mjs'), 'utf8')
  const prerequisites = fs.readFileSync(path.join(repoRoot, 'scripts/verify-desktop-prerequisites.mjs'), 'utf8')

  assert.match(wrapper, /verifyDesktopPrerequisites/)
  assert.match(prerequisites, /['\"]perl['\"]/)
})

test('full local JS suite provides the sibling Supabase repository to source-contract tests', () => {
  const plan = buildTestPlan(['js'])
  const expectedSupabaseDir = [
    path.resolve(desktopRoot, '../uniopc-supabase/supabase'),
    path.resolve(desktopRoot, '../../../uniopc-supabase/supabase'),
    path.resolve(desktopRoot, '.deps/uniopc-supabase/supabase'),
  ].find(candidate => fs.existsSync(candidate))

  assert.ok(expectedSupabaseDir, 'a local uniopc-supabase checkout is required for desktop source-contract tests')
  assert.equal(plan[0].env?.UNIOPC_SUPABASE_DIR, expectedSupabaseDir)
})

test('package scripts expose the layered desktop test entrypoints', () => {
  assert.equal(desktopPackage.scripts['test:desktop:js'], 'node scripts/test-desktop.mjs js')
  assert.equal(desktopPackage.scripts['test:desktop:rust'], 'node scripts/test-desktop.mjs rust')
  assert.equal(desktopPackage.scripts['test:desktop:smoke:unit'], 'node scripts/test-desktop.mjs smoke-unit')
  assert.equal(desktopPackage.scripts['test:desktop:all'], 'node scripts/test-desktop.mjs all')

  assert.equal(rootPackage.scripts.test, 'npm run test:desktop:all')
  assert.equal(rootPackage.scripts['test:js'], 'npm run test:desktop:js')
  assert.equal(rootPackage.scripts['test:rust'], 'npm run test:desktop:rust')
  assert.equal(rootPackage.scripts['test:desktop:all'], 'node scripts/test-desktop.mjs all')
})

test('Tauri development startup prepares the pinned embedded runtime first', () => {
  assert.equal(
    desktopPackage.scripts['tauri:dev'],
    'npm run build:openclaw-runtime -- --unsigned-local && tauri dev',
  )
})

test('production frontend build uses a cross-platform Node memory limit', () => {
  assert.equal(
    desktopPackage.scripts.build,
    'node --max-old-space-size=8192 ./node_modules/vite/bin/vite.js build --mode prod',
  )
})

test('desktop CI tests are manual-only and cover every local desktop test layer', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/desktop-tests.yml'), 'utf8')

  assert.match(workflow, /workflow_dispatch:/)
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/m)
  assert.match(workflow, /npm run test:desktop:js/)
  assert.match(workflow, /npm run test:desktop:smoke:unit/)
  assert.match(workflow, /npm run test:desktop:rust/)
  assert.match(workflow, /macos-latest/)
})

test('desktop CI runs the gateway lifecycle suite on Windows', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/desktop-tests.yml'), 'utf8')

  assert.match(workflow, /windows-latest/)
  assert.match(workflow, /desktop-tests-windows/)
  assert.match(workflow, /npm run test:desktop:rust/)
})
