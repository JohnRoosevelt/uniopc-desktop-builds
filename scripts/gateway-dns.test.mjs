import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const modulePath = fileURLToPath(new URL('../src-tauri/src/services/gateway_dns.cjs', import.meta.url))
const { createLookup, parseAnswer, isFakeIp, publicHostname } = require(modulePath)
const fake = [{ address: '198.18.3.1', family: 4 }, { address: '2001:2::123', family: 6 }]
const real = [{ address: '93.184.216.34', family: 4 }]

test('recognizes only the exact IPv4 and IPv6 synthetic ranges', () => {
  for (const ip of ['198.18.0.1', '198.19.255.255', '2001:2::1', '2001:0002:0000:0000:1:2:3:4']) assert.equal(isFakeIp(ip), true, ip)
  for (const ip of ['198.17.0.1', '198.20.0.1', '2001:2:0:1::1', '127.0.0.1', '10.0.0.1', 'fd00::1', 'invalid']) assert.equal(isFakeIp(ip), false, ip)
})
test('normal public, private and literal lookups remain unchanged without DoH', async () => {
  let queries = 0
  for (const address of ['93.184.216.34', '127.0.0.1', '10.0.0.1', '169.254.169.254', '::1']) {
    const result = [{ address, family: address.includes(':') ? 6 : 4 }]
    const lookup = createLookup(async () => result, async () => { queries++; return real })
    assert.deepEqual(await lookup('host.example', { all: true }), result)
  }
  assert.equal(queries, 0)
})
test('only synthetic results use encrypted DNS, with family and all shape preserved', async () => {
  const queries = []
  const lookup = createLookup(async () => fake, async (...args) => { queries.push(args); return real })
  assert.deepEqual(await lookup('EXAMPLE.COM.', { family: 4, all: true }), real)
  assert.deepEqual(queries, [['example.com', 4]])
  assert.deepEqual(await lookup('example.com'), real[0])
})
test('mixed private and fake replies retain the private address for SSRF rejection', async () => {
  const mixed = [...fake, { address: '10.0.0.1', family: 4 }]
  const lookup = createLookup(async () => mixed, async () => { throw Error('must not query') })
  assert.deepEqual(await lookup('host.example', { all: true }), mixed)
})
test('private answers from DoH are preserved for the existing SSRF guard', async () => {
  const mixed = [{ address: '10.0.0.1', family: 4 }, ...real]
  assert.deepEqual(await createLookup(async () => fake, async () => mixed)('host.example', { all: true }), mixed)
})
test('resolver failure fails closed without returning fake addresses', async () => {
  const lookup = createLookup(async () => fake, async () => { throw Error('offline') })
  await assert.rejects(lookup('example.com'), /offline/)
  await assert.rejects(createLookup(async () => fake, async () => fake)('example.com'), { code: 'EAI_AGAIN' })
})
test('system DNS failure is not reinterpreted as a Fake-IP result', async () => {
  const lookup = createLookup(async () => { throw Object.assign(Error('NXDOMAIN'), { code: 'ENOTFOUND' }) }, async () => { throw Error('must not query') })
  await assert.rejects(lookup('missing.example'), { code: 'ENOTFOUND' })
})
test('internal names and IP literals never use external DNS', async () => {
  for (const host of ['localhost', 'a.local', 'a.internal', 'a.lan', '127.0.0.1', '198.18.0.1', '::1', 'metadata.google.internal', 'bad/host.example']) {
    assert.equal(publicHostname(host), null, host)
    await assert.rejects(createLookup(async () => fake, async () => { throw Error('must not query') })(host), { code: 'ENOTFOUND' })
  }
})
test('concurrent identical queries share work and are not persistently cached', async () => {
  let count = 0; let finish
  const lookup = createLookup(async () => fake, () => { count++; return new Promise(resolve => { finish = resolve }) })
  const a = lookup('example.com'); const b = lookup('example.com')
  await new Promise(resolve => setImmediate(resolve)); assert.equal(count, 1)
  finish(real); await Promise.all([a, b])
  const c = lookup('example.com'); await new Promise(resolve => setImmediate(resolve)); assert.equal(count, 2)
  finish(real); await c
})
test('validates DoH question, CNAME chain and record family without widening policy', () => {
  const body = { Status: 0, Question: [{ name: 'example.com', type: 1 }], Answer: [
    { name: 'example.com', type: 5, data: 'cdn.example.' },
    { name: 'cdn.example', type: 1, data: '10.0.0.1' },
    { name: 'unrelated.example', type: 1, data: '93.184.216.34' },
  ] }
  assert.deepEqual(parseAnswer(body, 'example.com', 1), [{ address: '10.0.0.1', family: 4 }])
  assert.throws(() => parseAnswer(body, 'other.example', 1))
  assert.throws(() => parseAnswer({ ...body, TC: true }, 'example.com', 1))
  assert.throws(() => parseAnswer({ ...body, Answer: [{ name: 'example.com', type: 1, data: '198.18.0.1' }] }, 'example.com', 1))
})
test('installation updates callback and named ESM lookup exports inside the selected process', () => {
  const code = `const d=require('node:dns');d.promises.lookup=async()=>[{address:'93.184.216.34',family:4}];require(${JSON.stringify(modulePath)}).install();Promise.all([import('node:dns/promises').then(m=>m.lookup('example.com',{all:true})),new Promise((r,j)=>d.lookup('example.com',(e,a,f)=>e?j(e):r({address:a,family:f})))]).then(r=>process.stdout.write(JSON.stringify(r)))`
  const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), [real, real[0]])
})
