import assert from 'node:assert/strict'
import test from 'node:test'
import { validateWindowsRecoverySource } from './desktop-windows-recovery.mjs'
function fixture() {
  return {
    expectedVersion: '0.4.18',
    run: { repository: { full_name: '0xbootiful/uniopc-desktop' }, head_repository: { full_name: '0xbootiful/uniopc-desktop' }, event: 'push', path: '.github/workflows/desktop-release.yml', status: 'completed', head_branch: 'windows/v0.4.18', head_sha: 'a'.repeat(40) },
    jobs: [{ name: 'preflight-signing-keys', conclusion: 'success' }, { name: 'windows / prepare-openclaw-runtime-windows (target, runner, win32, x64)', conclusion: 'success' }],
    artifacts: [{ id: 123, name: 'prepared-openclaw-runtime-win32-x64', expired: false, workflow_run: { head_sha: 'a'.repeat(40) } }],
  }
}
test('recovery pins the exact checked Windows source and prepared runtime', () => {
  assert.deepEqual(validateWindowsRecoverySource(fixture()), { source_commit: 'a'.repeat(40), source_tag: 'windows/v0.4.18', source_version: '0.4.18', runtime_artifact_id: '123' })
})
test('recovery rejects untrusted, unchecked, mismatched or expired sources', () => {
  const mutations = [
    f => { f.run.repository.full_name = 'attacker/repo' },
    f => { f.run.head_repository.full_name = 'attacker/repo' },
    f => { f.run.event = 'workflow_dispatch' },
    f => { f.run.path = '.github/workflows/other.yml' },
    f => { f.run.status = 'in_progress' },
    f => { f.run.head_branch = 'windows/v0.4.17' },
    f => { f.jobs[0].conclusion = 'failure' },
    f => { f.jobs[1].conclusion = 'failure' },
    f => { f.artifacts[0].expired = true },
    f => { f.artifacts.push({ ...f.artifacts[0] }) },
    f => { f.artifacts[0].workflow_run.head_sha = 'b'.repeat(40) },
  ]
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => validateWindowsRecoverySource(f)) }
})
