import test from 'node:test'
import assert from 'node:assert/strict'

import {
  conversationTargetKey,
  markConversationTargetRead,
} from './conversationReadState.js'

test('conversationTargetKey namespaces by target type and id', () => {
  assert.equal(conversationTargetKey('employee', 'agent-1'), 'employee:agent-1')
  assert.equal(conversationTargetKey('human', ' human-1 '), 'human:human-1')
})

test('markConversationTargetRead advances a marker forward only', () => {
  const start = {}
  const first = markConversationTargetRead(start, 'employee', 'agent-1', 5_000)
  assert.equal(first['employee:agent-1'], 5_000)
  assert.notEqual(first, start)

  // An older timestamp is ignored and the same reference is returned.
  const stale = markConversationTargetRead(first, 'employee', 'agent-1', 3_000)
  assert.equal(stale, first)

  // A newer timestamp advances the marker.
  const advanced = markConversationTargetRead(first, 'employee', 'agent-1', 9_000)
  assert.equal(advanced['employee:agent-1'], 9_000)
  assert.notEqual(advanced, first)
})

test('markConversationTargetRead ignores targets without an id', () => {
  const marks = { 'employee:agent-1': 1_000 }
  assert.equal(markConversationTargetRead(marks, 'human', '', 5_000), marks)
})
