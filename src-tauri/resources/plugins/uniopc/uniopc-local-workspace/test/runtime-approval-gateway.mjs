import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const gatewayUrl = String(process.env.UNIOPC_APPROVAL_GATEWAY_URL || '').trim()
if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(gatewayUrl)) {
  throw new Error('runtime approval smoke requires a loopback Gateway URL')
}

const sdkPath = fileURLToPath(import.meta.resolve('openclaw/plugin-sdk/agent-harness-runtime'))
const distDir = dirname(dirname(sdkPath))
const packageRoot = dirname(distDir)
const cliPath = join(packageRoot, 'openclaw.mjs')
const approvalClientModules = readdirSync(distDir)
  .filter(name => /^operator-approvals-client-[\w-]+\.js$/.test(name))
assert.equal(approvalClientModules.length, 1, 'locked host must expose one operator approval client')
const approvalClientRuntime = await import(pathToFileURL(join(distDir, approvalClientModules[0])).href)
const withOperatorApprovalsGatewayClient = approvalClientRuntime.n
assert.equal(typeof withOperatorApprovalsGatewayClient, 'function')

function startToolInvocation(name, args, confirm) {
  const params = JSON.stringify({ name, args, sessionKey: 'main', confirm })
  const child = spawn(process.execPath, [
    cliPath,
    'gateway',
    'call',
    'tools.invoke',
    '--params',
    params,
    '--json',
    '--timeout',
    '30000',
  ], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const result = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => {
      if (code !== 0) {
        reject(new Error(`tools.invoke CLI exited ${code}: ${stderr.trim()}`))
        return
      }
      try {
        resolve(JSON.parse(stdout.trim()))
      } catch (error) {
        reject(new Error(`tools.invoke returned invalid JSON: ${stdout.trim()}`, { cause: error }))
      }
    })
  })
  return { child, result }
}

async function waitForPluginApproval(client, toolName, invocation) {
  let earlyResult
  let earlyError
  let settled = false
  invocation.result.then(
    value => { earlyResult = value; settled = true },
    error => { earlyError = error; settled = true },
  )
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const pending = await client.request('plugin.approval.list', {})
    const approval = pending.find(item => item?.request?.toolName === toolName)
    if (approval) return approval
    if (settled) {
      if (earlyError) throw earlyError
      throw new Error(`tools.invoke settled before approval: ${JSON.stringify(earlyResult)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  invocation.child.kill()
  throw new Error(`timed out waiting for approval for ${toolName}`)
}

async function invokeWithDecision(client, name, args, decision) {
  const invocation = startToolInvocation(name, args, true)
  const approval = await waitForPluginApproval(client, name, invocation)
  const resolution = await client.request('approval.resolve', {
    id: approval.id,
    kind: 'plugin',
    decision,
  })
  const output = await invocation.result
  return { approval, resolution, output }
}

const createName = 'uniopc_local_document_create'
const updateName = 'uniopc_local_document_update'
const marker = 'private-content-must-not-enter-approval-copy'
const observed = await withOperatorApprovalsGatewayClient({
  config: {},
  clientDisplayName: 'Task 4 approval continuation smoke',
}, async client => {
  const unapproved = await startToolInvocation(createName, {
    title: marker,
    category: 'other',
    markdown: `# ${marker}`,
  }, false).result
  assert.equal(unapproved.ok, false)
  assert.equal(unapproved.requiresApproval, true)

  const denied = await invokeWithDecision(client, updateName, {
    id: 'doc-seed',
    title: marker,
    category: 'other',
    markdown: `# ${marker}`,
    baseHash: 'hash-seed',
  }, 'deny')
  assert.equal(denied.resolution.applied, true)
  assert.equal(denied.output.ok, false)

  const created = await invokeWithDecision(client, createName, {
    title: '审批后创建',
    category: 'other',
    markdown: '# 审批后创建',
  }, 'allow-once')
  assert.equal(created.resolution.applied, true)
  assert.equal(created.output.ok, true)
  assert.equal(created.output.output.details.document.id, 'doc-created')

  const updated = await invokeWithDecision(client, updateName, {
    id: 'doc-created',
    title: '审批后更新',
    category: 'other',
    markdown: '# 审批后更新',
    baseHash: 'hash-created',
  }, 'allow-once')
  assert.equal(updated.resolution.applied, true)
  assert.equal(updated.output.ok, true)
  assert.equal(updated.output.output.details.document.contentHash, 'hash-updated')

  assert.deepEqual(await client.request('plugin.approval.list', {}), [])
  return {
    unapproved: { ok: unapproved.ok, requiresApproval: unapproved.requiresApproval },
    denied: { ok: denied.output.ok, decision: denied.resolution.approval.decision },
    create: { ok: created.output.ok, decision: created.resolution.approval.decision },
    update: { ok: updated.output.ok, decision: updated.resolution.approval.decision },
  }
})

assert.doesNotMatch(JSON.stringify(observed), new RegExp(marker))
process.stdout.write(`${JSON.stringify({ event: 'approval-continuation-complete', observed })}\n`)
