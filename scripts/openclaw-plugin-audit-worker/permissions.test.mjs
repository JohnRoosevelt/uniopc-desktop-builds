import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const image = process.env.UNIOPC_PLUGIN_AUDIT_PERMISSION_TEST_IMAGE
const engine = process.env.UNIOPC_PLUGIN_AUDIT_CONTAINER_ENGINE || 'docker'
const engineAvailable = spawnSync(engine, ['--version'], { encoding: 'utf8' }).status === 0

test('worker image defaults to the non-root worker user and entrypoint', {
  skip: !image || !engineAvailable ? 'requires a built worker image and an available container engine' : false,
}, () => {
  const inspected = spawnSync(engine, ['image', 'inspect', image, '--format', '{{json .Config}}'], { encoding: 'utf8' })
  assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout)
  const config = JSON.parse(inspected.stdout)
  assert.equal(config.User, '65532:65532')
  assert.deepEqual(config.Entrypoint, ['node', 'scripts/openclaw-plugin-audit-worker/entrypoint.mjs'])
})

test('worker container enforces non-root, read-only input/root, writable work, no network, and no capabilities', {
  skip: !image || !engineAvailable ? 'requires a built worker image and an available container engine' : false,
}, () => {
  const inputRoot = mkdtempSync(join(tmpdir(), 'uniopc-audit-input-'))
  writeFileSync(join(inputRoot, 'fixture'), 'immutable')
  try {
    const restrictions = [
      'run', '--rm', '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--user', '65532:65532',
      '--tmpfs', '/audit-work:rw,noexec,nosuid,nodev,size=64m',
      '--mount', `type=bind,src=${inputRoot},dst=/audit-input,readonly`,
      '--entrypoint', 'sh', image,
    ]
    const result = spawnSync(engine, [...restrictions,
      '-ec', 'test "$(id -u)" = 65532; touch /audit-work/probe; test -f /audit-work/probe; node -e "fetch(\'http://1.1.1.1\', { signal: AbortSignal.timeout(1000) }).then(() => process.exit(1), () => process.exit(0))"; test "$(grep CapEff /proc/self/status | cut -f2)" = 0000000000000000',
    ], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const immutableRestrictions = restrictions.map((value) => value === '65532:65532' ? '0:0' : value)
    const immutable = spawnSync(engine, [...immutableRestrictions,
      '-ec', '! touch /root-write; ! touch /audit-input/mutated',
    ], { encoding: 'utf8' })
    assert.equal(immutable.status, 0, immutable.stderr || immutable.stdout)
  } finally {
    rmSync(inputRoot, { recursive: true, force: true })
  }
})
