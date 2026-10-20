import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildConversationRoster,
  conversationTargetUnreadCount,
  conversationTargetUpdatedAt,
} from './conversationRoster.js'

test('buildConversationRoster sorts AI targets by their latest conversation time', () => {
  const employees = [
    { id: 'agent-old', name: 'Old AI' },
    { id: 'agent-new', name: 'New AI' },
  ]
  const conversations = [
    { id: 'agent-old:main', employeeId: 'agent-old', messages: [{ createdAt: 1_000 }] },
    { id: 'agent-new:main', employeeId: 'agent-new', messages: [{ createdAt: 3_000 }] },
    { id: 'agent-new:side', employeeId: 'agent-new', messages: [{ createdAt: 7_000 }] },
  ]

  const roster = buildConversationRoster({ employees, conversations })

  assert.deepEqual(roster.map(item => `${item.type}:${item.id}`), [
    'employee:agent-new',
    'employee:agent-old',
  ])
})

test('conversationTargetUpdatedAt ignores unrelated AI records', () => {
  const conversations = [
    { id: 'agent-1:main', employeeId: 'agent-1', messages: [{ createdAt: 8_000 }] },
  ]

  assert.equal(conversationTargetUpdatedAt('employee', 'agent-1', conversations), 8_000)
  assert.equal(conversationTargetUpdatedAt('employee', 'agent-2', conversations), 0)
})

test('conversationTargetUpdatedAt ignores empty records created by selecting an employee', () => {
  const conversations = [
    { id: 'agent-empty:main', employeeId: 'agent-empty', updatedAt: 10_000, messages: [] },
  ]

  assert.equal(conversationTargetUpdatedAt('employee', 'agent-empty', conversations), 0)
})

test('conversationTargetUnreadCount counts only inbound messages newer than the read marker', () => {
  const conversations = [
    {
      id: 'agent-1:main',
      employeeId: 'agent-1',
      messages: [
        { role: 'assistant', createdAt: 1_000 },
        { role: 'user', createdAt: 2_000 },
        { role: 'assistant', createdAt: 3_000 },
        { role: 'assistant', createdAt: 4_000 },
      ],
    },
  ]

  // No marker: every inbound message is unread; my own 'user' turns never count.
  assert.equal(conversationTargetUnreadCount('employee', 'agent-1', conversations, 0), 3)
  // Marker at 3_000: only the 4_000 assistant message remains unread.
  assert.equal(conversationTargetUnreadCount('employee', 'agent-1', conversations, 3_000), 1)
  // Marker past the newest message: nothing unread.
  assert.equal(conversationTargetUnreadCount('employee', 'agent-1', conversations, 9_000), 0)
})

test('buildConversationRoster attaches per-target unread counts from read marks', () => {
  const employees = [{ id: 'agent-1', name: 'AI' }]
  const conversations = [
    {
      id: 'agent-1:main',
      employeeId: 'agent-1',
      messages: [
        { role: 'assistant', createdAt: 1_000 },
        { role: 'assistant', createdAt: 2_000 },
      ],
    },
  ]

  const roster = buildConversationRoster({
    employees,
    conversations,
    readMarks: { 'employee:agent-1': 1_000 },
  })

  const byTarget = Object.fromEntries(roster.map(item => [`${item.type}:${item.id}`, item.unreadCount]))
  assert.equal(byTarget['employee:agent-1'], 1)
})

test('buildConversationRoster defaults unread counts to zero without read marks', () => {
  const roster = buildConversationRoster({
    employees: [{ id: 'agent-1', name: 'AI' }],
    conversations: [],
  })

  assert.equal(roster[0].unreadCount, 0)
})
