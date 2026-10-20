import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePromotionTag, validatePromotionSource } from './desktop-candidate-promotion.mjs'

function fixture() {
  const commit = 'a'.repeat(40)
  return {
    commit,
    request: parsePromotionTag(`publish/windows-v0.4.19-${commit.slice(0, 12)}-123-2`),
    run: { actor: { login: 'JohnRoosevelt' }, triggering_actor: { login: 'JohnRoosevelt' }, id: 123, run_attempt: 2, repository: { full_name: 'JohnRoosevelt/uniopc-desktop-builds' }, head_repository: { full_name: 'JohnRoosevelt/uniopc-desktop-builds' }, head_sha: commit, head_branch: 'test/windows/v0.4.19-1', path: '.github/workflows/desktop-release.yml', event: 'push', status: 'completed', conclusion: 'success' },
    jobs: [{ name: 'preflight-signing-keys', conclusion: 'success' }, { name: 'stage-candidate', conclusion: 'success' }],
    artifacts: [{ id: 1, name: 'desktop-candidate-manifest-2', expired: false }, { id: 2, name: 'desktop-release-windows-x86_64-2', expired: false }],
  }
}
test('publication pins a successful same-repository run, exact attempt, commit and target set', () => {
  const source = validatePromotionSource(fixture())
  assert.equal(source.source_run_id, '123')
  assert.equal(source.source_attempt, '2')
  assert.deepEqual(source.artifacts.map(a => a.id), ['1', '2'])
})
test('publication rejects forks, wrong attempts, failed checks, expired or ambiguous artifacts', () => {
  const mutations = [
    f => { f.run.repository.full_name = 'other/repo' },
    f => { f.run.head_repository.full_name = 'fork/repo' },
    f => { f.run.path = '.github/workflows/other.yml' },
    f => { f.run.event = 'workflow_dispatch' },
    f => { f.run.event = 'pull_request' },
    f => { f.run.actor.login = 'other' },
    f => { f.run.triggering_actor.login = 'other' },
    f => { f.run.repository.full_name = '0xbootiful/uniopc-desktop' },
    f => { f.run.head_branch = 'windows/v0.4.19' },
    f => { f.run.status = 'in_progress' },
    f => { f.run.conclusion = 'failure' },
    f => { f.run.head_sha = 'b'.repeat(40) },
    f => { f.run.id = 999 },
    f => { f.run.run_attempt = 3 },
    f => { f.run.head_branch = 'test/windows/v0.4.20-1' },
    f => { f.request.candidateId = f.request.candidateId.replace('windows-', 'macos-') },
    f => { f.jobs[0].conclusion = 'failure' },
    f => { f.jobs[1].conclusion = 'skipped' },
    f => { f.artifacts[0].expired = true },
    f => { f.artifacts[1].workflow_run = { head_sha: 'b'.repeat(40) } },
    f => { f.artifacts.push({ ...f.artifacts[1], id: 3 }) },
    f => { f.artifacts.pop() },
  ]
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => validatePromotionSource(f)) }
})
test('only explicit publish and verify-publish tags can request publication', () => {
  for (const tag of ['v0.4.19', 'test/windows/v0.4.19-1', 'publish/latest', 'publish/windows-v0.4.19-aaaaaaaaaaaa-0-1', 'publish/windows-v0.4.19-aaaaaaaaaaaa-9007199254740993-1']) assert.throws(() => parsePromotionTag(tag))
})
test('a publisher-only repair can use a descendant controller without changing the tested application commit', () => {
  const f = fixture()
  const tested = f.commit
  f.commit = 'b'.repeat(40)
  f.comparison = { status: 'ahead', files: [{ filename: 'scripts/desktop-candidate-promotion.mjs' }] }
  assert.equal(validatePromotionSource(f).source_commit, tested)
  for (const file of ['src/App.tsx', 'package.json', 'src-tauri/tauri.conf.json', 'src-tauri/src/lib.rs']) {
    f.comparison.files = [{ filename: file }]
    assert.throws(() => validatePromotionSource(f), /preserve all application/)
  }
  f.comparison = { status: 'diverged', files: [] }
  assert.throws(() => validatePromotionSource(f), /preserve all application/)
})
