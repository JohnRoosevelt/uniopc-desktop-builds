import test from 'node:test'
import assert from 'node:assert/strict'
import {
  profileWorkspaceBasePath,
  profileWorkspacePath,
  profileWorkspaceHomePath,
  organizationHomePath,
  normalizeProfileWorkspaceRef,
} from './profileWorkspace.js'

test('owner and admin start in their personal conversations workspace', () => {
  assert.equal(organizationHomePath({ memberRole: 'owner' }), '/profiles/me/conversations')
  assert.equal(organizationHomePath({ memberRole: 'admin' }), '/profiles/me/conversations')
})

test('member starts in their own profile conversations workspace', () => {
  assert.equal(organizationHomePath({ memberRole: 'member' }), '/profiles/me/conversations')
})

test('profile workspace paths use profile id when available', () => {
  const ref = normalizeProfileWorkspaceRef({
    openclawProfileId: 'profile-123',
    openclawProfile: 'owner-main',
  })
  assert.equal(profileWorkspaceBasePath(ref), '/profiles/profile-123')
  assert.equal(profileWorkspacePath(ref, '/plugins'), '/profiles/profile-123/plugins')
})

test('profile workspace paths fall back to me for current member', () => {
  const ref = normalizeProfileWorkspaceRef({ isCurrentMember: true, openclawProfile: 'member-main' })
  assert.equal(profileWorkspaceBasePath(ref), '/profiles/me')
  assert.equal(profileWorkspaceHomePath(ref, { memberRole: 'member' }), '/profiles/me/conversations')
})

test('profile workspace paths use me for non-admin workspace context', () => {
  const ref = normalizeProfileWorkspaceRef({
    isAdminSession: false,
    openclawProfileId: 'profile-123',
    openclawProfile: 'member-main',
  })

  assert.equal(profileWorkspaceBasePath(ref), '/profiles/me')
  assert.equal(profileWorkspacePath(ref, 'employees'), '/profiles/me/employees')
})

test('profile workspace paths keep profile id for admin workspace context', () => {
  const ref = normalizeProfileWorkspaceRef({
    isAdminSession: true,
    openclawProfileId: 'profile-123',
    openclawProfile: 'member-main',
  })

  assert.equal(profileWorkspaceBasePath(ref), '/profiles/profile-123')
  assert.equal(profileWorkspacePath(ref, 'employees'), '/profiles/profile-123/employees')
})
