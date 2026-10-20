import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { planRelease } from './desktop-release-candidate.mjs'

const root = path.resolve(import.meta.dirname, '..')
const read = name => fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8')
const workflow = read('desktop-release.yml')
const checks = read('desktop-build-checks.yml')
const promote = read('desktop-promote.yml')
const children = Object.fromEntries(['macos', 'windows'].map(p => [p, read(`desktop-build-${p}.yml`)]))
function job(name, document = workflow) {
  const match = document.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\n|(?![\\s\\S]))`, 'm'))
  assert.ok(match, `Missing job ${name}`)
  return match[0]
}
function condition(source, context) {
  const expr = source.match(/^    if: >-\n([\s\S]*?)^    runs-on:/m)?.[1] || source.match(/^\s*if: (.+)$/m)?.[1]
  assert.ok(expr, 'Missing condition')
  return vm.runInNewContext(expr.replace(/\$\{\{|\}\}/g, '').trim().replace(/needs\.([\w-]+)/g, (_, name) => `needs[${JSON.stringify(name)}]`), { ...context, always: () => true }, { timeout: 1000 })
}
function context(platforms = 'all', event = 'push') {
  return { github: { event_name: event }, inputs: { platforms, validation_only: event === 'workflow_dispatch', dry_run: true }, needs: { 'preflight-signing-keys': { result: 'success', outputs: { platforms } }, 'stage-candidate': { result: 'success', outputs: { candidate_id: 'candidate', version: '0.4.13' } }, macos: { result: 'success' }, windows: { result: 'success' }, linux: { result: 'success' } } }
}

test('all supported tag namespaces route only the intended native platform jobs', () => {
  assert.match(workflow, /tags: \['test\/\*\*', 'v\*', 'desktop\/v\*', 'macos\/v\*', 'windows\/v\*'\]/)
  for (const tag of ['v0.4.12', 'desktop/v0.4.12', 'macos/v0.4.12', 'windows/v0.4.12', 'test/windows/v0.4.12-1', 'test/v0.4.12-2']) {
    const selection = planRelease(tag, '0.4.12').platforms
    const ctx = context(selection)
    for (const platform of Object.keys(children)) assert.equal(condition(job(platform), ctx), selection === 'all' || selection === 'desktop' && platform !== 'linux' || selection === platform)
  }
})

test('failed selected targets block candidates; unselected skipped jobs do not', () => {
  for (const selection of ['all', 'desktop', 'macos', 'windows']) {
    const ctx = context(selection)
    const selected = selection === 'all' ? Object.keys(children) : selection === 'desktop' ? ['macos', 'windows'] : [selection]
    for (const platform of Object.keys(children)) if (!selected.includes(platform)) ctx.needs[platform].result = 'skipped'
    assert.equal(condition(job('stage-candidate'), ctx), true)
    for (const platform of selected) {
      ctx.needs[platform].result = 'failure'
      assert.equal(condition(job('stage-candidate'), ctx), false)
      ctx.needs[platform].result = 'success'
    }
    ctx.needs['preflight-signing-keys'].result = 'failure'
    assert.equal(condition(job('stage-candidate'), ctx), false)
  }
})

test('manual validation runs never stage or promote and default to safe validation', () => {
  assert.match(workflow, /validation_only:\n\s+description:[^\n]+\n\s+type: boolean\n\s+default: true/)
  assert.equal(condition(job('stage-candidate'), context('all', 'workflow_dispatch')), false)
  assert.match(job('preflight-signing-keys'), /Manual runs create validation installers only/)
  assert.match(job('stage-candidate'), /desktop-release-candidate\.mjs package/)
})

test('successful candidate builds stay private and never acquire publication credentials', () => {
  const candidate = job('stage-candidate')
  assert.match(candidate, /desktop-release-candidate\.mjs package/)
  assert.doesNotMatch(workflow, /IMAI_RELEASE_PUBLISH_TOKEN|SUPABASE_STORAGE_API_KEY|desktop-release-candidate\.mjs (publish|stage|promote)/)
  assert.match(candidate, /retention-days: 3/)
  assert.match(candidate, /desktop-candidate-manifest-\$\{\{ github.run_attempt \}\}/)
  assert.equal(condition(candidate, context('desktop', 'push')), true)
  const failed = context('desktop', 'push')
  failed.needs['preflight-signing-keys'].result = 'failure'
  assert.equal(condition(candidate, failed), false)
})

test('each independent native workflow retains checks, runtime gates and credential separation', () => {
  for (const [platform, child] of Object.entries(children)) {
    assert.match(child, /workflow_dispatch:/)
    assert.match(child, /workflow_call:/)
    assert.match(job('checks', child), /desktop-build-checks\.yml/)
    assert.match(job('checks', child), new RegExp(`platform: ${platform}`))
    assert.match(job(platform, child), /needs:.*checks.*prepare-openclaw-runtime/)
    assert.match(job('prepare-openclaw-runtime-' + platform, child), /needs: checks/)
    const runtimePreparation = job('prepare-openclaw-runtime-' + platform, child)
    assert.match(runtimePreparation, /src-tauri\/resources\/uniopc-engine-runtime\/uniopc-engine-runtime-\$\{\{ matrix\.runtime_platform \}\}-\$\{\{ matrix\.runtime_arch \}\}\.tar\.gz/)
    assert.match(runtimePreparation, /src-tauri\/resources\/uniopc-engine-runtime\/uniopc-engine-runtime\.catalog\.json/)
    assert.match(job(platform, child), /verify-updater-signing-key\.mjs/)
    assert.match(job(platform, child), /Record signed build provenance/)
    assert.match(job(platform, child), /desktop-release-candidate\.mjs evidence/)
    assert.doesNotMatch(child, /IMAI_RELEASE_PUBLISH_TOKEN|SUPABASE_STORAGE_API_KEY|ci-publish-desktop-artifacts|\bpromote:/)
    for (const other of Object.keys(children).filter(p => p !== platform)) assert.doesNotMatch(job(platform), new RegExp(`TAURI_SIGNING_PRIVATE_KEY_${other.toUpperCase()}`))
    const ctx = context(platform, 'workflow_dispatch')
    assert.equal(condition(job(platform, child), ctx), false)
    assert.equal(condition(job('validation-native-build', child), ctx), true)
    assert.doesNotMatch(job('validation-native-build', child), /TAURI_SIGNING_PRIVATE_KEY|SUPABASE_STORAGE_API_KEY|IMAI_RELEASE_PUBLISH_TOKEN/)
  }
  assert.match(children.macos, /target: aarch64-apple-darwin/)
  assert.match(children.macos, /target: x86_64-apple-darwin/)
  assert.match(children.macos, /xcrun stapler validate/)
})

test('native builds and promotion use the exact caller SHA', () => {
  for (const document of [workflow, checks, promote, ...Object.values(children)]) {
    for (const match of document.matchAll(/- uses: actions\/checkout@v4\n([\s\S]*?)(?=\n      - |$)/g)) if (!match[1].includes('repository:')) assert.match(match[1], /ref: \$\{\{ github.sha \}\}/)
  }
})

test('candidate packaging omits business tests while failed preflight still blocks builds and staging', () => {
  assert.doesNotMatch(workflow, /shared-checks|checks_passed/)
  for (const platform of Object.keys(children)) {
    assert.match(job(platform), /needs: preflight-signing-keys/)
    const ctx = context(platform)
    ctx.needs['preflight-signing-keys'].result = 'failure'
    assert.equal(condition(job(platform), ctx), false)
    assert.equal(condition(job('stage-candidate'), ctx), false)
  }
  for (const document of [workflow, checks, ...Object.values(children)]) {
    assert.doesNotMatch(document, /test:desktop:|test-desktop\.mjs|release-validation:|validation-core-tests:|skip_validation|checks_passed/)
  }
  assert.match(checks, /check-updater-signing-keys\.mjs/)
  assert.match(checks, /readDesktopReleaseVersion/)
})

test('Windows verifies its signing key before runtime preparation, while retaining the native check', () => {
  const probe = job('verify-updater-key', children.windows)
  assert.match(probe, /runs-on: windows-latest/)
  assert.match(probe, /if: \$\{\{ !inputs\.validation_only \}\}/)
  assert.match(probe, /verify-updater-signing-key\.mjs windows/)
  assert.match(probe, /secrets\.TAURI_SIGNING_PRIVATE_KEY_WINDOWS/)
  assert.match(job('checks', children.windows), /needs: verify-updater-key/)
  assert.match(job('prepare-openclaw-runtime-windows', children.windows), /needs: checks/)
  assert.match(job('windows', children.windows), /verify-updater-signing-key\.mjs windows/)
})

test('candidate workflows do not require or check out the backend source repository', () => {
  for (const document of [checks, ...Object.values(children), workflow]) {
    assert.doesNotMatch(document, /UNIOPC_SUPABASE_READ_TOKEN|repository: 0xbootiful\/uniopc-supabase/)
  }

})

test('publication requires an explicit exact candidate request and verifies bytes before credentials', () => {
  assert.match(promote, /tags: \['publish\/\*\*', 'verify-publish\/\*\*'\]/)
  assert.doesNotMatch(promote, /workflow_run:|pull_request:|environment:/)
  const source = job('publish-candidate', promote)
  assert.match(source, /getWorkflowRunAttempt/)
  assert.match(source, /listJobsForWorkflowRunAttempt/)
  assert.match(source, /validatePromotionSource/)
  assert.match(source, /artifact-ids: \$\{\{ steps.source.outputs.artifact_ids \}\}/)
  assert.ok(source.indexOf('verifyLocalCandidate(candidate') < source.indexOf('secrets.IMAI_RELEASE_PUBLISH_TOKEN'))
  assert.match(source, /if: steps.source.outputs.dry_run == 'false'/)
  assert.match(source, /desktop-release-candidate\.mjs publish/)
})

test('publication has no builds or signing secrets and serializes channel changes', () => {
  assert.doesNotMatch(promote, /npm (ci|run)|build:release|tauri build|prepare-openclaw|desktop-build-|TAURI_SIGNING_PRIVATE_KEY|APPLE_CERTIFICATE/)
  assert.match(promote, /group: desktop-stable-promotion\n\s+cancel-in-progress: false/)
})

test('all embedded Bash blocks parse without interpolating user input into shell code', () => {
  for (const document of [workflow, promote, checks, ...Object.values(children)]) {
    for (const match of document.matchAll(/^        run: \|\n((?:          [^\n]*\n|\n)+)/gm)) {
      if (match[1].includes('$perl')) continue // Explicit PowerShell block.
      const script = match[1].split('\n').map(line => line.slice(10)).join('\n').replace(/\$\{\{[^}]+\}\}/g, 'fixture')
      execFileSync('bash', ['-n'], { input: script })
    }
  }
  assert.doesNotMatch(workflow + promote, /--tag "\$\{\{ inputs\.|--candidate-id "\$\{\{ inputs\./)
})


test('four public settings no longer require Actions secrets, while platform credentials remain separate', () => {
  const documents = [workflow, promote, ...Object.values(children), read('plugin-runtime-compatibility.yml')]
  for (const name of ['SUPABASE_URL', 'SUPABASE_RELEASE_BUCKET', 'APPLE_SIGNING_IDENTITY', 'APPLE_TEAM_ID']) {
    for (const document of documents) assert.ok(!document.includes(`secrets.${name}`), `public setting still requires secret ${name}`)
  }
  for (const name of ['prepare-openclaw-runtime-macos', 'macos']) {
    const source = job(name, children.macos)
    assert.ok(source.indexOf('desktop-release-settings.mjs --github-env') < source.indexOf('Build and verify'))
  }
  const referenced = new Set([...([workflow, promote, ...Object.values(children)].join('\n')).matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]))
  assert.equal(referenced.size, 8)
})


test('desktop release excludes Linux builds and keeps dependency caches for inexpensive retries', () => {
  assert.doesNotMatch(workflow, /linux|TAURI_SIGNING_PRIVATE_KEY_WINDOWS_PASSWORD/)
  assert.equal(fs.existsSync(path.join(root, '.github/workflows/desktop-build-linux.yml')), false)
  assert.doesNotMatch(read('desktop-tests.yml'), /desktop-tests-linux/)
  for (const child of Object.values(children)) {
    assert.match(child, /Swatinem\/rust-cache@v2/)
    assert.match(child, /cache-on-failure: true/)
    assert.match(child, /retention-days: 3/)
  }
})

test('cleanup deletes only the explicitly verified artifacts after publication, never after a preview', async () => {
  const source = job('publish-candidate', promote)
  assert.ok(source.indexOf('desktop-release-candidate.mjs publish') < source.indexOf('Remove source installers'))
  assert.match(source, /if: success\(\) && steps.source.outputs.dry_run == 'false'/)
  const cleanup = source.slice(source.indexOf('      - name: Remove source installers'))
  const script = cleanup.match(/          script: \|\n([\s\S]*)$/)[1].split('\n').map(line => line.slice(12)).join('\n')
  const deleted = []
  const github = { rest: { actions: { deleteArtifact: async args => deleted.push(args) } } }
  const old = process.env.ARTIFACT_IDS
  try {
    process.env.ARTIFACT_IDS = '1,2,3'
    await new (Object.getPrototypeOf(async function() {}).constructor)('github', 'context', script)(github, { repo: { owner: 'owner', repo: 'repo' } })
    assert.deepEqual(deleted.map(a => a.artifact_id), [1, 2, 3])
    assert.ok(deleted.every(a => a.owner === 'owner' && a.repo === 'repo'))
  } finally { if (old === undefined) delete process.env.ARTIFACT_IDS; else process.env.ARTIFACT_IDS = old }
})
