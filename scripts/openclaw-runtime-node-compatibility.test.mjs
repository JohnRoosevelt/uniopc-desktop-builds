import assert from 'node:assert/strict'
import test from 'node:test'

import {
  nodeVersionMatchesRelease,
  WINDOWS_NODE_DIST_VERSION,
} from './build-openclaw-runtime-bundle.mjs'

test('Windows runtime bundle pins the exact OpenClaw 8.1 Node release', () => {
  assert.equal(WINDOWS_NODE_DIST_VERSION, 'v24.19.0')
  assert.equal(nodeVersionMatchesRelease(WINDOWS_NODE_DIST_VERSION), true)
})
