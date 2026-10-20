import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(import.meta.dirname, 'LocalAssistantLaunch.jsx'), 'utf8')

test('local assistant launch is a dedicated light entry surface', () => {
  assert.equal(source.includes("import BootSplash from '../components/BootSplash'"), false)
  assert.equal(source.includes('准备就绪后，即刻开始工作'), true)
  assert.equal(source.includes('首次启动需要准备运行组件与内置能力'), true)
  assert.equal(source.includes('本地助手启动进度'), true)
  assert.equal(source.includes('启动进度'), true)
  assert.equal(source.includes('无需操作，将自动继续'), true)
  assert.equal(source.includes('查看诊断'), true)
})
