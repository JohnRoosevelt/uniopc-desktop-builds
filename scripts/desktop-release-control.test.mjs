import assert from 'node:assert/strict'
import test from 'node:test'
import { publicationRequest, pushTagOnce } from './desktop-release-control.mjs'
import { parsePromotionTag } from './desktop-candidate-promotion.mjs'

const commit = 'a'.repeat(40)
const id = `windows-v0.4.19-${commit.slice(0, 12)}-123-2`
test('publication command identifies the same exact candidate as its workflow', () => {
  const request = publicationRequest(id, commit)
  const parsed = parsePromotionTag(request.tag)
  assert.deepEqual(parsed, { candidateId: id, version: '0.4.19', runId: '123', runAttempt: '2', dryRun: false })
  assert.equal(parsePromotionTag(publicationRequest(id, commit, true).tag).dryRun, true)
  assert.throws(() => publicationRequest(id, 'b'.repeat(40)), /exact candidate/)
  assert.throws(() => publicationRequest('../evil', commit), /exact candidate/)
})
test('uncertain/repeated requests never move an existing tag or cause duplicate runs', () => {
  const calls = []
  const git = args => { calls.push(args); return `${commit}\trefs/tags/publish/${id}\n` }
  assert.match(pushTagOnce(`publish/${id}`, commit, git).state, /already-requested/)
  assert.equal(calls.length, 1)
  assert.throws(() => pushTagOnce('tag', 'b'.repeat(40), git), /another commit/)
})
test('preview creates no tags; a new request pushes only the one named tag', () => {
  const calls = []
  const git = args => { calls.push(args); return '' }
  assert.match(pushTagOnce(`publish/${id}`, commit, git, true).state, /preview/)
  assert.equal(calls.length, 1)
  calls.length = 0
  assert.equal(pushTagOnce(`publish/${id}`, commit, git).state, 'requested')
  assert.deepEqual(calls.at(-1), ['push', 'origin', `refs/tags/publish/${id}:refs/tags/publish/${id}`])
  assert.ok(!calls.filter(args => args[0] === 'push').flat().some(value => value === '--force' || value === '--tags'))
})

test('public controller rejects private/fork/misleading origins', async () => {
  const { validateReleaseOrigin } = await import('./desktop-release-control.mjs')
  for (const remote of ['git@github.com:JohnRoosevelt/uniopc-desktop-builds.git', 'https://github.com/JohnRoosevelt/uniopc-desktop-builds', 'ssh://git@github.com/JohnRoosevelt/uniopc-desktop-builds.git']) validateReleaseOrigin(remote)
  for (const remote of ['git@github.com:0xbootiful/uniopc-desktop.git', 'https://github.com/fork/uniopc-desktop-builds', 'https://github.com/JohnRoosevelt/uniopc-desktop-builds/extra', 'https://evil.example/JohnRoosevelt/uniopc-desktop-builds', 'https://github.com/JohnRoosevelt/uniopc-desktop-builds.git?token=x']) assert.throws(() => validateReleaseOrigin(remote))
  assert.throws(() => publicationRequest(id.replace('windows-', 'macos-'), commit))
})
