#!/usr/bin/env node
// Report names only. Never echo a credential, prefix, hash or length.
import { resolveDesktopReleaseSettings } from './desktop-release-settings.mjs'
import { resolve } from 'node:path'
import { loadEnvFile } from './release-desktop-updater.mjs'
const file = process.argv[2] || '.env.desktop-release.local'
try {
  const env = await loadEnvFile(resolve(file))
  resolveDesktopReleaseSettings(env)
  console.log('项目地址、存储桶、Apple 签名身份和 Team ID 自动读取项目配置，不需要添加 Actions Secrets。')
  const groups = {
    '通用构建': ['SUPABASE_STORAGE_API_KEY'],
    'macOS 构建': ['TAURI_SIGNING_PRIVATE_KEY_MACOS', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_PATH'],
    'Windows 构建': ['TAURI_SIGNING_PRIVATE_KEY_WINDOWS'],
    '正式上线': ['IMAI_RELEASE_PUBLISH_TOKEN'],
  }
  let missing = false
  for (const [group, names] of Object.entries(groups)) {
    const absent = names.filter(name => !String(env[name] || '').trim())
    console.log(`${group}: ${absent.length ? `缺少 ${absent.join(', ')}` : '本地已填写'}`)
    missing ||= absent.length > 0
  }
  console.log('这里只检查本地填写情况，不读取 GitHub Secret 的原值，也不证明凭据有效。')
  if (missing) process.exitCode = 1
} catch { console.error('Cannot read local release configuration. Copy .env.desktop-release.example to .env.desktop-release.local.'); process.exitCode = 1 }
