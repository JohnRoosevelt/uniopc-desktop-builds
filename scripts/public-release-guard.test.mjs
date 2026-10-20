import assert from 'node:assert/strict'
import test from 'node:test'
import { guardPublicRelease, validatePublicContext } from './public-release-guard.mjs'
const fixture = () => ({ GITHUB_REPOSITORY: 'JohnRoosevelt/uniopc-desktop-builds', GITHUB_ACTOR: 'JohnRoosevelt', GITHUB_TRIGGERING_ACTOR: 'JohnRoosevelt', GITHUB_SHA: 'a'.repeat(40), GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'test/windows/v0.4.19-1', GITHUB_REF: 'refs/tags/test/windows/v0.4.19-1' })
test('candidate authorizes only owner pushes of valid Windows tags on main ancestry', () => {
  const calls = []
  guardPublicRelease('candidate', fixture(), args => calls.push(args))
  assert.deepEqual(calls, [['merge-base', '--is-ancestor', 'a'.repeat(40), 'refs/remotes/origin/main']])
  for (const values of [
    { GITHUB_REPOSITORY: 'fork/repo' }, { GITHUB_REPOSITORY: '0xbootiful/uniopc-desktop' },
    { GITHUB_ACTOR: 'other' }, { GITHUB_TRIGGERING_ACTOR: 'other' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_REF: 'refs/heads/main' }, { GITHUB_SHA: 'no' },
    ...['windows/v0.4.19', 'test/macos/v0.4.19-1', 'test/windows/v0.4.19-0', 'test/windows/v0.4.19-01', 'test/windows/v0.4.19-1/extra'].map(GITHUB_REF_NAME => ({ GITHUB_REF_NAME, GITHUB_REF: `refs/tags/${GITHUB_REF_NAME}` })),
  ]) assert.throws(() => guardPublicRelease('candidate', { ...fixture(), ...values }, () => assert.fail('must reject before git')))
  assert.throws(() => guardPublicRelease('candidate', fixture(), () => { throw new Error('non-main') }), /non-main/)
})
test('warm cache requires owner main push or manual main; promotion requires Windows exact-candidate tag', () => {
  const env = { ...fixture(), GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main' }
  validatePublicContext(env, 'warm')
  validatePublicContext({ ...env, GITHUB_EVENT_NAME: 'push' }, 'warm')
  for (const mutation of [{ GITHUB_REF: 'refs/heads/other' }, { GITHUB_EVENT_NAME: 'pull_request' }]) assert.throws(() => validatePublicContext({ ...env, ...mutation }, 'warm'))
  for (const prefix of ['publish', 'verify-publish']) {
    const name = `${prefix}/windows-v0.4.19-aaaaaaaaaaaa-123-2`
    validatePublicContext({ ...fixture(), GITHUB_REF_NAME: name, GITHUB_REF: `refs/tags/${name}` }, 'promotion')
  }
  assert.throws(() => validatePublicContext(fixture(), 'promotion'))
})

test('runtime-only probe requires owner push tag and main ancestry', () => {
  const GITHUB_REF_NAME = 'test/runtime-cache/v2-1'
  const env = { ...fixture(), GITHUB_REF_NAME, GITHUB_REF: `refs/tags/${GITHUB_REF_NAME}` }
  const calls = []
  guardPublicRelease('runtime-probe', env, args => calls.push(args))
  assert.deepEqual(calls, [['merge-base', '--is-ancestor', 'a'.repeat(40), 'refs/remotes/origin/main']])
  for (const mutation of [{ GITHUB_REPOSITORY: 'fork/repo' }, { GITHUB_ACTOR: 'other' }, { GITHUB_TRIGGERING_ACTOR: 'other' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_REF_NAME: 'test/windows/v0.4.19-1' }]) assert.throws(() => validatePublicContext({ ...env, ...mutation }, 'runtime-probe'))
  assert.throws(() => guardPublicRelease('runtime-probe', env, () => { throw new Error('not on main') }), /not on main/)
})
