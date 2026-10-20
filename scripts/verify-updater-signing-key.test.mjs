import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { keyIdFromSignature, verifyUpdaterSigningKey } from './verify-updater-signing-key.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { keyIdFromPubkey, readDesktopUpdaterConfs, resolveUpdaterPubkeys } from './check-updater-signing-keys.mjs'

test('signature key ID is compared with the configured public key', () => {
  const expected = keyIdFromPubkey(resolveUpdaterPubkeys(readDesktopUpdaterConfs(process.cwd())).darwin.pubkey)
  const bytes = Buffer.alloc(74)
  bytes.write('Ed', 0)
  bytes.writeBigUInt64LE(BigInt(`0x${expected}`), 2)
  const signature = Buffer.from(`untrusted comment: signature from tauri secret key\n${bytes.toString('base64')}\n`).toString('base64')
  assert.equal(keyIdFromSignature(signature), expected)
})

test('malformed signature is rejected', () => {
  assert.throws(() => keyIdFromSignature(Buffer.from('untrusted comment: x\nAA==\n').toString('base64')), /过短/)
})

test('signing failures and a different private key stop the release key check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uniopc-signing-negative-'))
  try {
    const expected = Buffer.alloc(42)
    expected.write('Ed')
    expected.writeBigUInt64LE(1n, 2)
    const pubkey = Buffer.from('untrusted comment: test\n' + expected.toString('base64') + '\n').toString('base64')
    mkdirSync(join(root, 'src-tauri'))
    writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ plugins: { updater: { pubkey } } }))
    const cliDir = join(root, 'node_modules', '@tauri-apps', 'cli')
    mkdirSync(cliDir, { recursive: true })
    const cli = join(cliDir, 'tauri.js')
    await assert.rejects(() => verifyUpdaterSigningKey('darwin', { repoRoot: root, env: {} }), /缺少/)
    writeFileSync(cli, 'process.exit(1)')
    const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: 'test-placeholder' }
    await assert.rejects(() => verifyUpdaterSigningKey('darwin', { repoRoot: root, env }), /签名失败/)
    const wrong = Buffer.alloc(74)
    wrong.write('Ed')
    wrong.writeBigUInt64LE(2n, 2)
    const signature = Buffer.from('untrusted comment: test\n' + wrong.toString('base64') + '\n').toString('base64')
    writeFileSync(cli, 'require("node:fs").writeFileSync(process.argv[4]+".sig",' + JSON.stringify(signature) + ')')
    await assert.rejects(() => verifyUpdaterSigningKey('darwin', { repoRoot: root, env }), /不匹配/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('real probe signature rejects a damaged public key even when its key ID still matches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uniopc-signing-full-key-'))
  try {
    const pair = generateKeyPairSync('ed25519')
    const publicBytes = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
    const id = Buffer.alloc(8, 7)
    const keyBytes = Buffer.concat([Buffer.from('Ed'), id, publicBytes])
    const configPath = join(root, 'src-tauri', 'tauri.conf.json')
    mkdirSync(join(root, 'src-tauri'))
    const writePublic = bytes => writeFileSync(configPath, JSON.stringify({ plugins: { updater: { pubkey: Buffer.from(`untrusted comment: test\n${bytes.toString('base64')}\n`).toString('base64') } } }))
    writePublic(keyBytes)
    const cliDir = join(root, 'node_modules', '@tauri-apps', 'cli')
    mkdirSync(cliDir, { recursive: true })
    // Disposable test key only. This mock signer independently produces the
    // same prehashed Minisign envelope as Tauri; it does not call our verifier.
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
    writeFileSync(join(cliDir, 'tauri.js'), `
      const fs = require('node:fs'); const { createHash, sign } = require('node:crypto');
      const file = process.argv[4]; const key = ${JSON.stringify(privateKey)};
      const sig = sign(null, createHash('blake2b512').update(fs.readFileSync(file)).digest(), key);
      const comment = 'timestamp:1';
      const globalSig = sign(null, Buffer.concat([sig, Buffer.from(comment)]), key);
      const body = Buffer.concat([Buffer.from('ED'), Buffer.alloc(8, 7), sig]);
      const doc = ['untrusted comment: test', body.toString('base64'), 'trusted comment: ' + comment, globalSig.toString('base64')].join('\\n') + '\\n';
      fs.writeFileSync(file + '.sig', Buffer.from(doc).toString('base64'));
    `)
    const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: 'disposable-test-key' }
    assert.equal(await verifyUpdaterSigningKey('darwin', { repoRoot: root, env }), '0707070707070707')
    const damaged = Buffer.from(keyBytes)
    damaged[24] ^= 1
    writePublic(damaged)
    await assert.rejects(() => verifyUpdaterSigningKey('darwin', { repoRoot: root, env }), /完整公钥验签/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('signing is non-interactive, preserves supplied passwords and distinguishes timeouts', async () => {
  const root = process.cwd()
  for (const password of [undefined, 'test-password']) {
    await assert.rejects(() => verifyUpdaterSigningKey('windows', {
      repoRoot: root,
      env: { TAURI_SIGNING_PRIVATE_KEY: 'disposable-test-key', ...(password === undefined ? {} : { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password }) },
      spawn(command, args, options) {
        assert.equal(options.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, password ?? '')
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'])
        assert.equal(options.windowsHide, true)
        return { status: null, error: { code: 'ETIMEDOUT' } }
      },
    }), /60 秒超时/)
  }
  await assert.rejects(() => verifyUpdaterSigningKey('windows', {
    env: { TAURI_SIGNING_PRIVATE_KEY: 'disposable-test-key' },
    spawn: () => ({ status: null, error: { code: 'ENOENT' } }),
  }), /启动失败.*ENOENT/)
})
