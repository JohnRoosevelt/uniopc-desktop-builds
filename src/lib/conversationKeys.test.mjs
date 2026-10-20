import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildConversationRecordId,
  buildSessionKey,
} from './conversationKeys.js'

test('conversation identity is scoped only to the employee', () => {
  assert.equal(buildConversationRecordId('main', 'project-1'), 'main')
  assert.equal(buildSessionKey('main', 'project-1'), 'agent:main:main')
  assert.equal(buildSessionKey('test2', 'project-2'), 'agent:test2:main')
})
