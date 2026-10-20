import test from 'node:test'
import assert from 'node:assert/strict'

import {
  filterOwnAiEmployees,
  isOwnAiEmployee,
} from './employeeOwnership.js'

const workspaceProfile = {
  memberId: 'member-alice',
  openclawProfileId: 'profile-alice',
  openclawProfile: 'alice',
}

test('isOwnAiEmployee matches current workspace member, profile id, or profile key', () => {
  assert.equal(isOwnAiEmployee({ owner_id: 'user-alice' }, { workspaceProfile, userId: 'user-alice' }), true)
  assert.equal(isOwnAiEmployee({ organization_member_id: 'member-alice' }, { workspaceProfile }), true)
  assert.equal(isOwnAiEmployee({ openclaw_profile_id: 'profile-alice' }, { workspaceProfile }), true)
  assert.equal(isOwnAiEmployee({ openclaw_profile: 'alice' }, { workspaceProfile }), true)
  assert.equal(isOwnAiEmployee({ employee: { openclaw_profile: 'alice' } }, { workspaceProfile }), true)
})

test('isOwnAiEmployee rejects other members AI employees unless unscoped local rows are allowed', () => {
  assert.equal(isOwnAiEmployee({ organization_member_id: 'member-bob', openclaw_profile: 'bob' }, { workspaceProfile }), false)
  assert.equal(isOwnAiEmployee({ name: 'local main' }, { workspaceProfile }), false)
  assert.equal(isOwnAiEmployee({ name: 'local main' }, { workspaceProfile, allowUnscoped: true }), true)
})

test('filterOwnAiEmployees keeps only employees owned by the active workspace', () => {
  const employees = [
    { name: 'Alice Writer', openclaw_profile: 'alice' },
    { name: 'Bob CMO', openclaw_profile: 'bob' },
    { name: 'Alice Researcher', organization_member_id: 'member-alice' },
  ]

  assert.deepEqual(
    filterOwnAiEmployees(employees, { workspaceProfile }).map(employee => employee.name),
    ['Alice Writer', 'Alice Researcher'],
  )
})
