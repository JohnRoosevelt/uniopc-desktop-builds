import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertPhoneRegistrationAllowed,
  registrationGateRpcName,
  registrationGateRpcNames,
  REGISTRATION_GATE_RPC,
  registrationDeniedMessage,
} from './registrationGate.js'

function fakeClient(responses = {}) {
  const calls = []
  return {
    calls,
    client: {
      rpc(name, args) {
        calls.push({ name, args })
        if (typeof responses[name] === 'function') return Promise.resolve(responses[name](args))
        return Promise.resolve(responses[name] || { data: null, error: null })
      },
    },
  }
}

test('registrationGateRpcName resolves to the single gate predicate', () => {
  assert.equal(registrationGateRpcName('admin-host'), REGISTRATION_GATE_RPC)
  assert.equal(registrationGateRpcName('employee'), 'registration_gate_allows')
})

test('registrationGateRpcNames returns the gate predicate', () => {
  assert.deepEqual(registrationGateRpcNames('admin-host'), ['registration_gate_allows'])
})

test('phone-only registration gate passes only a phone identity', async () => {
  const fake = fakeClient({ registration_gate_allows: { data: true, error: null } })

  const allowed = await assertPhoneRegistrationAllowed(fake.client, ' 13800138000 ')

  assert.equal(allowed, true)
  assert.deepEqual(fake.calls, [
    { name: 'registration_gate_allows', args: { p_email: null, p_phone: '13800138000' } },
  ])
})

test('phone-only registration gate rejects when the gate returns false', async () => {
  const fake = fakeClient({ registration_gate_allows: { data: false, error: null } })

  await assert.rejects(
    () => assertPhoneRegistrationAllowed(fake.client, '13800138000'),
    (err) => {
      assert.equal(err.code, 'registration_gate_closed')
      assert.match(err.message, /尚未开通/)
      return true
    }
  )
})

test('phone-only registration gate fails open when the gate RPC errors', async () => {
  const fake = fakeClient({ registration_gate_allows: { data: null, error: { message: 'boom' } } })

  const allowed = await assertPhoneRegistrationAllowed(fake.client, '13800138000')

  assert.equal(allowed, true)
})

test('phone-only registration gate fails open when the RPC throws', async () => {
  const fake = fakeClient({
    registration_gate_allows: () => {
      throw new Error('network down')
    },
  })

  const allowed = await assertPhoneRegistrationAllowed(fake.client, '13800138000')

  assert.equal(allowed, true)
})

test('phone-only registration gate rejects an empty phone without calling the gate', async () => {
  const fake = fakeClient()

  await assert.rejects(
    () => assertPhoneRegistrationAllowed(fake.client, '   '),
    (err) => {
      assert.equal(err.code, 'registration_identity_invalid')
      return true
    }
  )
  assert.deepEqual(fake.calls, [])
})

test('registrationDeniedMessage is a non-empty user-facing string', () => {
  assert.equal(typeof registrationDeniedMessage(), 'string')
  assert.ok(registrationDeniedMessage().length > 0)
})
