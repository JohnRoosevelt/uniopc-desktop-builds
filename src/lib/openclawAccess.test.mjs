import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canManageMemberOpenClawPairing,
  memberRemotePairingSetupFromBootstrap,
  memberRemoteConnectionTargetFromBootstrap,
  memberClientStatusFromBootstrap,
  remoteGatewayEndpointIssue,
  resolveOpenClawAccessMode,
  shouldDeferOpenClawDirectoryHydration,
  shouldRequireLocalOpenClawSetup,
  shouldUseCloudEmployeeDirectory,
} from './openclawAccess.js'

test('owner and admin devices must satisfy local Uniopc 引擎 readiness', () => {
  assert.equal(shouldRequireLocalOpenClawSetup({ memberRole: 'owner' }), true)
  assert.equal(shouldRequireLocalOpenClawSetup({ memberRole: 'admin' }), true)
  assert.equal(resolveOpenClawAccessMode({ memberRole: 'owner' }), 'owner_host')
})

test('ordinary members in the host app use their own local Uniopc 引擎 readiness', () => {
  const workspace = {
    memberRole: 'member',
    openclawProfile: 'alice',
    profileStatus: 'active',
  }

  assert.equal(shouldRequireLocalOpenClawSetup(workspace, { appMode: 'admin-host' }), true)
  assert.equal(shouldUseCloudEmployeeDirectory(workspace, null, { appMode: 'admin-host' }), true)
  assert.equal(resolveOpenClawAccessMode(workspace, null, { appMode: 'admin-host' }), 'member_local')
})

test('member-local profiles use local Uniopc 引擎 setup in the Host app', () => {
  const workspace = {
    memberRole: 'member',
    openclawProfile: 'alice',
    profileStatus: 'active',
    runtimeMode: 'member_local',
  }

  assert.equal(shouldRequireLocalOpenClawSetup(workspace, { appMode: 'admin-host' }), true)
  assert.equal(resolveOpenClawAccessMode(workspace, null, { appMode: 'admin-host' }), 'member_local')
})

test('owner-hosted runtime flags are ignored for ordinary members', () => {
  const workspace = {
    memberRole: 'member',
    openclawProfile: 'alice',
    profileStatus: 'active',
    runtimeMode: 'owner_hosted',
  }

  assert.equal(shouldRequireLocalOpenClawSetup(workspace, { appMode: 'admin-host' }), true)
  assert.equal(resolveOpenClawAccessMode(workspace, null, { appMode: 'admin-host' }), 'member_local')
})

test('removed member-client app mode still resolves to member-local behavior', () => {
  const workspace = {
    memberRole: 'member',
    openclawProfile: 'alice',
    profileStatus: 'active',
  }

  assert.equal(shouldRequireLocalOpenClawSetup(workspace, { appMode: 'employee' }), true)
  assert.equal(shouldUseCloudEmployeeDirectory(workspace, null, { appMode: 'employee' }), true)
  assert.equal(resolveOpenClawAccessMode(workspace, null, { appMode: 'employee' }), 'member_local')
})

test('ordinary members no longer attempt owner-hosted Gateway pairing from the client app', () => {
  const online = {
    memberRole: 'member',
    openclawProfile: 'alice',
    profileStatus: 'active',
    runtimeMode: 'owner_hosted',
    hostStatus: 'online',
    gatewayStatus: 'online',
  }
  const stale = {
    ...online,
    gatewayStatus: 'degraded',
  }

})

test('members without active profile wait for a usable remote profile', () => {
  assert.equal(shouldUseCloudEmployeeDirectory({ memberRole: 'member', profileStatus: 'missing' }, null, { appMode: 'employee' }), false)
  assert.equal(resolveOpenClawAccessMode({ memberRole: 'member', profileStatus: 'missing' }, null, { appMode: 'employee' }), 'missing_profile')
})

test('authenticated clients defer employee directory hydration until workspace profile role is known', () => {
  assert.equal(shouldDeferOpenClawDirectoryHydration({ userId: 'user-1', workspaceProfileLoading: true }), true)
  assert.equal(shouldDeferOpenClawDirectoryHydration({ userId: 'user-1', workspaceProfileLoading: false }), false)
  assert.equal(shouldDeferOpenClawDirectoryHydration({ userId: '', workspaceProfileLoading: true }), false)
})

test('ordinary members ignore assigned Gateway bootstrap in the host desktop app', () => {
  const workspace = {
    memberRole: 'member',
    profileStatus: 'missing',
  }
  const bootstrap = {
    status: 'ready',
    gatewayAssignment: {
      id: 'assignment-1',
      openclawProfile: 'alice',
      gatewayUrl: 'wss://owner.example.ts.net',
      gatewayStatus: 'online',
      status: 'active',
    },
    agents: [{ id: 'sales' }],
  }

  assert.equal(shouldUseCloudEmployeeDirectory(workspace, bootstrap, { appMode: 'employee' }), false)
  assert.equal(resolveOpenClawAccessMode(workspace, bootstrap, { appMode: 'employee' }), 'missing_profile')
})

test('member client bootstrap resolves stable ordinary-client states', () => {
  assert.equal(memberClientStatusFromBootstrap(null), 'no_assignment')
  assert.equal(memberClientStatusFromBootstrap({ device: { status: 'pending' } }), 'device_pending')
  assert.equal(memberClientStatusFromBootstrap({ device: { status: 'revoked' } }), 'revoked')
  assert.equal(memberClientStatusFromBootstrap({ status: 'revoked' }), 'revoked')
  assert.equal(memberClientStatusFromBootstrap({
    gatewayAssignment: { id: 'assignment-1', status: 'active', gatewayStatus: 'offline' },
    agents: [{ id: 'sales' }],
  }), 'ready')
  assert.equal(memberClientStatusFromBootstrap({
    gatewayAssignment: { id: 'assignment-1', status: 'active', gatewayStatus: 'online', gatewayUrl: 'wss://owner.example.ts.net' },
    agents: [],
  }), 'ready')
  assert.equal(memberClientStatusFromBootstrap({
    status: 'permission_empty',
    gatewayAssignment: { id: 'assignment-1', status: 'active', gatewayStatus: 'online', gatewayUrl: 'wss://owner.example.ts.net' },
    agents: [],
  }), 'ready')
  assert.equal(memberClientStatusFromBootstrap({
    gatewayAssignment: { id: 'assignment-1', status: 'active', gatewayStatus: 'online', gatewayUrl: 'wss://owner.example.ts.net' },
    agents: [{ id: 'sales' }],
  }), 'ready')
})

test('member client bootstrap does not require cloud gateway URL or token', () => {
  const bootstrap = {
    gatewayAssignment: {
      id: 'assignment-1',
      status: 'active',
      gatewayStatus: 'offline',
      openclawProfile: 'alice',
      gatewayUrl: '',
      authToken: 'cloud-should-not-be-used',
    },
    agents: [{ id: 'sales' }],
  }

  assert.equal(memberClientStatusFromBootstrap(bootstrap), 'ready')
  assert.deepEqual(memberRemoteConnectionTargetFromBootstrap(bootstrap), {
    transport: 'direct',
    openclawProfile: 'alice',
    organizationId: '',
    openclawProfileId: '',
    hostId: '',
    memberId: '',
    assignmentId: 'assignment-1',
    gatewayUrl: '',
    authToken: null,
    authPassword: null,
    sshTarget: '',
    sshRemoteHost: '127.0.0.1',
    sshRemotePort: 18790,
    sshLocalPort: 18791,
  })
})

test('member bootstrap exposes assignment identity for discovery without trusting raw gateway url', () => {
  const bootstrap = {
    gatewayAssignment: {
      id: 'assignment-1',
      status: 'active',
      organizationId: 'org-1',
      openclawProfileId: 'profile-1',
      openclawProfile: 'member-main',
      hostId: 'host-1',
      memberId: 'member-1',
      gatewayUrl: 'ws://untrusted.example:18790',
    },
    agents: [{ id: 'agent-1' }],
  }

  const target = memberRemoteConnectionTargetFromBootstrap(bootstrap)

  assert.equal(target.gatewayUrl, '')
  assert.equal(target.organizationId, 'org-1')
  assert.equal(target.openclawProfileId, 'profile-1')
  assert.equal(target.hostId, 'host-1')
  assert.equal(target.memberId, 'member-1')
  assert.equal(target.assignmentId, 'assignment-1')
})

test('member client bootstrap ignores stale cloud Gateway endpoints because connection is local-only', () => {
  const base = {
    gatewayAssignment: {
      id: 'assignment-1',
      status: 'active',
      gatewayStatus: 'online',
      accessMode: 'direct',
    },
    agents: [{ id: 'sales' }],
  }

  assert.equal(memberClientStatusFromBootstrap({
    ...base,
    gatewayAssignment: {
      ...base.gatewayAssignment,
      gatewayUrl: 'ws://127.0.0.1:18821',
    },
  }), 'ready')
  assert.equal(memberClientStatusFromBootstrap({
    ...base,
    gatewayAssignment: {
      ...base.gatewayAssignment,
      gatewayUrl: 'ws://owner.example.com:18821',
    },
  }), 'ready')
  assert.equal(memberClientStatusFromBootstrap({
    ...base,
    gatewayAssignment: {
      ...base.gatewayAssignment,
      gatewayUrl: 'wss://owner.example.ts.net',
    },
  }), 'ready')
})

test('member client bootstrap resolves ssh tunnel remote Gateway assignments', () => {
  const bootstrap = {
    gatewayAssignment: {
      id: 'assignment-1',
      status: 'active',
      gatewayStatus: 'online',
      openclawProfile: 'alice',
      gatewayUrl: 'ws://127.0.0.1:18791',
      accessMode: 'ssh_tunnel',
      sshTarget: 'owner@100.105.138.117',
      sshRemoteHost: '127.0.0.1',
      sshRemotePort: 18790,
      sshLocalPort: 18791,
    },
    agents: [{ id: 'sales' }],
  }

  assert.equal(memberClientStatusFromBootstrap(bootstrap), 'ready')
  assert.deepEqual(memberRemoteConnectionTargetFromBootstrap(bootstrap), {
    transport: 'direct',
    openclawProfile: 'alice',
    organizationId: '',
    openclawProfileId: '',
    hostId: '',
    memberId: '',
    assignmentId: 'assignment-1',
    gatewayUrl: '',
    authToken: null,
    authPassword: null,
    sshTarget: '',
    sshRemoteHost: '127.0.0.1',
    sshRemotePort: 18790,
    sshLocalPort: 18791,
  })
})

test('member client bootstrap ignores cloud SSH transport when setup code omits transport fields', () => {
  const bootstrap = {
    gatewayAssignment: {
      id: 'assignment-1',
      status: 'active',
      gatewayStatus: 'online',
      openclawProfile: 'alice',
      gatewayUrl: 'ws://127.0.0.1:18791',
      accessMode: 'ssh_tunnel',
      transport: 'ssh',
      sshTarget: 'owner@100.105.138.117',
      sshRemoteHost: '127.0.0.1',
      sshRemotePort: 18790,
      sshLocalPort: 18791,
    },
    pairingSetup: {
      openclawProfile: 'alice',
      setupCode: 'setup-code-1',
      gatewayUrl: 'ws://127.0.0.1:18791',
    },
    agents: [{ id: 'sales' }],
  }

  assert.equal(memberRemoteConnectionTargetFromBootstrap(bootstrap)?.transport, 'direct')
  assert.equal(memberRemotePairingSetupFromBootstrap(bootstrap)?.transport, 'direct')
  assert.equal(memberRemoteConnectionTargetFromBootstrap(bootstrap)?.gatewayUrl, '')
  assert.equal(memberRemotePairingSetupFromBootstrap(bootstrap)?.gatewayUrl, '')
})

test('member client bootstrap stays ready when cloud SSH target is missing because member config is local', () => {
  assert.equal(memberClientStatusFromBootstrap({
    gatewayAssignment: {
      id: 'assignment-1',
      status: 'active',
      gatewayStatus: 'online',
      openclawProfile: 'alice',
      gatewayUrl: 'ws://127.0.0.1:18791',
      accessMode: 'ssh_tunnel',
    },
    agents: [{ id: 'sales' }],
  }), 'ready')
  assert.deepEqual(memberRemoteConnectionTargetFromBootstrap({
    gatewayAssignment: {
      id: 'assignment-1',
      status: 'active',
      gatewayStatus: 'online',
      openclawProfile: 'alice',
      gatewayUrl: 'ws://127.0.0.1:18791',
      accessMode: 'ssh_tunnel',
    },
    agents: [{ id: 'sales' }],
  }), {
    transport: 'direct',
    openclawProfile: 'alice',
    organizationId: '',
    openclawProfileId: '',
    hostId: '',
    memberId: '',
    assignmentId: 'assignment-1',
    gatewayUrl: '',
    authToken: null,
    authPassword: null,
    sshTarget: '',
    sshRemoteHost: '127.0.0.1',
    sshRemotePort: 18790,
    sshLocalPort: 18791,
  })
})

test('remote Gateway endpoint issues explain official mobile-style safety failures', () => {
  assert.equal(remoteGatewayEndpointIssue(''), 'missing')
  assert.equal(remoteGatewayEndpointIssue('ws://127.0.0.1:18821', { accessMode: 'direct' }), 'loopback_direct')
  assert.equal(remoteGatewayEndpointIssue('ws://owner.example.com:18821', { accessMode: 'direct' }), 'remote_cleartext')
  assert.equal(remoteGatewayEndpointIssue('ws://192.168.1.20:18821', { accessMode: 'direct' }), '')
  assert.equal(remoteGatewayEndpointIssue('ws://100.105.138.117:18821', { accessMode: 'direct' }), '')
  assert.equal(remoteGatewayEndpointIssue('wss://owner.example.ts.net', { accessMode: 'direct' }), '')
  assert.equal(remoteGatewayEndpointIssue('ws://127.0.0.1:18821', { accessMode: 'local_tunnel' }), '')
  assert.equal(remoteGatewayEndpointIssue('ws://127.0.0.1:18821', { accessMode: 'ssh_tunnel' }), '')
})

test('member bootstrap exposes official setup-code pairing only for safe assigned endpoints', () => {
  const bootstrap = {
    gatewayAssignment: {
      id: 'assignment-1',
      openclawProfile: 'alice',
      gatewayUrl: 'wss://owner.example.ts.net',
      gatewayStatus: 'online',
      accessMode: 'direct',
      status: 'active',
    },
    pairingSetup: {
      openclawProfile: 'alice',
      setupCode: 'setup-code-1',
      gatewayUrl: 'wss://owner.example.ts.net',
      expiresAt: '2026-05-18T10:30:00.000Z',
    },
    agents: [{ id: 'sales' }],
  }

  assert.deepEqual(memberRemotePairingSetupFromBootstrap(bootstrap), {
    openclawProfile: 'alice',
    setupCode: 'setup-code-1',
    gatewayUrl: '',
    transport: 'direct',
    sshTarget: '',
    sshRemoteHost: '127.0.0.1',
    sshRemotePort: 18790,
    sshLocalPort: 18791,
    expiresAt: '2026-05-18T10:30:00.000Z',
    source: 'member-gateway-assignment',
  })
  assert.deepEqual(memberRemotePairingSetupFromBootstrap({
    ...bootstrap,
    gatewayAssignment: {
      ...bootstrap.gatewayAssignment,
      gatewayUrl: 'ws://127.0.0.1:18821',
    },
    pairingSetup: {
      ...bootstrap.pairingSetup,
      gatewayUrl: 'ws://127.0.0.1:18821',
    },
  }), {
    openclawProfile: 'alice',
    setupCode: 'setup-code-1',
    gatewayUrl: '',
    transport: 'direct',
    sshTarget: '',
    sshRemoteHost: '127.0.0.1',
    sshRemotePort: 18790,
    sshLocalPort: 18791,
    expiresAt: '2026-05-18T10:30:00.000Z',
    source: 'member-gateway-assignment',
  })
})

test('remote Uniopc 引擎 pairing is only manageable for ordinary active members', () => {
  const activeMember = {
    memberRole: 'member',
    openclawProfile: 'alice',
    openclawProfileId: 'profile-alice',
    profileStatus: 'active',
  }

  assert.equal(canManageMemberOpenClawPairing(activeMember), true)
  assert.equal(canManageMemberOpenClawPairing({ ...activeMember, memberRole: 'owner' }), false)
  assert.equal(canManageMemberOpenClawPairing({ ...activeMember, memberRole: 'admin' }), false)
  assert.equal(canManageMemberOpenClawPairing({ ...activeMember, openclawProfileId: '' }), false)
  assert.equal(canManageMemberOpenClawPairing({ ...activeMember, profileStatus: 'suspended' }), false)
})
