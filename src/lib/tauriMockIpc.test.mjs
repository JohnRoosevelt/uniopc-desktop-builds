import test from 'node:test'
import assert from 'node:assert/strict'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'

import { loadEmployeeDirectory } from './employeeDirectory.js'

test('loadEmployeeDirectory uses no local IPC by default', async () => {
  const calls = []
  globalThis.window ??= globalThis

  mockIPC((command, args) => {
    calls.push({ command, args })
    throw new Error(`unexpected command: ${command}`)
  })

  try {
    const directory = await loadEmployeeDirectory({
      fetchEmployees: async () => [{ id: 'employee-1' }],
    })

    assert.deepEqual(calls, [])
    assert.deepEqual(directory.employees, [{ id: 'employee-1' }])
  } finally {
    clearMocks()
  }
})
