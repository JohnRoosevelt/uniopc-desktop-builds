#!/usr/bin/env node
// Sign a disposable file with the CI secret, check its key ID and verify both
// signatures with the full bundled public key. Never print the secret.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { verifyArtifactSignature } from './desktop-release-candidate.mjs'
import { keyIdFromPubkey, readDesktopUpdaterConfs, resolveUpdaterPubkeys } from './check-updater-signing-keys.mjs'

export function keyIdFromSignature(signature) {
  const document = Buffer.from(String(signature).trim(), 'base64').toString('utf8')
  const body = document.split('\n').find(line => line && !line.startsWith('untrusted comment:'))
  if (!body) throw new Error('签名格式无效')
  const bytes = Buffer.from(body, 'base64')
  if (bytes.length < 10) throw new Error('签名正文过短')
  return bytes.subarray(2, 10).readBigUInt64LE(0).toString(16).toUpperCase().padStart(16, '0')
}

export async function verifyUpdaterSigningKey(platform, { repoRoot = path.resolve(import.meta.dirname, '..'), env = process.env, spawn = spawnSync } = {}) {
  const aliases = { macos: 'darwin', darwin: 'darwin', windows: 'windows', linux: 'linux' }
  const target = aliases[platform]
  if (!target) throw new Error(`未知平台: ${platform}`)
  if (!env.TAURI_SIGNING_PRIVATE_KEY && !env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    throw new Error('缺少 TAURI_SIGNING_PRIVATE_KEY 或 TAURI_SIGNING_PRIVATE_KEY_PATH')
  }
  const publicKey = resolveUpdaterPubkeys(readDesktopUpdaterConfs(repoRoot))[target].pubkey
  const expected = keyIdFromPubkey(publicKey)
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'uniopc-updater-key-check-'))
  try {
    const probe = path.join(tempDir, 'probe.txt')
    writeFileSync(probe, 'Uniopc updater signing key check\n')
    const signer = path.join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
    const result = spawn(process.execPath, [signer, 'signer', 'sign', probe], {
      cwd: repoRoot,
      env: { ...env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      encoding: 'utf8',
      timeout: 60_000,
    })
    if (result.error?.code === 'ETIMEDOUT') throw new Error('Tauri 签名命令超过 60 秒超时；这不是密码错误的判定')
    if (result.error) throw new Error(`Tauri 签名命令启动失败（${result.error.code || 'unknown'}）`)
    if (result.status !== 0) throw new Error(`Tauri 签名失败（exit code ${result.status ?? 'unknown'}）；子进程输出不回显凭据`)
    const signature = readFileSync(`${probe}.sig`, 'utf8')
    const actual = keyIdFromSignature(signature)
    if (actual !== expected) {
      throw new Error(`${target} updater 私钥与内置公钥不匹配：签名 key ID ${actual}，配置 key ID ${expected}`)
    }
    try {
      await verifyArtifactSignature(probe, signature, publicKey)
    } catch {
      throw new Error(`${target} updater 私钥无法通过内置完整公钥验签；Key ID 相同不代表密钥匹配`)
    }
    return actual
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const platform = process.argv[2]
    const keyId = await verifyUpdaterSigningKey(platform)
    console.log(`${platform} updater 签名密钥匹配：${keyId}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
