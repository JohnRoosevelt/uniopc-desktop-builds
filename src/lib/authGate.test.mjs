import assert from 'node:assert/strict'
import test from 'node:test'
import { blockedAuthenticatedAppMessage, canEnterAuthenticatedApp, shouldRedirectLoggedInUserFromLogin } from './authGate.js'

test('authenticated users can enter the app without legacy invite activation', () => {
  assert.equal(canEnterAuthenticatedApp({
    user: { uid: 'user-1' },
    profile: { uid: 'user-1', invite_accepted_at: null },
  }), true)
})

test('ordinary members can enter the host app to run their own Uniopc 引擎', () => {
  assert.equal(canEnterAuthenticatedApp({
    user: { uid: 'user-1' },
    workspaceProfile: { memberRole: 'member' },
    appMode: 'admin-host',
  }), true)
})

test('owners and admins can enter the admin host app', () => {
  for (const memberRole of ['owner', 'admin']) {
    assert.equal(canEnterAuthenticatedApp({
      user: { uid: 'user-1' },
      workspaceProfile: { memberRole },
      appMode: 'admin-host',
    }), true)
  }
})

test('agent-approved owners without an organization can enter the host setup path', () => {
  assert.equal(canEnterAuthenticatedApp({
    user: { uid: 'user-1' },
    workspaceProfile: { memberRole: 'setup_required', profileStatus: 'workspace_not_found' },
    appMode: 'admin-host',
  }), true)
  assert.equal(shouldRedirectLoggedInUserFromLogin({
    user: { uid: 'user-1' },
    workspaceProfile: { memberRole: 'setup_required', profileStatus: 'workspace_not_found' },
    appMode: 'admin-host',
  }), true)
})

test('unopened users cannot enter the host app once workspace status is known', () => {
  assert.equal(canEnterAuthenticatedApp({
    user: { uid: 'user-1' },
    workspaceProfile: { memberRole: 'unopened', profileStatus: 'imai_admin_not_found' },
    appMode: 'admin-host',
  }), false)
})

test('suspended organizations cannot enter the host app once workspace status is known', () => {
  assert.equal(canEnterAuthenticatedApp({
    user: { uid: 'user-1' },
    workspaceProfile: { memberRole: 'owner', profileStatus: 'organization_suspended' },
    appMode: 'admin-host',
  }), false)
})

test('blocked app messages use the host account wording', () => {
  assert.equal(blockedAuthenticatedAppMessage({
    workspaceProfile: { memberRole: 'unopened', profileStatus: 'imai_admin_not_found' },
    appMode: 'admin-host',
  }), '查不到用户，请联系 Uniopc 管理员开通')
})

test('anonymous users cannot enter the authenticated app', () => {
  assert.equal(canEnterAuthenticatedApp({
    user: null,
    profile: null,
  }), false)
})

test('login page redirects any authenticated user without asking for an invite code', () => {
  assert.equal(shouldRedirectLoggedInUserFromLogin({
    user: { uid: 'user-1' },
    profile: { uid: 'user-1', invite_accepted_at: null },
  }), true)
})

test('login page redirects ordinary members into the host app when role is known', () => {
  assert.equal(shouldRedirectLoggedInUserFromLogin({
    user: { uid: 'user-1' },
    workspaceProfile: { memberRole: 'member' },
    appMode: 'admin-host',
  }), true)
})
