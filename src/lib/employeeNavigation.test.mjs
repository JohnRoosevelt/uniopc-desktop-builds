import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildEmployeeCreatePath,
  shouldOpenEmployeeCreateFromSearch,
} from './employeeNavigation.js'

test('employee create navigation carries explicit create intent', () => {
  assert.equal(buildEmployeeCreatePath(), '/employees?create=1')
})

test('employee page recognizes only the create intent query value', () => {
  assert.equal(shouldOpenEmployeeCreateFromSearch(new URLSearchParams('create=1')), true)
  assert.equal(shouldOpenEmployeeCreateFromSearch(new URLSearchParams('create=0')), false)
  assert.equal(shouldOpenEmployeeCreateFromSearch(new URLSearchParams('agent=main')), false)
})
