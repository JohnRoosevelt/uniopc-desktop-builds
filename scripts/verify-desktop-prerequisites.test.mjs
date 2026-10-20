import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyDesktopPrerequisites } from './verify-desktop-prerequisites.mjs'

test('desktop prerequisites are not checked outside Windows', () => {
  assert.deepEqual(verifyDesktopPrerequisites({ platform: 'linux' }), [])
})

test('Windows prerequisites probe perl with where.exe', () => {
  const calls = []
  const execFileSync = (...args) => calls.push(args)

  assert.deepEqual(verifyDesktopPrerequisites({ platform: 'win32', execFileSync }), [])
  assert.deepEqual(calls, [['where.exe', ['perl'], { stdio: 'ignore' }]])
})

test('Windows missing perl error is actionable', () => {
  const execFileSync = () => {
    throw new Error('not found')
  }

  assert.throws(
    () => verifyDesktopPrerequisites({ platform: 'win32', execFileSync }),
    /Rust cold builds require perl\.exe.*Strawberry Perl.*reopen the terminal/u,
  )
})
