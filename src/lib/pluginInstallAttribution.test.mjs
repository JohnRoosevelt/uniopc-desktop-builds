import test from 'node:test'
import assert from 'node:assert/strict'
import { attributeInstallFailure } from './pluginInstallAttribution.js'

test('install failure attribution maps known error classes to conclusions', () => {
  assert.equal(
    attributeInstallFailure('安装授权', new Error('plugin_not_entitled')).title,
    '当前组织没有该插件的使用权限',
  )
  assert.equal(
    attributeInstallFailure('安装到本机', new Error('插件包 sha256 校验不一致')).title,
    '安装包完整性校验失败',
  )
  assert.equal(
    attributeInstallFailure('安装授权', new Error('登录状态已过期，请重新登录后再重试插件授权。')).title,
    '登录状态已过期',
  )
  assert.equal(
    attributeInstallFailure('配置官方云凭证（自动）', new Error('invalid_host_credential')).title,
    '官方云凭证异常',
  )
  assert.equal(
    attributeInstallFailure('下载安装包', new Error('uniopc-socials 下载安装包 超时(210000ms)')).title,
    '操作超时',
  )
  assert.equal(
    attributeInstallFailure('下载安装包', new Error('TypeError: Failed to fetch')).title,
    '网络无法完成安装',
  )
})

test('install failure attribution ranks specific rules above the network bucket', () => {
  // "网络超时" hits both timeout and network — timeout (more specific) wins.
  assert.equal(attributeInstallFailure('下载安装包', new Error('网络请求超时')).title, '操作超时')
})

test('install failure attribution falls back to a generic conclusion', () => {
  const result = attributeInstallFailure('启用插件', new Error('weird engine hiccup'))
  assert.equal(result.title, '安装未完成')
  assert.equal(result.detail, 'weird engine hiccup')
  assert.ok(result.action.includes('重试'))
})
