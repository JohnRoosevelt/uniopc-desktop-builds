import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'openclaw-audit-worker.yml')

function workerWorkflow() {
  assert.equal(existsSync(workflowPath), true, 'missing OpenClaw audit-worker publication workflow')
  return readFileSync(workflowPath, 'utf8')
}

test('worker workflow publishes both Linux platforms with provenance', () => {
  const workflow = workerWorkflow()

  assert.match(workflow, /packages:\s*write/)
  assert.match(workflow, /id-token:\s*write/)
  assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/)
  assert.match(workflow, /provenance:\s*mode=max/)
  assert.match(workflow, /push:\s*true/)
  assert.match(workflow, /ghcr\.io\/0xbootiful\/uniopc-openclaw-audit-worker:\$\{\{ github\.sha \}\}/)
})

test('worker workflow checks the image before publication', () => {
  const workflow = workerWorkflow()
  const publish = workflow.slice(workflow.indexOf('\n  publish:'))

  assert.match(publish, /entrypoint\.test\.mjs/)
  assert.match(publish, /permissions\.test\.mjs/)
  assert.match(publish, /--platform linux\/amd64/)
  assert.match(publish, /--platform linux\/arm64/)
  assert.match(publish, /arm64 protocol smoke/i)
  assert.match(publish, /negative worker output/i)

  const firstPush = publish.indexOf('push: true')
  const firstCheck = Math.min(
    publish.indexOf('permissions.test.mjs'),
    publish.toLowerCase().indexOf('negative worker output'),
  )
  assert.ok(firstCheck >= 0 && firstPush > firstCheck, 'worker checks must run before the registry push')
})

function stepSource(source, name) {
  const marker = `      - name: ${name}`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing ${name} step`)
  const tail = source.slice(start + marker.length)
  const next = tail.search(/\n      - (?:name:|uses:)/)
  return next < 0 ? tail : tail.slice(0, next)
}

test('arm64 smoke and negative command checks reject a successful worker and require its sanitized report', () => {
  const source = workerWorkflow()
  const publish = source.slice(source.indexOf('\n  publish:'))

  for (const name of [
    'Run arm64 protocol smoke before publication',
    'Check negative worker output before publication',
  ]) {
    const step = stepSource(publish, name)
    assert.doesNotMatch(step, /\|\|\s*test\s+\$\?\s+-eq\s+1/)
    assert.match(step, /status=\$\?/)
    assert.match(step, /if \[ "\$status" -eq 0 \]; then[\s\S]*exit 1[\s\S]*fi/)
    assert.match(step, /grep -F(?:x)? '\{"errors":\[\],"ok":false,"schemaVersion":1,"warnings":\[\]\}'/)
  }
})

test('worker smoke shell steps pass complete Docker commands', () => {
  const source = workerWorkflow()
  const expectedReport = '{"errors":[],"ok":false,"schemaVersion":1,"warnings":[]}'
  const dockerStub = `docker() {
    if [ "$1" = buildx ]; then
      case "$*" in
        *' --tag uniopc-openclaw-audit-worker:verify-arm64 .'*) return 0 ;;
        *) return 97 ;;
      esac
    fi
    if [ "$1" = run ]; then
      printf '%s\\n' '${expectedReport}'
      return 1
    fi
    return 98
  }`
  for (const name of [
    'Run arm64 protocol smoke before publication',
    'Check negative worker output before publication',
  ]) {
    const step = stepSource(source, name)
    const script = step.match(/run: \|\n([\s\S]*)/)?.[1]
    assert.ok(script, `missing shell script in ${name}`)
    const result = spawnSync('bash', ['-c', `${dockerStub}\n${script.replace(/^ {10}/gm, '')}`], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${name}: ${result.stderr || result.stdout}`)
    assert.equal(result.stdout.trim(), expectedReport)
  }
})
