#!/usr/bin/env node
// 发版前置校验:三个平台各自持有独立的 updater 签名密钥。
//
// 为什么需要这个脚本 ——
// Tauri 的 updater 公钥写在配置里、私钥在 CI secret 里,两者对不上不会有任何
// 构建期报错:包照样出、照样发,只有用户机器上的自更新会验签失败,而那时已经
// 来不及了。2026-07 就踩过一次:tauri.windows.conf.json 从 07-15 起钉了一把
// Windows 专属公钥,但三个 release job 一直共用同一个 TAURI_SIGNING_PRIVATE_KEY
// secret —— 意图只落实了一半,没有任何东西报错。
//
// 这里在发版流水线里把它变成硬失败:配置侧必须三把公钥齐全且两两不同,
// CI 侧必须三个平台各自注入自己的私钥 secret(由 workflow 的 preflight 步骤检查)。
//
// 注意:换公钥会让存量安装失去自更新能力 —— 已装的 App 只信任它出厂时内嵌的
// 那把。所以已经发过版的平台不要动公钥,只补齐 CI secret。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const PLATFORMS = ['darwin', 'windows', 'linux']

/** minisign 公钥 → 8 字节 key ID(小端),与签名文件里嵌的那个是同一个值。 */
export function keyIdFromPubkey(pubkey) {
  const text = Buffer.from(String(pubkey || ''), 'base64').toString('utf8')
  const line = text.split('\n').find(row => row && !row.startsWith('untrusted comment:'))
  if (!line) throw new Error('公钥格式无法解析:找不到 base64 正文行')
  const blob = Buffer.from(line, 'base64')
  if (blob.length < 10) throw new Error('公钥格式无法解析:正文过短')
  if (blob.length !== 42 || blob.subarray(0, 2).toString('ascii') !== 'Ed') {
    throw new Error('公钥格式无法解析:必须为 42 字节 Ed25519 公钥正文')
  }
  return blob.subarray(2, 10).readBigUInt64LE(0).toString(16).toUpperCase().padStart(16, '0')
}

function pubkeyOf(conf) {
  return conf?.plugins?.updater?.pubkey || ''
}

/**
 * 解析每个平台实际生效的公钥。
 * Tauri v2 会把 tauri.<platform>.conf.json 合并到 base 之上,所以平台配置没写
 * pubkey 时继承的是 base(= macOS 用的那把)—— 这正是要检出来的情况。
 */
export function resolveUpdaterPubkeys({ base, windows, linux }) {
  const basePubkey = pubkeyOf(base)
  return {
    darwin: { pubkey: basePubkey, source: 'tauri.conf.json' },
    windows: pubkeyOf(windows)
      ? { pubkey: pubkeyOf(windows), source: 'tauri.windows.conf.json' }
      : { pubkey: basePubkey, source: 'tauri.conf.json(继承)' },
    linux: pubkeyOf(linux)
      ? { pubkey: pubkeyOf(linux), source: 'tauri.linux.conf.json' }
      : { pubkey: basePubkey, source: 'tauri.conf.json(继承)' },
  }
}

/**
 * 返回问题列表(空数组 = 通过)。不抛异常,便于测试与 CLI 分别决定怎么呈现。
 */
export function findSigningKeyProblems(resolved, platforms = PLATFORMS) {
  const problems = []
  const seen = new Map()

  for (const platform of platforms) {
    const entry = resolved[platform]
    if (!entry || !entry.pubkey) {
      problems.push(`${platform}: 没有配置 updater 公钥`)
      continue
    }
    let keyId
    try {
      keyId = keyIdFromPubkey(entry.pubkey)
    } catch (error) {
      problems.push(`${platform}: 公钥无法解析(${error.message})`)
      continue
    }
    const owner = seen.get(keyId)
    if (owner) {
      problems.push(
        `${platform} 与 ${owner} 共用同一把公钥 ${keyId}` +
        `(${platform} 取自 ${entry.source})——三个平台必须各自独立`,
      )
    } else {
      seen.set(keyId, platform)
    }
  }
  return problems
}

function configuredVersion(config) {
  return String(config?.version || '').trim().replace(/^v/i, '')
}

/**
 * Tauri 会把 tauri.<platform>.conf.json 合并到基础配置上。平台文件通常不应
 * 再写 version；一旦写了不同版本，安装包文件名和内嵌版本都会偏离发版版本。
 */
export function findPlatformVersionProblems(configs, platforms = PLATFORMS) {
  const baseVersion = configuredVersion(configs.base)
  const problems = []
  if (!baseVersion) {
    problems.push('tauri.conf.json: 没有配置发布版本')
    return problems
  }

  const configByPlatform = { windows: configs.windows, linux: configs.linux }
  for (const platform of platforms) {
    if (platform === 'darwin') continue
    const version = configuredVersion(configByPlatform[platform])
    if (version && version !== baseVersion) {
      problems.push(
        `${platform}: tauri.${platform}.conf.json 覆盖版本 ${version}，与基础版本 ${baseVersion} 不一致`,
      )
    }
  }
  return problems
}

export function readDesktopUpdaterConfs(repoRoot) {
  const read = file => {
    const full = path.join(repoRoot, 'src-tauri', file)
    try {
      return JSON.parse(readFileSync(full, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return {}
      throw new Error(`${file} 解析失败:${error.message}`)
    }
  }
  return { base: read('tauri.conf.json'), windows: read('tauri.windows.conf.json'), linux: read('tauri.linux.conf.json') }
}

function main() {
  const repoRoot = path.resolve(import.meta.dirname, '..')
  const configs = readDesktopUpdaterConfs(repoRoot)
  const resolved = resolveUpdaterPubkeys(configs)
  const requested = process.argv.indexOf('--platforms')
  const platformArg = requested >= 0 ? String(process.argv[requested + 1] || 'all') : 'all'
  const aliases = { macos: 'darwin', darwin: 'darwin', windows: 'windows', linux: 'linux' }
  const platforms = platformArg === 'all'
    ? PLATFORMS
    : platformArg.split(',').map(value => aliases[value.trim()]).filter(Boolean)
  if (platforms.length === 0) {
    console.error(`未知平台: ${platformArg}，可选 all、macos、windows、linux`)
    process.exit(1)
  }

  for (const platform of platforms) {
    const entry = resolved[platform]
    let keyId = '(无)'
    try {
      if (entry.pubkey) keyId = keyIdFromPubkey(entry.pubkey)
    } catch {
      keyId = '(无法解析)'
    }
    console.log(`${platform.padEnd(8)} keyID=${keyId}  来源=${entry.source}`)
  }

  const problems = [
    ...findSigningKeyProblems(resolved, platforms),
    ...findPlatformVersionProblems(configs, platforms),
  ]
  if (problems.length === 0) {
    console.log('\n三个平台的 updater 公钥各自独立 ✓')
    return
  }
  console.error('\nupdater 签名密钥配置有问题:')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(
    '\n修法见 docs/desktop-release-signing.md。' +
    '\n注意:已经发过版的平台不要换公钥 —— 存量安装只信任出厂时内嵌的那把,换了就再也收不到自更新。',
  )
  process.exit(1)
}

// 仓库路径含空格时 `file://${argv[1]}` 与 import.meta.url 的转义不一致，
// 必须用 pathToFileURL 比较，否则 CLI 会静默不执行。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
