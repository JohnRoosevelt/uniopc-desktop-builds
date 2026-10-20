import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hostWorkspaceHomePath,
} from './hostWorkspaceEntry.js'

test('host home path sends the personal workspace to conversations', () => {
  assert.equal(hostWorkspaceHomePath({ memberRole: 'owner' }), '/profiles/me/conversations')
  assert.equal(hostWorkspaceHomePath({ memberRole: 'admin' }), '/profiles/me/conversations')
})

test('host home path sends members to conversations for legacy compatibility', () => {
  assert.equal(hostWorkspaceHomePath({ memberRole: 'member' }), '/profiles/me/conversations')
})

test('host home path sends member-local profiles through conversations', () => {
  assert.equal(hostWorkspaceHomePath({
    memberRole: 'member',
    runtimeMode: 'member_local',
  }), '/profiles/me/conversations')
})

test('host home path sends unknown workspace roles to organization setup', () => {
  assert.equal(hostWorkspaceHomePath({ memberRole: '' }), '/setup/organization')
  assert.equal(hostWorkspaceHomePath(null), '/setup/organization')
})
