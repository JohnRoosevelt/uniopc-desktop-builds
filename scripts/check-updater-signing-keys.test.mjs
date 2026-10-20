import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findPlatformVersionProblems,
  findSigningKeyProblems,
  keyIdFromPubkey,
  readDesktopUpdaterConfs,
  resolveUpdaterPubkeys,
} from './check-updater-signing-keys.mjs'

// 真实公钥,取自仓库历史 —— 用它们做夹具，顺带钉住 key ID 的解析口径
// （和 minisign 签名文件里嵌的那 8 字节是同一个值）。
const MAC_PUBKEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDdGQjc1NkNENzI0MENDRTkKUldUcHpFQnl6VmEzZng0dUFFeUo1QlZUUFdFUEZVM0RXNnFVcjlYVlVCcVJ2VFJZYmlDRnhXYVkK'
const WINDOWS_PUBKEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDRDNDE2OTg5REVFQzE1QUEKUldTcUZlemVpV2xCVE5jRGdpTjg5QktuZUhROVJjZmdxQ3FkMVZrZ0h6eUNDQy9pNlNzaDg0SE4K'

function conf(pubkey) {
  return pubkey ? { plugins: { updater: { pubkey } } } : {}
}

test('key ID 从公钥解出来，与 minisign 注释里声称的一致', () => {
  assert.equal(keyIdFromPubkey(MAC_PUBKEY), '7FB756CD7240CCE9')
  assert.equal(keyIdFromPubkey(WINDOWS_PUBKEY), '4C416989DEEC15AA')
})

test('重复编码的公钥和未知算法不能被误识别为有效 key ID', () => {
  const doubleEncoded = Buffer.from(MAC_PUBKEY).toString('base64')
  assert.throws(() => keyIdFromPubkey(doubleEncoded), /42 字节 Ed25519/)
  const lines = Buffer.from(MAC_PUBKEY, 'base64').toString().split('\n')
  const body = Buffer.from(lines[1], 'base64')
  body.write('XX', 0)
  lines[1] = body.toString('base64')
  assert.throws(() => keyIdFromPubkey(Buffer.from(lines.join('\n')).toString('base64')), /42 字节 Ed25519/)
})

test('平台配置没写 pubkey 时继承 base，并标明来源', () => {
  const resolved = resolveUpdaterPubkeys({
    base: conf(MAC_PUBKEY),
    windows: conf(WINDOWS_PUBKEY),
    linux: conf(''),
  })
  assert.equal(resolved.darwin.pubkey, MAC_PUBKEY)
  assert.equal(resolved.windows.pubkey, WINDOWS_PUBKEY)
  // Linux 没有自己的 pubkey —— 静默继承 macOS 那把，正是要报出来的情况。
  assert.equal(resolved.linux.pubkey, MAC_PUBKEY)
  assert.match(resolved.linux.source, /继承/)
})

test('继承导致两个平台共用一把公钥时报错，并点名是哪两个平台', () => {
  const problems = findSigningKeyProblems(resolveUpdaterPubkeys({
    base: conf(MAC_PUBKEY),
    windows: conf(WINDOWS_PUBKEY),
    linux: conf(''),
  }))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /linux 与 darwin 共用同一把公钥 7FB756CD7240CCE9/)
})

test('三把互不相同才算通过', () => {
  // 第三把只需与前两把不同即可,内容用 mac 那把改一个字节派生。
  const thirdRaw = Buffer.from(MAC_PUBKEY, 'base64').toString('utf8')
  const lines = thirdRaw.split('\n')
  const body = Buffer.from(lines[1], 'base64')
  body[2] ^= 0xff
  lines[1] = body.toString('base64')
  const LINUX_PUBKEY = Buffer.from(lines.join('\n'), 'utf8').toString('base64')

  const problems = findSigningKeyProblems(resolveUpdaterPubkeys({
    base: conf(MAC_PUBKEY),
    windows: conf(WINDOWS_PUBKEY),
    linux: conf(LINUX_PUBKEY),
  }))
  assert.deepEqual(problems, [])
})

test('Windows 平台配置不能覆盖基础发布版本', () => {
  const problems = findPlatformVersionProblems(
    {
      base: { version: '0.3.8' },
      windows: { version: '0.2.6' },
      linux: {},
    },
    ['darwin', 'windows'],
  )

  assert.deepEqual(problems, ['windows: tauri.windows.conf.json 覆盖版本 0.2.6，与基础版本 0.3.8 不一致'])
})

test('缺公钥和公钥无法解析都要报出来', () => {
  const missing = findSigningKeyProblems(resolveUpdaterPubkeys({
    base: conf(''),
    windows: conf(WINDOWS_PUBKEY),
    linux: conf(''),
  }))
  assert.ok(missing.some(problem => problem.startsWith('darwin: 没有配置')))
  assert.ok(missing.some(problem => problem.startsWith('linux: 没有配置')))

  // 正文行短到装不下 alg+keyID：截断/复制粘贴少一截的公钥就是这个样子。
  const truncated = Buffer.from('untrusted comment: minisign public key: X\nRWQ=\n', 'utf8').toString('base64')
  const broken = findSigningKeyProblems({
    darwin: { pubkey: truncated, source: 'x' },
    windows: { pubkey: WINDOWS_PUBKEY, source: 'y' },
    linux: { pubkey: MAC_PUBKEY, source: 'z' },
  })
  assert.ok(broken.some(problem => problem.startsWith('darwin: 公钥无法解析')))
})

test('仓库三个平台的实际 updater 公钥必须互不相同', () => {
  const configs = readDesktopUpdaterConfs(process.cwd())
  assert.deepEqual(
    findSigningKeyProblems(resolveUpdaterPubkeys(configs)),
    [],
  )
})
