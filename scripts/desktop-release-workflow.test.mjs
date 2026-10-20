import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
const root = resolve(import.meta.dirname, '..')
const read = file => readFileSync(resolve(root, '.github/workflows', file), 'utf8')
const candidate = read('desktop-release.yml'), windows = read('desktop-build-windows.yml'), checks = read('desktop-build-checks.yml'), promote = read('desktop-promote.yml'), warm = read('prepare-windows-runtime.yml')
function job(document, name) {
  const match = document.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:\\n|$(?![\\s\\S]))`, 'm'))
  assert.ok(match, name)
  return match[0]
}
function evaluateJob(source, github, needs = {}) {
  const expression = source.match(/^    if: (.+)$/m)?.[1]
  assert.ok(expression)
  return vm.runInNewContext(expression.replace(/needs\.([\w-]+)/g, (_, key) => `needs[${JSON.stringify(key)}]`), { github, needs })
}
const owner = { repository: 'JohnRoosevelt/uniopc-desktop-builds', actor: 'JohnRoosevelt', triggering_actor: 'JohnRoosevelt', event_name: 'push', ref: 'refs/tags/test/windows/v0.4.19-1' }
test('secret-bearing candidate chain starts after owner/tag/main ancestry authorization', () => {
  assert.match(candidate, /tags: \['test\/windows\/\*'\]/)
  assert.match(job(candidate, 'authorize'), /public-release-guard\.mjs candidate/)
  assert.match(job(candidate, 'preflight-signing-keys'), /needs: authorize/)
  assert.match(job(candidate, 'preflight-signing-keys'), /environment: desktop-signing/)
  assert.match(job(candidate, 'windows'), /needs: preflight-signing-keys/)
  assert.match(job(candidate, 'stage-candidate'), /needs: \[preflight-signing-keys, windows\]/)
  assert.match(job(candidate, 'stage-candidate'), /desktop-release-candidate\.mjs package/)
  assert.doesNotMatch(candidate + windows + checks, /IMAI_RELEASE_PUBLISH_TOKEN|SUPABASE_STORAGE_API_KEY/)
  for (const [source, name] of [[candidate, 'authorize'], [windows, 'checks']]) {
    const gate = job(source, name)
    assert.equal(evaluateJob(gate, owner), true)
    for (const mutation of [{ repository: 'fork/repo' }, { actor: 'other' }, { triggering_actor: 'other' }, { event_name: 'pull_request' }]) assert.equal(evaluateJob(gate, { ...owner, ...mutation }), false)
  }
  assert.doesNotMatch(windows, /workflow_dispatch|secrets: inherit/)
  assert.match(checks, /public-release-guard\.mjs candidate/)
})
test('Windows reusable workflow requires and explicitly forwards only its named signing key', () => {
  assert.match(windows, /on:\n  workflow_call:\n    secrets:\n      TAURI_SIGNING_PRIVATE_KEY_WINDOWS:\n        required: true\npermissions:/)
  const caller = job(candidate, 'windows')
  assert.match(caller, /needs: preflight-signing-keys/)
  assert.match(caller, /uses: \.\/\.github\/workflows\/desktop-build-windows\.yml\n    secrets:\n      TAURI_SIGNING_PRIVATE_KEY_WINDOWS: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_WINDOWS \}\}\n$/)
  assert.doesNotMatch(candidate + windows, /secrets: inherit/)
  assert.match(job(windows, 'windows'), /environment: desktop-signing/)
  assert.match(job(candidate, 'preflight-signing-keys'), /environment: desktop-signing/)
})
test('signing credentials exist only in protected jobs and key verification/signing steps', () => {
  for (const document of [candidate, windows]) {
    for (const section of document.split(/(?=^  [\w-]+:\n)/m).filter(s => s.includes('secrets.'))) {
      if (section === job(candidate, 'windows')) continue // Named forwarding is checked above; execution remains environment-protected.
      assert.match(section, /environment: desktop-signing/)
      for (const step of section.split(/^      - /m).filter(s => s.includes('secrets.'))) {
        assert.match(step, /verify-updater-signing-key\.mjs windows|npm run build:release/)
        assert.deepEqual([...step.matchAll(/secrets\.([A-Z_]+)/g)].map(m => m[1]), ['TAURI_SIGNING_PRIVATE_KEY_WINDOWS'])
        assert.match(step, /env:/)
      }
    }
  }
  assert.match(windows, /UNIOPC_PREPARED_OPENCLAW_RUNTIME_DIR:/)
  assert.match(windows, /desktop-release-candidate\.mjs evidence/)
  assert.match(windows, /name: desktop-release-windows-x86_64-\$\{\{ github.run_attempt \}\}/)
  assert.doesNotMatch(job(windows, 'prepare-openclaw-runtime-windows'), /environment:|secrets\./)
})
test('verification uses read-only permissions without production environment; preview skips production job entirely', () => {
  const verify = job(promote, 'verify-candidate'), publish = job(promote, 'publish-candidate')
  assert.doesNotMatch(verify, /environment:|secrets\.|actions: write/)
  assert.match(verify, /getWorkflowRunAttempt/)
  assert.match(verify, /listJobsForWorkflowRunAttempt/)
  assert.match(verify, /validatePromotionSource/)
  assert.match(verify, /merge-base.*--is-ancestor.*run.head_sha/)
  assert.match(verify, /verify-promotion-download\.mjs prepare/)
  assert.match(publish, /environment: desktop-production/)
  assert.equal(evaluateJob(publish, owner, { 'verify-candidate': { outputs: { dry_run: 'true' } } }), false)
  assert.equal(evaluateJob(publish, owner, { 'verify-candidate': { outputs: { dry_run: 'false' } } }), true)
  for (const step of publish.split(/^      - /m).filter(s => s.includes('secrets.'))) {
    assert.match(step, /desktop-release-candidate\.mjs publish/)
    assert.deepEqual([...step.matchAll(/secrets\.([A-Z_]+)/g)].map(m => m[1]), ['SUPABASE_STORAGE_API_KEY', 'IMAI_RELEASE_PUBLISH_TOKEN'])
  }
  assert.ok(publish.indexOf('verify-promotion-download.mjs') < publish.indexOf('secrets.SUPABASE_STORAGE_API_KEY'))
  assert.match(promote, /group: desktop-stable-promotion\n\s+cancel-in-progress: false/)
  assert.doesNotMatch(promote, /npm (ci|run)|build:release|TAURI_SIGNING_PRIVATE_KEY|workflow_run:|pull_request:/)
})
test('runtime cache is main-warmed, exactly keyed, read-only in candidates, and always verified', () => {
  const runtime = job(windows, 'prepare-openclaw-runtime-windows')
  assert.equal(evaluateJob(job(warm, 'prepare'), { ...owner, event_name: 'workflow_dispatch', ref: 'refs/heads/main' }), true)
  for (const mutation of [{ ref: 'refs/heads/fork' }, { actor: 'other' }, { triggering_actor: 'other' }, { repository: 'fork/repo' }, { event_name: 'push' }]) assert.equal(evaluateJob(job(warm, 'prepare'), { ...owner, event_name: 'workflow_dispatch', ref: 'refs/heads/main', ...mutation }), false)
  assert.doesNotMatch(warm, /secrets\.|environment:/)
  assert.match(warm, /actions\/cache\/save@[a-f0-9]{40}/)
  assert.doesNotMatch(runtime, /actions\/cache\/save|restore-keys:/)
  for (const document of [runtime, warm]) {
    assert.match(document, /actions\/cache\/restore@[a-f0-9]{40}/)
    assert.match(document, /key: \$\{\{ steps.runtime-key.outputs.key \}\}/)
    assert.match(document, /if: steps.runtime-cache.outputs.cache-hit != 'true'/)
    assert.match(document, /build:openclaw-runtime -- --force --platform win32 --arch x64/)
    assert.match(document, /run: node scripts\/windows-runtime-cache.mjs verify/)
    for (const cache of document.matchAll(/uses: actions\/cache\/(?:restore|save)@[^\n]+\n([\s\S]*?)(?=^      - |$(?![\s\S]))/gm)) {
      const paths = [...cache[1].matchAll(/^            (.+)$/gm)].map(m => m[1])
      assert.deepEqual(paths, ['src-tauri/resources/uniopc-engine-runtime/uniopc-engine-runtime-win32-x64.tar.gz', 'src-tauri/resources/uniopc-engine-runtime/uniopc-engine-runtime.catalog.json'])
    }
  }
})
test('all third-party actions are immutable; checkout uses exact SHA without persisted credentials', () => {
  for (const name of readdirSync(resolve(root, '.github/workflows'))) {
    const document = read(name)
    for (const use of document.matchAll(/uses: ([^\s]+)/g)) if (!use[1].startsWith('./')) assert.match(use[1], /@[a-f0-9]{40}$/)
  }
  for (const document of [candidate, windows, checks, promote, warm]) for (const checkout of document.matchAll(/- uses: actions\/checkout@[^\n]+\n([\s\S]*?)(?=^      - |$(?![\s\S]))/gm)) {
    assert.match(checkout[1], /ref: \$\{\{ github.sha \}\}/)
    assert.match(checkout[1], /persist-credentials: false/)
  }
})
test('embedded Bash is syntactically valid', () => {
  for (const document of [candidate, windows, checks, promote, warm]) for (const match of document.matchAll(/^        run: \|\n((?:          [^\n]*\n|\n)+)/gm)) {
    if (match[1].includes('$perl')) continue
    execFileSync('bash', ['-n'], { input: match[1].split('\n').map(line => line.slice(10)).join('\n') })
  }
})
