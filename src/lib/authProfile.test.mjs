import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLocalUserPayload, buildProfileFromAuthUser, normalizeAuthUser, syncLocalUserBestEffort } from './authProfile.js'

test('normalizeAuthUser maps Supabase auth user into the app user shape', () => {
  const user = normalizeAuthUser({
    id: 'user-1',
    email: 'alice@example.com',
    user_metadata: { display_name: 'Alice' },
  })

  assert.equal(user.uid, 'user-1')
  assert.equal(user.email, 'alice@example.com')
  assert.equal(user.displayName, 'Alice')
})

test('buildProfileFromAuthUser creates an app profile without reading the profiles table', () => {
  const profile = buildProfileFromAuthUser({
    id: 'user-1',
    email: 'alice@example.com',
    phone: '+1',
    user_metadata: {
      display_name: 'Alice',
      avatar_url: 'https://example.com/a.png',
      invited_by: 'owner-1',
    },
  })

  assert.deepEqual({
    id: profile.id,
    uid: profile.uid,
    email: profile.email,
    nickname: profile.nickname,
    avatar_url: profile.avatar_url,
    phone: profile.phone,
    invited_by: profile.invited_by,
  }, {
    id: 'user-1',
    uid: 'user-1',
    email: 'alice@example.com',
    nickname: 'Alice',
    avatar_url: 'https://example.com/a.png',
    phone: '+1',
    invited_by: 'owner-1',
  })
})

test('buildLocalUserPayload preserves invited_by for cloud profile compatibility', () => {
  assert.deepEqual(buildLocalUserPayload({
    id: 'user-1',
    email: 'alice@example.com',
    nickname: '',
    phone: '',
    invited_by: 'owner-1',
  }), {
    uid: 'user-1',
    nickname: 'alice@example.com',
    phone: null,
    invitedBy: 'owner-1',
  })
})

test('syncLocalUserBestEffort no longer writes a local user cache', async () => {
  const calls = []
  await syncLocalUserBestEffort(
    (...args) => {
      calls.push(args)
      return Promise.resolve()
    },
    { id: 'user-1', email: 'alice@example.com' },
    { timeoutMs: 5 },
  )

  assert.deepEqual(calls, [])
})
