import test from 'node:test'
import assert from 'node:assert/strict'

import { loadEmployeeDirectory } from './employeeDirectory.js'

test('loadEmployeeDirectory exposes one profile employee pool for shared consumers', async () => {
  const calls = []
  const employees = [
    { id: 'imai:main', openclaw_agent_id: 'main', name: 'main' },
    { id: 'imai:test2', openclaw_agent_id: 'test2', name: 'Test2' },
  ]

  const directory = await loadEmployeeDirectory({
    profile: 'imai',
    getCachedEmployees: (profile) => {
      calls.push(['getCachedEmployees', profile])
      return null
    },
    loadCachedEmployees: async (profile) => {
      calls.push(['loadCachedEmployees', profile])
      return []
    },
    fetchEmployees: async ({ force, profile }) => {
      calls.push(['fetchEmployees', force, profile])
      return employees
    },
  })

  assert.deepEqual(directory.employees.map(item => item.name), ['main', 'Test2'])
  assert.equal(directory.hadCachedRows, false)
  assert.deepEqual(calls, [
    ['fetchEmployees', false, 'imai'],
  ])
})

test('loadEmployeeDirectory treats Gateway runtime as the AI employee source of truth', async () => {
  const calls = []
  const directory = await loadEmployeeDirectory({
    profile: 'imai',
    getCachedEmployees: () => {
      calls.push('getCachedEmployees')
      return [
        { id: 'legacy-cache:stale', openclaw_agent_id: 'stale', name: 'Legacy Cache Stale' },
      ]
    },
    loadCachedEmployees: async () => {
      calls.push('loadCachedEmployees')
      return [
        { id: 'legacy-cache:stale', openclaw_agent_id: 'stale', name: 'Legacy Cache Stale' },
      ]
    },
    fetchEmployees: async ({ force, profile }) => {
      calls.push(['fetchEmployees', force, profile])
      return [
        { id: 'imai:main', openclaw_agent_id: 'main', name: 'Elon' },
      ]
    },
  })

  assert.equal(directory.source, 'runtime')
  assert.deepEqual(directory.employees.map(item => item.name), ['Elon'])
  assert.deepEqual(calls, [['fetchEmployees', false, 'imai']])
})

test('loadEmployeeDirectory does not return stale cached rows before Gateway runtime finishes', async () => {
  let runtimeFetchStarted = false
  const directory = await loadEmployeeDirectory({
    profile: 'imai',
    getCachedEmployees: () => null,
    loadCachedEmployees: async () => [
      { id: 'imai:main', openclaw_agent_id: 'main', name: 'main' },
    ],
    fetchEmployees: async () => {
      runtimeFetchStarted = true
      await Promise.resolve()
      return [{ id: 'runtime:test2', openclaw_agent_id: 'test2', name: 'Test2' }]
    },
  })

  assert.equal(runtimeFetchStarted, true)
  assert.deepEqual(directory.employees.map(item => item.name), ['Test2'])
  assert.equal(directory.source, 'runtime')
})

test('loadEmployeeDirectory force refresh still uses Gateway runtime as source', async () => {
  const calls = []
  const directory = await loadEmployeeDirectory({
    profile: 'imai',
    force: true,
    getCachedEmployees: () => [
      { id: 'imai:main', openclaw_agent_id: 'main', name: 'Elon' },
    ],
    loadCachedEmployees: async () => {
      calls.push('loadCachedEmployees')
      return []
    },
    fetchEmployees: async ({ force, profile }) => {
      calls.push(['fetchEmployees', force, profile])
      return [{ id: 'imai:main', openclaw_agent_id: 'main', name: 'main' }]
    },
  })

  assert.deepEqual(directory.employees.map(item => item.name), ['main'])
  assert.equal(directory.source, 'runtime')
  assert.deepEqual(calls, [['fetchEmployees', true, 'imai']])
})

test('loadEmployeeDirectory can load owner-hosted member employees from cloud only', async () => {
  const calls = []
  const directory = await loadEmployeeDirectory({
    profile: 'alice',
    source: 'cloud',
    loadCloudEmployees: async () => {
      calls.push('loadCloudEmployees')
      return [
        { id: 'cloud-1', openclaw_agent_id: 'sales', name: '销售助理', status: 'online' },
      ]
    },
    getCachedEmployees: () => {
      calls.push('getCachedEmployees')
      return [{ id: 'local-should-not-load' }]
    },
    loadCachedEmployees: async () => {
      calls.push('loadCachedEmployees')
      return [{ id: 'local-should-not-load' }]
    },
    fetchEmployees: async () => {
      calls.push('fetchEmployees')
      return [{ id: 'runtime-should-not-load' }]
    },
  })

  assert.equal(directory.source, 'cloud')
  assert.deepEqual(directory.employees.map(item => item.name), ['销售助理'])
  assert.deepEqual(calls, ['loadCloudEmployees'])
})
