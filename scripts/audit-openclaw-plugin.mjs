#!/usr/bin/env node

import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import {
  createHash,
  createPrivateKey,
  randomBytes,
  sign as signPayload,
  verify as verifySignature,
} from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, readFileSync } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extract as tarExtract, list as tarList } from 'tar'
import { crc32, inflateRawSync } from 'node:zlib'
import { verifyReleaseContract } from './verify-openclaw-release-contract.mjs'

const HOST_VERSION = '2026.8.1'
const INSPECTOR_VERSION = '0.3.24'
const MATRIX_FILE = 'plugin-release-matrix.json'
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'])
const SKIP_DIRECTORIES = new Set(['node_modules', 'reports', 'test', 'tests', '.git'])
const RAW_PLUGIN_ID = Symbol('rawPluginId')
const RAW_DECLARED_TOOLS = Symbol('rawDeclaredTools')
const RAW_READ_ONLY_TOOLS = Symbol('rawReadOnlyTools')
const traverse = traverseModule.default ?? traverseModule
const TRUSTED_WORKER_LOCK = JSON.parse(readFileSync(
  new URL('./openclaw-plugin-audit-worker.lock.json', import.meta.url),
  'utf8',
))
const SESSION_FILE_HELPERS = [
  'resolveSessionFilePath',
  'resolveAndPersistSessionFile',
  'resolveSessionTranscriptLegacyFileTarget',
  'appendSessionTranscriptMessage',
  'emitSessionTranscriptUpdate',
]
const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxCompressedBytes: 64 * 1024 * 1024,
  maxEntries: 2048,
  maxEntryBytes: 128 * 1024 * 1024,
  maxUnpackedBytes: 256 * 1024 * 1024,
})
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

const messages = {
  artifact_id_mismatch: '制品身份与发布清单不一致。',
  artifact_missing: '发布清单中的制品不可用。',
  artifact_path_invalid: '发布清单中的制品位置无效。',
  artifact_integrity_changed: '制品在验证过程中发生变化。',
  artifact_sha_mismatch: '制品摘要与发布清单不一致。',
  artifact_sha_missing: '发布清单缺少有效的制品摘要。',
  artifact_size_exceeded: '插件制品超过发布审计大小上限。',
  attestation_invalid: '插件审计证明无效。',
  attestation_missing: '发布缺少插件审计证明。',
  attestation_replayed: '插件审计证明已被消费。',
  broad_sdk_import: '插件仍使用临时兼容的宽泛运行时入口。',
  builder_failed: '插件构建一致性检查未通过。',
  compatibility_mismatch: '插件接口范围与发布清单不一致。',
  compatibility_missing: '插件缺少接口兼容范围。',
  compatibility_unsupported: '插件接口范围不支持当前内置服务版本。',
  dynamic_surface_unverified: '插件包含无法静态验证的动态运行时访问。',
  inspector_failed: '官方插件检查未通过。',
  inspector_version_invalid: '官方插件检查器版本不符合发布要求。',
  lifecycle_disable_failed: '插件停用清理未完成。',
  lifecycle_enable_failed: '插件启用未完成。',
  lifecycle_install_failed: '插件安装未完成。',
  lifecycle_restart_failed: '本地服务重启未完成。',
  lifecycle_uninstall_failed: '插件卸载清理未完成。',
  manifest_invalid: '插件清单无效。',
  matrix_empty: '发布清单没有可验证的制品。',
  matrix_invalid: '发布清单格式无效。',
  read_only_invoke_failed: '只读能力验证未通过。',
  read_only_tool_unverified: '发布清单选择的验证能力并非已声明的只读能力。',
  removed_memory_embedding_registration: '插件使用了已移除的记忆注册接口。',
  removed_outbound_result_field: '插件返回了已移除的旧式发送结果字段。',
  removed_root_sdk_import: '插件使用了已移除的根级开发接口入口。',
  removed_runtime_config_access: '插件直接调用了已移除的配置读写接口。',
  removed_session_file_helper: '插件使用了已移除的会话文件接口。',
  runtime_environment_missing: '发布验证缺少隔离的运行环境。',
  runtime_registration_unverified: '运行时未验证到清单要求的能力。',
  runtime_version_mismatch: '内置服务版本与发布要求不一致。',
  sandbox_unavailable: '当前环境缺少强制插件隔离能力。',
  validator_failed: '插件清单验证未通过。',
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  throw new TypeError('non-canonical value')
}

function finding(code, artifactId) {
  return {
    code,
    ...(artifactId ? { artifactId } : {}),
    message: messages[code],
  }
}

function sortFindings(values) {
  return values.sort((left, right) =>
    left.code.localeCompare(right.code) || String(left.artifactId || '').localeCompare(String(right.artifactId || '')))
}

function publicIdentifier(value, fallback = null) {
  const normalized = String(value || '').trim().replace(/openclaw/ig, 'runtime')
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized) ? normalized : fallback
}

function publicRequirement(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ')
  return normalized.length <= 128 && /^[0-9.^~<>= ]+$/.test(normalized) ? normalized : null
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function listSourceFiles(root) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await visit(join(directory, entry.name))
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(join(directory, entry.name))
      }
    }
  }
  await visit(root)
  return files.sort()
}

function staticString(node) {
  if (node?.type === 'StringLiteral') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? node.quasis[0]?.value?.raw ?? null
  }
  return null
}

function staticStringFromPath(path) {
  const direct = staticString(path?.node)
  if (direct !== null) return direct
  try {
    const evaluated = path?.evaluate?.()
    return evaluated?.confident && typeof evaluated.value === 'string' ? evaluated.value : null
  } catch {
    return null
  }
}

function memberName(path) {
  if (!path?.node?.computed && path?.node?.property?.type === 'Identifier') return path.node.property.name
  return staticStringFromPath(path?.get('property'))
}

function recordPatternOrigins(patternPath, origin, origins) {
  if (!patternPath?.node || !origin) return
  if (patternPath.isIdentifier()) {
    const binding = patternPath.scope.getBinding(patternPath.node.name)
    if (binding) origins.set(binding, origin)
    return
  }
  if (patternPath.isAssignmentPattern()) {
    recordPatternOrigins(patternPath.get('left'), origin, origins)
    return
  }
  if (patternPath.isRestElement()) {
    recordPatternOrigins(patternPath.get('argument'), origin, origins)
    return
  }
  if (!patternPath.isObjectPattern()) return
  for (const propertyPath of patternPath.get('properties')) {
    if (!propertyPath.isObjectProperty()) continue
    const name = propertyPath.node.computed
      ? staticStringFromPath(propertyPath.get('key'))
      : propertyPath.node.key?.name ?? staticString(propertyPath.node.key)
    if (name) recordPatternOrigins(propertyPath.get('value'), [...origin, name], origins)
  }
}

function expressionOrigin(path, origins) {
  if (!path?.node) return null
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name)
    return binding ? origins.get(binding) || null : null
  }
  if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
    const object = expressionOrigin(path.get('object'), origins)
    const property = memberName(path)
    return object && property ? [...object, property] : null
  }
  return null
}

function returnedObjectExpression(argumentPath) {
  if (argumentPath?.isObjectExpression()) return argumentPath
  if (!argumentPath?.isIdentifier()) return null
  const binding = argumentPath.scope.getBinding(argumentPath.node.name)
  const declarator = binding?.path?.isVariableDeclarator()
    ? binding.path
    : binding?.path?.findParent((path) => path.isVariableDeclarator())
  const init = declarator?.get('init')
  return init?.isObjectExpression() ? init : null
}

function isRegisterFunction(path) {
  if (path.isFunctionDeclaration() && path.node.id?.name === 'register') return true
  if (path.isObjectMethod()) {
    return path.node.computed
      ? staticStringFromPath(path.get('key')) === 'register'
      : path.node.key?.name === 'register' || staticString(path.node.key) === 'register'
  }
  const parent = path.parentPath
  if (parent?.isVariableDeclarator() && parent.get('id').isIdentifier({ name: 'register' })) return true
  if (parent?.isObjectProperty()) {
    return parent.node.computed
      ? staticStringFromPath(parent.get('key')) === 'register'
      : parent.node.key?.name === 'register' || staticString(parent.node.key) === 'register'
  }
  return false
}

function functionPathFromBinding(binding) {
  const bindingPath = binding?.path
  if (!bindingPath) return null
  if (bindingPath.isFunctionDeclaration()) return bindingPath
  const declarator = bindingPath.isVariableDeclarator()
    ? bindingPath
    : bindingPath.findParent((path) => path.isVariableDeclarator())
  const init = declarator?.get('init')
  return init?.isFunction() ? init : null
}

function identifierBinding(path) {
  if (path?.isIdentifier()) return path.scope.getBinding(path.node.name) || null
  if (path?.isAssignmentPattern()) return identifierBinding(path.get('left'))
  if (path?.isRestElement()) return identifierBinding(path.get('argument'))
  return null
}

function collectRegisterFunctions(ast) {
  const registerFunctions = new Map()
  const visitedExpressions = new Set()
  let uncertainForwarding = false

  const addRegisterFunction = (path, parameterIndex = 0) => {
    if (!path?.node || !Number.isInteger(parameterIndex) || parameterIndex < 0) return false
    const indexes = registerFunctions.get(path) || new Set()
    if (indexes.has(parameterIndex)) return false
    indexes.add(parameterIndex)
    registerFunctions.set(path, indexes)
    return true
  }

  const addExpression = (path) => {
    if (!path?.node || visitedExpressions.has(path.node)) return
    visitedExpressions.add(path.node)
    if (path.isFunction()) {
      addRegisterFunction(path)
      return
    }
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name)
      const functionPath = functionPathFromBinding(binding)
      if (functionPath) {
        addRegisterFunction(functionPath)
        return
      }
      const declarator = binding?.path?.isVariableDeclarator()
        ? binding.path
        : binding?.path?.findParent((candidate) => candidate.isVariableDeclarator())
      if (declarator) addExpression(declarator.get('init'))
      return
    }
    if (path.isCallExpression() || path.isOptionalCallExpression()) {
      for (const argument of path.get('arguments')) {
        addExpression(argument.isSpreadElement() ? argument.get('argument') : argument)
      }
      const callee = path.get('callee')
      if (callee.isIdentifier()) {
        const functionPath = functionPathFromBinding(callee.scope.getBinding(callee.node.name))
        if (functionPath) {
          if (functionPath.get('body').isBlockStatement()) {
            functionPath.traverse({
              ReturnStatement(returnPath) {
                addExpression(returnPath.get('argument'))
              },
            })
          } else {
            addExpression(functionPath.get('body'))
          }
        }
      }
      return
    }
    if (path.isObjectExpression()) {
      for (const property of path.get('properties')) {
        if (!property.isObjectProperty() && !property.isObjectMethod()) continue
        const name = property.node.computed
          ? staticStringFromPath(property.get('key'))
          : property.node.key?.name ?? staticString(property.node.key)
        if (name !== 'register') continue
        if (property.isObjectMethod()) addRegisterFunction(property)
        else addExpression(property.get('value'))
      }
    }
  }

  traverse(ast, {
    enter(path) {
      if (path.isFunction() && isRegisterFunction(path)) addRegisterFunction(path)
      if (path.isReturnStatement()) addExpression(path.get('argument'))
      if (path.isArrowFunctionExpression() && path.get('body').isObjectExpression()) {
        addExpression(path.get('body'))
      }
      if (path.isExportDefaultDeclaration()) addExpression(path.get('declaration'))
      if (path.isExportNamedDeclaration()) {
        const declaration = path.get('declaration')
        if (declaration?.isVariableDeclaration()) {
          for (const declarator of declaration.get('declarations')) addExpression(declarator.get('init'))
        }
        for (const specifier of path.get('specifiers')) {
          if (!specifier.isExportSpecifier()) continue
          const exported = specifier.node.exported?.name ?? staticString(specifier.node.exported)
          if (['register', 'plugin', 'default'].includes(exported)) addExpression(specifier.get('local'))
        }
      }
    },
  })

  const pending = []
  for (const [path, indexes] of registerFunctions) {
    for (const parameterIndex of indexes) pending.push({ path, parameterIndex })
  }
  for (let index = 0; index < pending.length; index += 1) {
    const { path: registerPath, parameterIndex } = pending[index]
    const parameterPath = registerPath.get('params')[parameterIndex]
    const parameterBinding = identifierBinding(parameterPath)
    const parameterIsRest = parameterPath?.isRestElement()
    if (!parameterBinding) continue
    registerPath.traverse({
      Function(path) {
        path.skip()
      },
      CallExpression(path) {
        if (path.getFunctionParent() !== registerPath) return
        const callee = path.get('callee')
        if (!callee.isIdentifier()) return
        const target = functionPathFromBinding(callee.scope.getBinding(callee.node.name))
        if (!target) return
        const targetParameters = target.get('params')
        const restIndex = targetParameters.findIndex((parameter) => parameter.isRestElement())
        const markTarget = (targetIndex) => {
          if (targetIndex < 0 || (restIndex < 0 && targetIndex >= targetParameters.length)) return
          const mappedIndex = restIndex >= 0 && targetIndex >= restIndex ? restIndex : targetIndex
          if (restIndex >= 0 && targetIndex >= restIndex) uncertainForwarding = true
          if (addRegisterFunction(target, mappedIndex)) pending.push({ path: target, parameterIndex: mappedIndex })
        }
        const markUncertainRange = (firstIndex) => {
          for (let targetIndex = firstIndex; targetIndex < targetParameters.length; targetIndex += 1) {
            markTarget(targetIndex)
          }
        }
        let firstSpreadIndex = -1
        for (const [argumentIndex, argument] of path.get('arguments').entries()) {
          if (argument.isSpreadElement()) {
            if (firstSpreadIndex < 0) firstSpreadIndex = argumentIndex
            if (identifierBinding(argument.get('argument')) === parameterBinding) {
              if (parameterIsRest && firstSpreadIndex === argumentIndex) {
                markTarget(argumentIndex)
              } else {
                uncertainForwarding = true
                markUncertainRange(firstSpreadIndex)
              }
            }
            continue
          }
          if (identifierBinding(argument) !== parameterBinding) continue
          if (firstSpreadIndex >= 0 && firstSpreadIndex < argumentIndex) {
            uncertainForwarding = true
            markUncertainRange(firstSpreadIndex)
          } else {
            markTarget(argumentIndex)
          }
        }
      },
    })
  }
  return { parameterIndexes: registerFunctions, uncertainForwarding }
}

function inspectOutboundObject(objectPath, errors) {
  if (!objectPath?.isObjectExpression()) return
  for (const propertyPath of objectPath.get('properties')) {
    if (!propertyPath.isObjectProperty() && !propertyPath.isObjectMethod()) continue
    const name = propertyPath.node.computed
      ? staticStringFromPath(propertyPath.get('key'))
      : propertyPath.node.key?.name ?? staticString(propertyPath.node.key)
    if (['chatId', 'channelId', 'roomId', 'conversationId'].includes(name)) {
      errors.add('removed_outbound_result_field')
    }
  }
}

function scanSource(source) {
  const errors = new Set()
  const warnings = new Set()
  const origins = new Map()
  let ast
  try {
    ast = parse(source, {
      sourceType: 'unambiguous',
      plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes', 'topLevelAwait'],
    })
  } catch {
    errors.add('manifest_invalid')
    return { errors, warnings }
  }

  const inspectModuleSpecifier = (specifierPath, { dynamic = false } = {}) => {
    const specifier = staticStringFromPath(specifierPath)
    if (dynamic && specifier === null) errors.add('dynamic_surface_unverified')
    if (specifier === 'openclaw/plugin-sdk') errors.add('removed_root_sdk_import')
    if (specifier === 'openclaw/plugin-sdk/runtime') warnings.add('broad_sdk_import')
  }

  const registerOrigins = collectRegisterFunctions(ast)
  if (registerOrigins.uncertainForwarding) errors.add('dynamic_surface_unverified')

  traverse(ast, {
    enter(path) {
      if (
        path.isImportDeclaration()
        || path.isExportNamedDeclaration()
        || path.isExportAllDeclaration()
      ) {
        inspectModuleSpecifier(path.get('source'))
      }

      if (path.isFunction() && registerOrigins.parameterIndexes.has(path)) {
        for (const parameterIndex of registerOrigins.parameterIndexes.get(path)) {
          recordPatternOrigins(path.get('params')[parameterIndex], ['api'], origins)
        }
      }

      if (path.isVariableDeclarator()) {
        recordPatternOrigins(path.get('id'), expressionOrigin(path.get('init'), origins), origins)
      } else if (path.isAssignmentExpression() && path.node.operator === '=') {
        recordPatternOrigins(path.get('left'), expressionOrigin(path.get('right'), origins), origins)
      }

      if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
        const objectOrigin = expressionOrigin(path.get('object'), origins)
        if (
          objectOrigin
          && memberName(path) === null
          && (objectOrigin[0] === 'api' || objectOrigin.includes('runtime') || objectOrigin.includes('session'))
        ) errors.add('dynamic_surface_unverified')
      }

      if (path.isCallExpression() || path.isOptionalCallExpression()) {
        const callee = path.get('callee')
        if (callee.node?.type === 'Import') {
          inspectModuleSpecifier(path.get('arguments')[0], { dynamic: true })
        } else if (callee.isIdentifier({ name: 'require' }) && !callee.scope.getBinding('require')) {
          inspectModuleSpecifier(path.get('arguments')[0], { dynamic: true })
        }

        const origin = expressionOrigin(callee, origins)
        if (!origin) return
        const tail = origin.slice(-3).join('.')
        if (tail === 'runtime.config.loadConfig' || tail === 'runtime.config.writeConfigFile') {
          errors.add('removed_runtime_config_access')
        }
        if (origin.includes('session') && SESSION_FILE_HELPERS.includes(origin.at(-1))) {
          errors.add('removed_session_file_helper')
        }
        if (origin[0] === 'api' && origin.at(-1) === 'registerMemoryEmbeddingProvider') {
          errors.add('removed_memory_embedding_registration')
        }
      }

      if (path.isImportExpression?.()) inspectModuleSpecifier(path.get('source'), { dynamic: true })

      if (path.isReturnStatement()) {
        const objectPath = returnedObjectExpression(path.get('argument'))
        inspectOutboundObject(objectPath, errors)
      }

      if (path.isArrowFunctionExpression() && !path.get('body').isBlockStatement()) {
        inspectOutboundObject(returnedObjectExpression(path.get('body')), errors)
      }
    },
  })
  return { errors, warnings }
}

function versionTuple(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || '').trim())
  return match ? match.slice(1).map(Number) : null
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

function requirementSupportsHost(requirement, hostVersion = HOST_VERSION) {
  const host = versionTuple(hostVersion)
  const raw = String(requirement || '').trim()
  if (!host || !raw || raw.includes('||') || raw.includes(',')) return false
  const tokens = raw.split(/\s+/)
  return tokens.every((token) => {
    const match = /^(>=|<=|>|<|=|\^|~)?(\d+\.\d+\.\d+)$/.exec(token)
    if (!match) return false
    const operator = match[1] || '='
    const expected = versionTuple(match[2])
    const compared = compareVersions(host, expected)
    if (operator === '>=') return compared >= 0
    if (operator === '<=') return compared <= 0
    if (operator === '>') return compared > 0
    if (operator === '<') return compared < 0
    if (operator === '=') return compared === 0
    if (operator === '^') return compared >= 0 && host[0] === expected[0]
    return compared >= 0 && host[0] === expected[0] && host[1] === expected[1]
  })
}

async function pluginManifestPath(root) {
  const branded = join(root, 'uniopc.plugin.json')
  return await pathExists(branded) ? branded : join(root, 'openclaw.plugin.json')
}

export async function auditPluginDirectory(pluginRoot, { hostVersion = HOST_VERSION } = {}) {
  const errors = []
  const warnings = []
  let packageJson
  let manifest
  try {
    [packageJson, manifest] = await Promise.all([
      readJson(join(pluginRoot, 'package.json')),
      pluginManifestPath(pluginRoot).then(readJson),
    ])
  } catch {
    errors.push(finding('manifest_invalid'))
    return {
      ok: false,
      errors,
      warnings,
      compatibility: { hostVersion, pluginApi: null, minHostVersion: null, compatible: false },
      capabilities: { declared: [], readOnlyDeclared: [], runtimeRegistered: [], runtimeVerified: false },
    }
  }

  const pluginApi = typeof packageJson?.openclaw?.compat?.pluginApi === 'string'
    ? packageJson.openclaw.compat.pluginApi.trim()
    : ''
  const minHostVersion = typeof packageJson?.openclaw?.install?.minHostVersion === 'string'
    ? packageJson.openclaw.install.minHostVersion.trim()
    : ''
  if (!pluginApi || !minHostVersion) {
    errors.push(finding('compatibility_missing'))
  } else if (
    !requirementSupportsHost(pluginApi, hostVersion)
    || !requirementSupportsHost(minHostVersion, hostVersion)
  ) {
    errors.push(finding('compatibility_unsupported'))
  }

  const sourceErrors = new Set()
  const sourceWarnings = new Set()
  for (const path of await listSourceFiles(pluginRoot)) {
    const scanned = scanSource(await readFile(path, 'utf8'))
    for (const code of scanned.errors) sourceErrors.add(code)
    for (const code of scanned.warnings) sourceWarnings.add(code)
  }
  for (const code of sourceErrors) errors.push(finding(code))
  for (const code of sourceWarnings) warnings.push(finding(code))

  sortFindings(errors)
  sortFindings(warnings)
  const rawDeclared = Array.isArray(manifest?.contracts?.tools)
    ? manifest.contracts.tools.filter((value) => typeof value === 'string').sort()
    : []
  const rawReadOnlyDeclared = rawDeclared.filter((name) => manifest?.toolMetadata?.[name]?.sideEffecting === false)
  const declared = rawDeclared.map((name) => publicIdentifier(name, 'runtime-capability')).sort()
  const readOnlyDeclared = rawReadOnlyDeclared.map((name) => publicIdentifier(name, 'runtime-capability')).sort()
  const publicPluginApi = publicRequirement(pluginApi)
  const pluginId = typeof manifest?.id === 'string' ? manifest.id : ''
  const report = {
    ok: errors.length === 0,
    errors,
    warnings,
    compatibility: {
      hostVersion,
      pluginApi: publicPluginApi,
      minHostVersion: publicRequirement(minHostVersion),
      compatible: Boolean(pluginApi)
        && Boolean(minHostVersion)
        && requirementSupportsHost(pluginApi, hostVersion)
        && requirementSupportsHost(minHostVersion, hostVersion),
    },
    capabilities: { declared, readOnlyDeclared, runtimeRegistered: [], runtimeVerified: false },
    plugin: {
      id: publicIdentifier(pluginId, pluginId ? 'runtime-plugin' : null),
      entry: Array.isArray(packageJson?.openclaw?.extensions)
        ? packageJson.openclaw.extensions.find((value) => typeof value === 'string') || null
        : null,
    },
  }
  report[RAW_PLUGIN_ID] = pluginId
  report[RAW_DECLARED_TOOLS] = rawDeclared
  report[RAW_READ_ONLY_TOOLS] = rawReadOnlyDeclared
  return report
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function artifactError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

async function pathContainsSymlink(path) {
  const absolute = resolve(path)
  const parsed = parsePath(absolute)
  let current = parsed.root
  for (const segment of absolute.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment)
    const metadata = await lstat(current).catch(() => null)
    if (!metadata) return true
    if (metadata.isSymbolicLink()) return true
  }
  return false
}

export async function snapshotRegularFile(path, {
  outputDirectory,
  maxBytes = MAX_ARTIFACT_BYTES,
  hooks = {},
} = {}) {
  if (await pathContainsSymlink(path)) throw artifactError('artifact_path_invalid')
  const initial = await lstat(path).catch(() => null)
  if (!initial || initial.isSymbolicLink() || !initial.isFile()) throw artifactError('artifact_path_invalid')
  if (initial.size > maxBytes) throw artifactError('artifact_size_exceeded')
  await hooks.beforeOpen?.()
  const source = await open(path, 'r').catch(() => null)
  if (!source) throw artifactError('artifact_integrity_changed')
  let output = null
  let temporaryPath = null
  try {
    const before = await source.stat()
    if (!before.isFile() || !sameFileIdentity(initial, before) || before.size !== initial.size) {
      throw artifactError('artifact_integrity_changed')
    }
    const destinationRoot = resolve(outputDirectory || await mkdtemp(join(tmpdir(), 'uniopc-file-snapshot-')))
    await mkdir(destinationRoot, { recursive: true })
    await chmod(destinationRoot, 0o700).catch(() => {})
    temporaryPath = join(destinationRoot, `.snapshot-${randomBytes(16).toString('hex')}`)
    output = await open(temporaryPath, 'wx', 0o600)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let total = 0
    let firstChunk = true
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) throw artifactError('artifact_size_exceeded')
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.length) {
        const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset)
        offset += bytesWritten
      }
      if (firstChunk) {
        firstChunk = false
        await hooks.afterFirstChunk?.()
      }
    }
    const after = await source.stat()
    const current = await lstat(path).catch(() => null)
    if (
      total !== before.size
      || after.size !== before.size
      || !sameFileIdentity(before, after)
      || !current
      || current.isSymbolicLink()
      || !sameFileIdentity(initial, current)
      || current.size !== initial.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) throw artifactError('artifact_integrity_changed')
    await output.sync()
    await output.close()
    output = null
    const sha256 = hash.digest('hex')
    const finalPath = join(destinationRoot, `${sha256}${extname(path) || '.bin'}`)
    await rename(temporaryPath, finalPath)
    temporaryPath = null
    await chmod(finalPath, 0o400).catch(() => {})
    return {
      path: finalPath,
      sha256,
      sizeBytes: total,
      async verify() {
        if (await pathContainsSymlink(finalPath)) return false
        const metadata = await lstat(finalPath).catch(() => null)
        if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size !== total) return false
        try {
          const verified = await streamArtifact(finalPath, { maxBytes })
          return verified.bytes === total && verified.sha256 === sha256
        } catch {
          return false
        }
      },
    }
  } finally {
    await output?.close().catch(() => {})
    await source.close().catch(() => {})
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

export async function sealContainerInputTree(root) {
  const absoluteRoot = resolve(root)
  if (await pathContainsSymlink(absoluteRoot)) throw artifactError('artifact_path_invalid')
  async function seal(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const candidate = join(directory, entry.name)
      const metadata = await lstat(candidate)
      if (metadata.isSymbolicLink()) throw artifactError('artifact_path_invalid')
      if (metadata.isDirectory()) {
        await seal(candidate)
      } else if (metadata.isFile()) {
        await chmod(candidate, 0o444)
      } else {
        throw artifactError('artifact_path_invalid')
      }
    }
    await chmod(directory, 0o555)
  }
  await seal(absoluteRoot)
}

export async function removeSealedContainerInputTree(root) {
  const absoluteRoot = resolve(root)
  async function makeDirectoriesRemovable(directory) {
    const metadata = await lstat(directory).catch(() => null)
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) return
    await chmod(directory, 0o700).catch(() => {})
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await makeDirectoriesRemovable(join(directory, entry.name))
      }
    }
  }
  await makeDirectoriesRemovable(absoluteRoot)
  await rm(absoluteRoot, { recursive: true, force: true })
}

async function streamArtifact(path, { outputPath = null, maxBytes = MAX_ARTIFACT_BYTES } = {}) {
  const source = await open(path, 'r')
  let output = null
  try {
    const before = await source.stat()
    if (!before.isFile() || before.size > maxBytes) throw artifactError('artifact_size_exceeded')
    if (outputPath) output = await open(outputPath, 'wx', 0o600)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let total = 0
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) throw artifactError('artifact_size_exceeded')
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      if (output) {
        let offset = 0
        while (offset < chunk.length) {
          const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset)
          offset += bytesWritten
        }
      }
    }
    const after = await source.stat()
    if (
      total !== before.size
      || after.size !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
    ) throw artifactError('artifact_integrity_changed')
    await output?.sync()
    return { bytes: total, sha256: hash.digest('hex') }
  } finally {
    await output?.close().catch(() => {})
    await source.close().catch(() => {})
  }
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function rawRunCommand({ command, args, cwd, env, onSpawn }) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    onSpawn?.(child.pid)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', () => resolveResult({ code: 1, stdout: '', stderr: '', pid: child.pid }))
    child.on('exit', (code) => resolveResult({ code: code ?? 1, stdout, stderr, pid: child.pid }))
  })
}

async function defaultRunCommand(options) {
  if (!options.trackDescendants) return rawRunCommand(options)
  const ownedPids = new Set()
  let rootPid = null
  let running = true
  const polling = (async () => {
    while (running) {
      if (rootPid) for (const pid of await listProcessTree(rootPid, options.env)) ownedPids.add(pid)
      if (running) await delay(50)
    }
  })()
  const result = await rawRunCommand({
    ...options,
    onSpawn(pid) {
      rootPid = pid
      if (Number.isInteger(pid)) ownedPids.add(pid)
    },
  })
  if (rootPid) for (const pid of await listProcessTree(rootPid, options.env)) ownedPids.add(pid)
  running = false
  await polling
  const descendants = [...ownedPids].filter((pid) => pid !== rootPid)
  let cleaned = true
  if (descendants.length) {
    await terminateProcessTree(descendants, options.env)
    cleaned = descendants.every((pid) => !processExists(pid))
  }
  return { ...result, cleaned }
}

function safeParseJson(value) {
  try {
    return JSON.parse(String(value || '').trim())
  } catch {
    return null
  }
}

function portableRelativePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = value.normalize('NFKC').replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const segments = []
  const canonicalSegments = []
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') return null
    const canonical = segment.toLowerCase()
    const trimmed = canonical.replace(/[ .]+$/u, '')
    const deviceStem = trimmed.split('.')[0]
    if (
      !trimmed
      || trimmed !== canonical
      || /[:<>"|?*\u0000-\u001f]/u.test(trimmed)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(deviceStem)
    ) return null
    segments.push(segment)
    canonicalSegments.push(trimmed)
  }
  if (segments.length === 0) return null
  return { segments, key: canonicalSegments.join('/') }
}

function artifactPathWithin(baseDir, value) {
  const portable = portableRelativePath(value)
  if (!portable || isAbsolute(value)) return null
  const base = resolve(baseDir)
  const candidate = resolve(base, ...portable.segments)
  const relation = relative(base, candidate)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return null
  return candidate
}

async function canonicalReleaseArtifactPaths(matrix, baseDir) {
  const paths = new Map()
  const realPaths = new Set()
  const identities = new Set()
  const base = resolve(baseDir)
  const baseRealpath = await realpath(base).catch(() => base)
  for (const item of matrix.artifacts) {
    const candidate = artifactPathWithin(base, item.artifact)
    if (!candidate) return null
    paths.set(item.id, candidate)
    const metadata = await lstat(candidate).catch(() => null)
    if (!metadata) continue
    if (!metadata.isFile() || metadata.isSymbolicLink() || await pathContainsSymlink(candidate)) return null
    const canonicalPath = await realpath(candidate).catch(() => null)
    if (!canonicalPath) continue
    const relation = relative(baseRealpath, canonicalPath)
    if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return null
    const realKey = canonicalPath.normalize('NFKC').replaceAll('\\', '/').toLowerCase()
    const identityKey = metadata.dev || metadata.ino ? `${metadata.dev}:${metadata.ino}` : null
    if (realPaths.has(realKey) || (identityKey && identities.has(identityKey))) return null
    realPaths.add(realKey)
    if (identityKey) identities.add(identityKey)
  }
  return paths
}

export function validateArchiveEntries(entries, limits = DEFAULT_ARCHIVE_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > limits.maxEntries) return false
  let unpackedBytes = 0
  const paths = new Map()
  for (const entry of entries) {
    const normalized = String(entry?.path || '').replaceAll('\\', '/')
    const rawSegments = normalized.split('/').filter(Boolean)
    const segments = rawSegments.filter((segment) => segment !== '.')
    const size = Number(entry?.size || 0)
    if (
      !normalized
      || normalized.startsWith('/')
      || /^[A-Za-z]:/.test(normalized)
      || segments.includes('..')
      || !['File', 'Directory'].includes(entry?.type)
      || !Number.isSafeInteger(size)
      || size < 0
      || size > limits.maxEntryBytes
    ) return false
    const portableSegments = []
    for (const segment of segments) {
      const portable = segment.normalize('NFKC').toLowerCase()
      const trimmed = portable.replace(/[ .]+$/u, '')
      const deviceStem = trimmed.split('.')[0]
      if (
        !trimmed
        || trimmed !== portable
        || /[:<>"|?*\u0000-\u001f]/u.test(trimmed)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(deviceStem)
      ) return false
      portableSegments.push(trimmed)
    }
    const canonical = portableSegments.join('/')
    if (!canonical || paths.has(canonical)) return false
    for (let index = 1; index < portableSegments.length; index += 1) {
      if (paths.get(portableSegments.slice(0, index).join('/')) === 'File') return false
    }
    if (entry.type === 'File') {
      for (const existing of paths.keys()) if (existing.startsWith(`${canonical}/`)) return false
    }
    paths.set(canonical, entry.type)
    unpackedBytes += size
    if (unpackedBytes > limits.maxUnpackedBytes) return false
  }
  return true
}

async function findPluginRoots(root) {
  const roots = []
  if (await pathExists(join(root, 'package.json')) && await pathExists(await pluginManifestPath(root))) roots.push(root)
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name)) continue
    roots.push(...await findPluginRoots(join(root, entry.name)))
  }
  return roots
}

export async function extractionIsContained(root, limits) {
  const rootRealpath = await realpath(root)
  let entries = 0
  let unpackedBytes = 0
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name)
      const metadata = await lstat(candidate)
      if (metadata.isSymbolicLink()) return false
      const candidateRealpath = await realpath(candidate)
      const relation = relative(rootRealpath, candidateRealpath)
      if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return false
      entries += 1
      if (entries > limits.maxEntries) return false
      if (metadata.isFile()) {
        unpackedBytes += metadata.size
        if (metadata.nlink > 1 || metadata.size > limits.maxEntryBytes || unpackedBytes > limits.maxUnpackedBytes) return false
      } else if (metadata.isDirectory()) {
        if (!await visit(candidate)) return false
      } else {
        return false
      }
    }
    return true
  }
  return visit(root)
}

async function extractArchive(artifactPath, { limits = DEFAULT_ARCHIVE_LIMITS } = {}) {
  const metadata = await stat(artifactPath)
  if (!metadata.isFile() || metadata.size > limits.maxCompressedBytes) throw new Error('archive invalid')
  if (extname(artifactPath).toLowerCase() === '.zip') {
    return extractZipArchive(artifactPath, { limits })
  }
  const outputRoot = await mkdtemp(join(dirname(artifactPath), 'unpacked-'))
  const entries = []
  let entriesValid = true
  try {
    await tarList({
      file: artifactPath,
      strict: true,
      maxDecompressionRatio: Math.max(1, limits.maxUnpackedBytes / Math.max(1, metadata.size)),
      onReadEntry: (entry) => {
        entries.push({
          path: entry.path,
          type: entry.type,
          size: entry.size,
          linkpath: entry.linkpath,
        })
        entriesValid = entriesValid && validateArchiveEntries(entries, limits)
      },
    })
    if (!entriesValid || !validateArchiveEntries(entries, limits)) throw new Error('archive invalid')
    await tarExtract({ file: artifactPath, cwd: outputRoot, strict: true, preservePaths: false, noChmod: true })
    if (!await extractionIsContained(outputRoot, limits)) throw new Error('archive invalid')
    const pluginRoots = await findPluginRoots(outputRoot)
    if (pluginRoots.length !== 1) throw new Error('archive invalid')
    return { pluginRoot: pluginRoots[0], cleanup: () => rm(outputRoot, { recursive: true, force: true }) }
  } catch {
    await rm(outputRoot, { recursive: true, force: true })
    throw new Error('archive invalid')
  }
}

async function extractZipArchive(artifactPath, { limits }) {
  const buffer = await readFile(artifactPath)
  const invalid = () => new Error('archive invalid')
  if (buffer.length < 22 || buffer.length > limits.maxCompressedBytes) throw invalid()
  let eocd = -1
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw invalid()
  const count = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (
    buffer.readUInt16LE(eocd + 4) !== 0
    || buffer.readUInt16LE(eocd + 6) !== 0
    || buffer.readUInt16LE(eocd + 8) !== count
    || count === 0 || count > limits.maxEntries
    || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || centralOffset + centralSize !== eocd
  ) throw invalid()

  const decoder = new TextDecoder('utf-8', { fatal: true })
  const entries = []
  const intervals = []
  let cursor = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) throw invalid()
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const checksum = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const disk = buffer.readUInt16LE(cursor + 34)
    const attributes = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (
      next > eocd || !nameLength || disk !== 0
      || compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff
      || size > limits.maxEntryBytes || ![0, 8].includes(method) || (flags & 0x1) !== 0
      || localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50
      || buffer.readUInt16LE(localOffset + 6) !== flags
      || buffer.readUInt16LE(localOffset + 8) !== method
    ) throw invalid()
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength)
    let name
    try { name = decoder.decode(nameBytes) } catch { throw invalid() }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (
      localNameLength !== nameLength
      || !buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)
      || dataEnd > centralOffset
    ) throw invalid()
    const type = name.endsWith('/') ? 'Directory' : 'File'
    const unixType = (attributes >>> 16) & 0xf000
    if ((unixType !== 0 && unixType !== (type === 'Directory' ? 0x4000 : 0x8000))
      || (type === 'Directory' && (size !== 0 || compressedSize !== 0))) throw invalid()
    entries.push({ path: name, type, size, method, checksum, dataStart, dataEnd })
    intervals.push([localOffset, dataEnd])
    cursor = next
  }
  if (cursor !== eocd || !validateArchiveEntries(entries, limits)) throw invalid()
  intervals.sort((left, right) => left[0] - right[0])
  if (intervals.some((interval, index) => index > 0 && interval[0] < intervals[index - 1][1])) throw invalid()

  const outputRoot = await mkdtemp(join(dirname(artifactPath), 'unpacked-'))
  try {
    for (const entry of entries) {
      const target = join(outputRoot, ...entry.path.replaceAll('\\', '/').split('/').filter(Boolean))
      if (entry.type === 'Directory') {
        await mkdir(target, { recursive: true })
        continue
      }
      const compressed = buffer.subarray(entry.dataStart, entry.dataEnd)
      let contents
      try {
        contents = entry.method === 0
          ? compressed
          : inflateRawSync(compressed, { maxOutputLength: entry.size + 1 })
      } catch { throw invalid() }
      if (contents.length !== entry.size || (crc32(contents) >>> 0) !== entry.checksum) throw invalid()
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, contents, { flag: 'wx', mode: 0o600 })
    }
    if (!await extractionIsContained(outputRoot, limits)) throw invalid()
    const pluginRoots = await findPluginRoots(outputRoot)
    if (pluginRoots.length !== 1) throw invalid()
    return { pluginRoot: pluginRoots[0], cleanup: () => rm(outputRoot, { recursive: true, force: true }) }
  } catch {
    await rm(outputRoot, { recursive: true, force: true })
    throw invalid()
  }
}

export async function stageImmutableArtifact(artifactPath, { env = process.env } = {}) {
  const sourceMetadata = await lstat(artifactPath)
  if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) throw artifactError('artifact_path_invalid')
  if (sourceMetadata.size > MAX_ARTIFACT_BYTES) throw artifactError('artifact_size_exceeded')
  const stagingParent = String(env.TEMP || env.TMP || tmpdir())
  await mkdir(stagingParent, { recursive: true })
  const stagingRoot = await mkdtemp(join(stagingParent, 'uniopc-plugin-stage-'))
  await chmod(stagingRoot, 0o700).catch(() => {})
  const stagedArtifactPath = join(stagingRoot, `artifact${extname(artifactPath) || '.tgz'}`)
  try {
    const streamed = await streamArtifact(artifactPath, { outputPath: stagedArtifactPath })
    const trustedSha256 = streamed.sha256
    await chmod(stagedArtifactPath, 0o600).catch(() => {})
    return {
      artifactPath: stagedArtifactPath,
      trustedSha256,
      async verify() {
        return sha256File(stagedArtifactPath).then((value) => value === trustedSha256, () => false)
      },
      async materializeInstallCopy() {
        const installRoot = await mkdtemp(join(stagingRoot, 'install-'))
        await chmod(installRoot, 0o700).catch(() => {})
        const installArtifactPath = join(installRoot, `artifact${extname(artifactPath) || '.tgz'}`)
        try {
          await streamArtifact(stagedArtifactPath, { outputPath: installArtifactPath })
          await chmod(installArtifactPath, 0o400).catch(() => {})
          const verify = async () => sha256File(installArtifactPath)
            .then((value) => value === trustedSha256, () => false)
          if (!await verify()) throw new Error('artifact invalid')
          return {
            artifactPath: installArtifactPath,
            verify,
            cleanup: () => rm(installRoot, { recursive: true, force: true }),
          }
        } catch (error) {
          await rm(installRoot, { recursive: true, force: true })
          throw error
        }
      },
      cleanup: () => rm(stagingRoot, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true })
    throw error
  }
}

export async function defaultPrepareArtifact(artifactPath, context = {}) {
  const artifactStat = await stat(artifactPath)
  if (artifactStat.isDirectory()) return { pluginRoot: artifactPath, cleanup: async () => {} }
  return extractArchive(artifactPath, { limits: context.limits })
}

function inspectorPathFromEnvironment(env) {
  return String(env.UNIOPC_PLUGIN_INSPECTOR_CLI || '').trim()
    || resolve('node_modules', '@openclaw', 'plugin-inspector', 'src', 'cli.js')
}

export async function validateInspectorVersion(inspectorCliPath) {
  try {
    const packageRoot = dirname(dirname(resolve(inspectorCliPath)))
    const expectedCliPath = resolve(packageRoot, 'src', 'cli.js')
    const normalizedCliPath = process.platform === 'win32' ? resolve(inspectorCliPath).toLowerCase() : resolve(inspectorCliPath)
    const normalizedExpectedPath = process.platform === 'win32' ? expectedCliPath.toLowerCase() : expectedCliPath
    if (normalizedCliPath !== normalizedExpectedPath || !await pathExists(expectedCliPath)) return false
    const packageJson = await readJson(join(packageRoot, 'package.json'))
    return packageJson.version === INSPECTOR_VERSION
  } catch {
    return false
  }
}

function commandEnv(runtime, env, processHome) {
  const next = {}
  for (const key of [
    'TEMP',
    'TMP',
    'TMPDIR',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'ComSpec',
    'COMSPEC',
    'PATHEXT',
    'LANG',
    'LC_ALL',
    'TZ',
  ]) {
    if (String(env[key] || '').trim()) next[key] = env[key]
  }
  const home = String(processHome)
  const parsedHome = parsePath(home)
  next.HOME = home
  next.USERPROFILE = home
  next.HOMEDRIVE = parsedHome.root.replace(/[\\/]$/, '')
  next.HOMEPATH = home.slice(next.HOMEDRIVE.length)
  next.APPDATA = join(home, 'AppData', 'Roaming')
  next.LOCALAPPDATA = join(home, 'AppData', 'Local')
  next.XDG_CACHE_HOME = join(home, '.cache')
  next.XDG_CONFIG_HOME = join(home, '.config')
  next.XDG_DATA_HOME = join(home, '.local', 'share')
  next.NO_COLOR = '1'
  next.PLUGIN_INSPECTOR_EXECUTE_ISOLATED = '1'
  const runtimeBin = runtime.nodePath ? dirname(runtime.nodePath) : ''
  next.PATH = [runtimeBin, env.PATH || env.Path || ''].filter(Boolean).join(sep === '\\' ? ';' : ':')
  const isolatedValues = {
    OPENCLAW_HOME: env.UNIOPC_PLUGIN_AUDIT_HOME,
    OPENCLAW_STATE_DIR: env.UNIOPC_PLUGIN_AUDIT_STATE_DIR,
    OPENCLAW_CONFIG_PATH: env.UNIOPC_PLUGIN_AUDIT_CONFIG_PATH,
    OPENCLAW_GATEWAY_TOKEN: env.UNIOPC_PLUGIN_AUDIT_GATEWAY_TOKEN,
    OPENCLAW_GATEWAY_URL: env.UNIOPC_PLUGIN_AUDIT_GATEWAY_URL,
    OPENCLAW_WORKSPACE_DIR: env.OPENCLAW_WORKSPACE_DIR,
  }
  for (const [key, value] of Object.entries(isolatedValues)) {
    if (String(value || '').trim()) next[key] = value
    else delete next[key]
  }
  return next
}

async function isolatedCommandEnvironment(runtime, env) {
  const parent = String(env.TEMP || env.TMP || tmpdir())
  await mkdir(parent, { recursive: true })
  const ownedRoot = await mkdtemp(join(parent, 'uniopc-plugin-command-env-'))
  const processHome = join(ownedRoot, 'home')
  const isolated = commandEnv(runtime, env, processHome)
  await Promise.all([
    isolated.HOME,
    isolated.APPDATA,
    isolated.LOCALAPPDATA,
    isolated.XDG_CACHE_HOME,
    isolated.XDG_CONFIG_HOME,
    isolated.XDG_DATA_HOME,
  ].map((directory) => mkdir(directory, { recursive: true })))
  return {
    env: isolated,
    cleanup: () => rm(ownedRoot, { recursive: true, force: true }),
  }
}

function addStepFailure(report, code, artifactId) {
  report.errors.push(finding(code, artifactId))
}

export async function auditArtifact(pluginRoot, {
  runtime = {},
  env = process.env,
  deps = {},
} = {}) {
  const report = await auditPluginDirectory(pluginRoot)
  report.compatibility.checks = { builder: false, validator: false, inspector: false }
  const runCommand = deps.runCommand || defaultRunCommand
  const inspectorCliPath = runtime.inspectorCliPath || inspectorPathFromEnvironment(env)
  if (runtime.version !== HOST_VERSION) {
    report.errors.push(finding('runtime_version_mismatch'))
    report.ok = false
    return report
  }
  if (!runtime.nodePath || !runtime.cliPath || !runtime.packageRoot) {
    report.errors.push(finding('runtime_environment_missing'))
    report.ok = false
    return report
  }
  if (!deps.runCommand && !await validateInspectorVersion(inspectorCliPath)) {
    report.errors.push(finding('inspector_version_invalid'))
    report.ok = false
    return report
  }

  const isolatedEnvironment = await isolatedCommandEnvironment(runtime, env)
  const auditEnv = isolatedEnvironment.env
  const context = {
    item: { id: null },
    artifactId: null,
    pluginRoot,
    report,
    runtime,
    runCommand,
    env: auditEnv,
  }
  const entry = report.plugin?.entry
  const inspectorTemp = String(env.TEMP || env.TMP || tmpdir())
  await mkdir(inspectorTemp, { recursive: true })
  const inspectorOutput = await mkdtemp(join(inspectorTemp, 'uniopc-plugin-inspector-'))
  try {
    const builder = await executeStep(context, 'builder', [
      runtime.cliPath, 'plugins', 'build', '--root', pluginRoot, '--entry', entry || '', '--check',
    ], 'builder_failed')
    report.compatibility.checks.builder = builder.ok
    const validator = await executeStep(context, 'validator', [
      runtime.cliPath, 'plugins', 'validate', '--root', pluginRoot, '--entry', entry || '', '--json',
    ], 'validator_failed', { jsonValidator: (json) => json?.valid === true && Array.isArray(json?.errors) && json.errors.length === 0 })
    report.compatibility.checks.validator = validator.ok
    const inspector = await executeStep(context, 'inspector', [
      inspectorCliPath,
      'inspect',
      '--plugin-root', pluginRoot,
      '--out', inspectorOutput,
      '--openclaw', runtime.packageRoot,
      '--runtime',
      '--mock-sdk',
      '--allow-execute',
      '--check',
      '--json',
    ], 'inspector_failed')
    report.compatibility.checks.inspector = inspector.ok
  } finally {
    await rm(inspectorOutput, { recursive: true, force: true })
    await isolatedEnvironment.cleanup()
  }
  sortFindings(report.errors)
  report.ok = report.errors.length === 0
    && Object.values(report.compatibility.checks).every(Boolean)
  return report
}

async function executeStep(context, step, args, errorCode, { jsonValidator } = {}) {
  const result = await context.runCommand({
    step,
    command: context.runtime.nodePath,
    args,
    cwd: context.pluginRoot,
    env: context.env,
    trackDescendants: true,
  })
  if (result.code !== 0 || result.cleaned === false) {
    addStepFailure(context.report, errorCode, context.artifactId)
    return { ok: false, result, json: null }
  }
  const json = jsonValidator ? safeParseJson(result.stdout) : null
  if (jsonValidator && !jsonValidator(json)) {
    addStepFailure(context.report, errorCode, context.artifactId)
    return { ok: false, result, json }
  }
  return { ok: true, result, json }
}

function runtimePluginFromJson(payload) {
  if (payload?.plugin && typeof payload.plugin === 'object') return payload.plugin
  if (payload?.result?.plugin && typeof payload.result.plugin === 'object') return payload.result.plugin
  return null
}

export function toolInvocationSucceeded(payload) {
  return Boolean(
    payload
    && typeof payload === 'object'
    && payload.ok === true
    && !Object.hasOwn(payload, 'error')
    && payload.output
    && typeof payload.output === 'object'
    && !Array.isArray(payload.output)
    && payload.output.isError !== true
    && Array.isArray(payload.output.content)
  )
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function listProcessTree(rootPid, env) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return []
  if (process.platform === 'win32') {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const script = [
      '$rootPid = [int]$args[0]',
      '$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)',
      '$ids = [System.Collections.Generic.List[int]]::new()',
      '$ids.Add($rootPid)',
      'for ($i = 0; $i -lt $ids.Count; $i++) {',
      '  foreach ($row in $rows) {',
      '    if ([int]$row.ParentProcessId -eq $ids[$i] -and -not $ids.Contains([int]$row.ProcessId)) { $ids.Add([int]$row.ProcessId) }',
      '  }',
      '}',
      '$ids | ConvertTo-Json -Compress',
    ].join('; ')
    const result = await defaultRunCommand({
      command: powershell,
      args: ['-NoProfile', '-NonInteractive', '-Command', script, String(rootPid)],
      cwd: env.TEMP || env.TMP || tmpdir(),
      env,
    })
    const parsed = safeParseJson(result.stdout)
    if (result.code === 0 && Array.isArray(parsed)) return parsed.filter(Number.isInteger)
    if (result.code === 0 && Number.isInteger(parsed)) return [parsed]
    return [rootPid]
  }

  const result = await defaultRunCommand({
    command: 'ps',
    args: ['-eo', 'pid=,ppid='],
    cwd: env.TEMP || env.TMP || tmpdir(),
    env,
  })
  const rows = String(result.stdout || '').split(/\r?\n/).map((line) => {
    const [pid, parentPid] = line.trim().split(/\s+/).map(Number)
    return { pid, parentPid }
  }).filter(({ pid, parentPid }) => Number.isInteger(pid) && Number.isInteger(parentPid))
  const ids = [rootPid]
  for (let index = 0; index < ids.length; index += 1) {
    for (const row of rows) if (row.parentPid === ids[index] && !ids.includes(row.pid)) ids.push(row.pid)
  }
  return ids
}

async function terminateProcessTree(pids, env) {
  const ownedPids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0).reverse()
  if (process.platform === 'win32') {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
    for (const pid of ownedPids) {
      await defaultRunCommand({
        command: join(systemRoot, 'System32', 'taskkill.exe'),
        args: ['/PID', String(pid), '/T', '/F'],
        cwd: env.TEMP || env.TMP || tmpdir(),
        env,
      })
    }
    return ownedPids.every((pid) => !processExists(pid))
  }
  const rootPid = ownedPids.at(-1)
  try {
    if (rootPid) process.kill(-rootPid, 'SIGKILL')
  } catch {}
  for (const pid of ownedPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  return ownedPids.every((pid) => !processExists(pid))
}

function gatewayEndpoint(env) {
  try {
    const url = new URL(String(env.OPENCLAW_GATEWAY_URL || env.UNIOPC_PLUGIN_AUDIT_GATEWAY_URL || ''))
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port) return null
    return { url: url.href.replace(/\/$/, ''), port: url.port }
  } catch {
    return null
  }
}

export function createForegroundGatewaySupervisor({ runtime, env, deps = {} }) {
  const endpoint = gatewayEndpoint(env)
  const token = String(env.OPENCLAW_GATEWAY_TOKEN || env.UNIOPC_PLUGIN_AUDIT_GATEWAY_TOKEN || '')
  const spawnProcess = deps.spawnProcess || spawn
  const runCommand = deps.runCommand || defaultRunCommand
  const delayFn = deps.delay || delay
  const listOwnedProcessTree = deps.listProcessTree || listProcessTree
  const terminateOwnedProcessTree = deps.terminateProcessTree || terminateProcessTree
  const ownedProcessTreeGone = deps.processTreeGone || (async (pids) => pids.every((pid) => !processExists(pid)))
  const stopPollAttempts = deps.stopPollAttempts || 20
  let owned = null

  async function waitForOwnedTreeGone(pids) {
    for (let attempt = 0; attempt < stopPollAttempts; attempt += 1) {
      if (await ownedProcessTreeGone(pids, env)) return true
      if (attempt + 1 < stopPollAttempts) await delayFn(100)
    }
    return false
  }

  async function stop() {
    if (!owned) return true
    const current = owned
    const discovered = await listOwnedProcessTree(current.child.pid, env)
    for (const pid of discovered) current.pids.add(pid)
    const stopped = current.exited
      ? true
      : await Promise.race([
          new Promise((resolveStopped) => current.child.once('exit', () => resolveStopped(true))),
          Promise.resolve(current.child.kill()).then(() => delayFn(5000)).then(() => false),
        ])
    const ownedPids = [...current.pids]
    if (!stopped) await terminateOwnedProcessTree(ownedPids, env)
    let gone = await waitForOwnedTreeGone(ownedPids)
    if (!gone && stopped) {
      await terminateOwnedProcessTree(ownedPids, env)
      gone = await waitForOwnedTreeGone(ownedPids)
    }
    if (gone && owned === current) owned = null
    return gone
  }

  async function start() {
    if (!endpoint || !token) return false
    if (owned && !await stop()) return false
    const child = spawnProcess(runtime.nodePath, [
      runtime.cliPath,
      'gateway',
      'run',
      '--port', endpoint.port,
      '--bind', 'loopback',
      '--auth', 'token',
      '--token', token,
      '--allow-unconfigured',
    ], {
      cwd: runtime.packageRoot,
      env: {
        ...env,
        OPENCLAW_NO_RESPAWN: '1',
        OPENCLAW_DISABLE_BONJOUR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    const current = { child, exited: false, pids: new Set([child.pid]) }
    owned = current
    child.once('exit', () => { current.exited = true })
    child.stdout?.resume()
    child.stderr?.resume()

    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (current.exited) return false
      const health = await runCommand({
        command: runtime.nodePath,
        args: [
          runtime.cliPath,
          'gateway',
          'call',
          'health',
          '--url', endpoint.url,
          '--token', token,
          '--timeout', '1000',
          '--json',
        ],
        cwd: runtime.packageRoot,
        env,
      })
      if (health.code === 0) {
        for (const pid of await listOwnedProcessTree(child.pid, env)) current.pids.add(pid)
        return true
      }
      await delayFn(250)
    }
    await stop()
    return false
  }

  return {
    async restart() {
      if (!owned) return { ok: await start() }
      if (!await stop()) return { ok: false }
      return { ok: await start() }
    },
    stop,
  }
}

export async function runReleaseMatrix({
  matrix,
  baseDir,
  runtime = {},
  env = process.env,
  deps = {},
} = {}) {
  const report = {
    schemaVersion: 1,
    ok: false,
    errors: [],
    warnings: [],
    compatibility: { hostVersion: HOST_VERSION, artifacts: [] },
    capabilities: { artifacts: [] },
    releaseMatrix: {
      runtimeOwnership: { mode: 'owned-foreground', cleaned: false },
      artifacts: [],
    },
  }
  if (matrix?.schemaVersion !== 1 || !Array.isArray(matrix?.artifacts)) {
    report.errors.push(finding('matrix_invalid'))
    return report
  }
  if (matrix.artifacts.length === 0) {
    report.errors.push(finding('matrix_empty'))
    return report
  }

  const sandbox = deps.sandbox
  if (
    sandbox?.enforced !== true
    || !['windows-job', 'linux-container', 'linux-cgroup'].includes(sandbox.kind)
    || typeof sandbox.runCommand !== 'function'
    || typeof sandbox.restartRuntime !== 'function'
    || typeof sandbox.stageArtifact !== 'function'
    || typeof sandbox.quiesce !== 'function'
    || typeof sandbox.close !== 'function'
  ) {
    report.errors.push(finding('sandbox_unavailable'))
    return report
  }

  const runCommand = sandbox.runCommand
  const prepareArtifact = deps.prepareArtifact || defaultPrepareArtifact
  const stageArtifact = sandbox.stageArtifact
  const inspectorCliPath = runtime.inspectorCliPath || inspectorPathFromEnvironment(env)
  const verifyInspector = deps.skipInspectorPathVerification === true || await validateInspectorVersion(inspectorCliPath)
  const isolatedRuntimeReady = [
    env.UNIOPC_PLUGIN_AUDIT_HOME,
    env.UNIOPC_PLUGIN_AUDIT_STATE_DIR,
    env.UNIOPC_PLUGIN_AUDIT_CONFIG_PATH,
    env.UNIOPC_PLUGIN_AUDIT_GATEWAY_URL,
    env.UNIOPC_PLUGIN_AUDIT_GATEWAY_TOKEN,
  ].every((value) => String(value || '').trim())
  const isolatedEnvironment = await isolatedCommandEnvironment(runtime, env)
  const auditEnv = isolatedEnvironment.env
  const restartRuntime = sandbox.restartRuntime

  try {
    for (const item of [...matrix.artifacts].sort((left, right) => String(left?.id || '').localeCompare(String(right?.id || '')))) {
    const rawArtifactId = typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : null
    const artifactId = publicIdentifier(rawArtifactId, 'release-artifact')
    const releaseState = {
      artifactId,
      sha256Verified: false,
      identityVerified: false,
      compatibilityVerified: false,
      installed: false,
      enabled: false,
      restarted: false,
      runtimeInspected: false,
      readOnlyInvoked: false,
      disabled: false,
      uninstalled: false,
    }
    const capabilityState = {
      artifactId,
      declared: [],
      readOnlyDeclared: [],
      runtimeRegistered: [],
      runtimeVerified: false,
    }
    const compatibilityState = {
      artifactId,
      pluginId: publicIdentifier(item?.pluginId, item?.pluginId ? 'runtime-plugin' : null),
      pluginApi: publicRequirement(item?.pluginApi),
      hostVersion: HOST_VERSION,
      compatible: false,
      checks: { builder: false, validator: false, inspector: false },
    }
    report.releaseMatrix.artifacts.push(releaseState)
    report.capabilities.artifacts.push(capabilityState)
    report.compatibility.artifacts.push(compatibilityState)

    const artifactPath = artifactPathWithin(baseDir, item?.artifact)
    if (!artifactPath) {
      addStepFailure(report, 'artifact_path_invalid', artifactId)
      continue
    }
    if (!await pathExists(artifactPath)) {
      addStepFailure(report, 'artifact_missing', artifactId)
      continue
    }
    if (!/^[a-f0-9]{64}$/i.test(String(item?.sha256 || ''))) {
      addStepFailure(report, 'artifact_sha_missing', artifactId)
      continue
    }
    if (runtime.version !== HOST_VERSION) {
      addStepFailure(report, 'runtime_version_mismatch', artifactId)
      continue
    }
    if (!runtime.nodePath || !runtime.cliPath || !runtime.packageRoot || !isolatedRuntimeReady) {
      addStepFailure(report, 'runtime_environment_missing', artifactId)
      continue
    }
    if (!verifyInspector) {
      addStepFailure(report, 'inspector_version_invalid', artifactId)
      continue
    }

    let staged
    try {
      const sourceMetadata = await lstat(artifactPath)
      if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) throw new Error('artifact invalid')
      staged = await stageArtifact(artifactPath, { env })
      if (await sha256File(staged.artifactPath) !== item.sha256.toLowerCase()) {
        addStepFailure(report, 'artifact_sha_mismatch', artifactId)
        await staged.cleanup()
        continue
      }
      releaseState.sha256Verified = true
    } catch {
      addStepFailure(report, 'artifact_path_invalid', artifactId)
      await staged?.cleanup?.()
      continue
    }

    let prepared
    let installCopy
    let inspectorOutput
    let installed = false
    let enabled = false
    try {
      prepared = await prepareArtifact(staged.artifactPath, { runCommand })
      const staticReport = await auditPluginDirectory(prepared.pluginRoot)
      const rawDeclared = staticReport[RAW_DECLARED_TOOLS] || []
      const rawReadOnlyDeclared = staticReport[RAW_READ_ONLY_TOOLS] || []
      capabilityState.declared = staticReport.capabilities.declared
      capabilityState.readOnlyDeclared = staticReport.capabilities.readOnlyDeclared
      for (const error of staticReport.errors) report.errors.push({ ...error, artifactId })
      for (const warning of staticReport.warnings) report.warnings.push({ ...warning, artifactId })
      if (staticReport[RAW_PLUGIN_ID] !== item.pluginId) addStepFailure(report, 'artifact_id_mismatch', artifactId)
      else releaseState.identityVerified = true
      if (staticReport.compatibility.pluginApi !== item.pluginApi) {
        addStepFailure(report, 'compatibility_mismatch', artifactId)
      } else if (staticReport.compatibility.compatible) {
        compatibilityState.compatible = true
        releaseState.compatibilityVerified = true
      }

      const context = {
        item,
        artifactId,
        pluginRoot: prepared.pluginRoot,
        report,
        runtime,
        runCommand,
        env: auditEnv,
      }
      const entry = staticReport.plugin?.entry
      const inspectorTemp = String(env.TEMP || env.TMP || tmpdir())
      await mkdir(inspectorTemp, { recursive: true })
      inspectorOutput = await mkdtemp(join(inspectorTemp, 'uniopc-plugin-inspector-'))
      const builder = await executeStep(context, 'builder', [
        runtime.cliPath, 'plugins', 'build', '--root', prepared.pluginRoot, '--entry', entry || '', '--check',
      ], 'builder_failed')
      compatibilityState.checks.builder = builder.ok
      if (builder.result?.cleaned === false) continue
      const validator = await executeStep(context, 'validator', [
        runtime.cliPath, 'plugins', 'validate', '--root', prepared.pluginRoot, '--entry', entry || '', '--json',
      ], 'validator_failed', { jsonValidator: (json) => json?.valid === true && Array.isArray(json?.errors) && json.errors.length === 0 })
      compatibilityState.checks.validator = validator.ok
      if (validator.result?.cleaned === false) continue
      const inspector = await executeStep(context, 'inspector', [
        inspectorCliPath,
        'inspect',
        '--plugin-root', prepared.pluginRoot,
        '--out', inspectorOutput,
        '--openclaw', runtime.packageRoot,
        '--runtime',
        '--mock-sdk',
        '--allow-execute',
        '--check',
        '--json',
      ], 'inspector_failed')
      compatibilityState.checks.inspector = inspector.ok
      if (inspector.result?.cleaned === false) continue

      let artifactIntegrityVerified = true
      if (builder.ok && validator.ok && inspector.ok) {
        const quiesced = await sandbox.quiesce(context)
        artifactIntegrityVerified = quiesced === true
          && (typeof staged.verify !== 'function' || await staged.verify())
        if (!artifactIntegrityVerified) addStepFailure(report, 'artifact_integrity_changed', artifactId)
      }

      if (builder.ok && validator.ok && inspector.ok && artifactIntegrityVerified && staticReport.errors.length === 0 && releaseState.identityVerified && releaseState.compatibilityVerified) {
        await prepared.cleanup?.()
        prepared = null
        try {
          installCopy = typeof staged.materializeInstallCopy === 'function'
            ? await staged.materializeInstallCopy()
            : { artifactPath: staged.artifactPath, verify: async () => true, cleanup: async () => {} }
        } catch {
          addStepFailure(report, 'artifact_integrity_changed', artifactId)
          continue
        }
        if (!await installCopy.verify()) {
          addStepFailure(report, 'artifact_integrity_changed', artifactId)
          continue
        }
        const installContext = { ...context, pluginRoot: baseDir }
        const install = await executeStep(installContext, 'install', [
          runtime.cliPath, 'plugins', 'install', installCopy.artifactPath, '--force', '--accept-capabilities',
        ], 'lifecycle_install_failed')
        const installCopyIntact = await installCopy.verify()
        if (!installCopyIntact) addStepFailure(report, 'artifact_integrity_changed', artifactId)
        installed = install.ok && installCopyIntact
        releaseState.installed = installed
        if (installed) {
          const enable = await executeStep(installContext, 'enable', [
            runtime.cliPath, 'plugins', 'enable', item.pluginId, '--accept-capabilities',
          ], 'lifecycle_enable_failed')
          enabled = enable.ok
          releaseState.enabled = enabled
        }
        if (enabled) {
          const restart = await restartRuntime(context)
          if (!restart?.ok) addStepFailure(report, 'lifecycle_restart_failed', artifactId)
          releaseState.restarted = restart.ok
          if (restart.ok) {
            const inspection = await executeStep(installContext, 'runtime-inspect', [
              runtime.cliPath, 'plugins', 'inspect', item.pluginId, '--runtime', '--json',
            ], 'runtime_registration_unverified', { jsonValidator: (json) => Boolean(runtimePluginFromJson(json)) })
            if (inspection.ok) {
              const runtimePlugin = runtimePluginFromJson(inspection.json)
              const rawRegistered = Array.isArray(runtimePlugin?.toolNames)
                ? runtimePlugin.toolNames.filter((value) => typeof value === 'string').sort()
                : []
              capabilityState.runtimeRegistered = rawRegistered
                .map((name) => publicIdentifier(name, 'runtime-capability'))
                .sort()
              releaseState.runtimeInspected = runtimePlugin?.id === item.pluginId && runtimePlugin?.status === 'loaded'
              const readTool = item?.readOnlyTool?.name
              capabilityState.runtimeVerified = releaseState.runtimeInspected
                && typeof readTool === 'string'
                && rawRegistered.includes(readTool)
                && rawDeclared.includes(readTool)
                && rawReadOnlyDeclared.includes(readTool)
                && rawDeclared.every((name) => rawRegistered.includes(name))
              if (!capabilityState.runtimeVerified) {
                addStepFailure(
                  report,
                  rawReadOnlyDeclared.includes(readTool)
                    ? 'runtime_registration_unverified'
                    : 'read_only_tool_unverified',
                  artifactId,
                )
              } else {
                const params = JSON.stringify({
                  name: readTool,
                  args: item.readOnlyTool.arguments || {},
                  sessionKey: 'main',
                  confirm: false,
                })
                const invokeArgs = [runtime.cliPath, 'gateway', 'call', 'tools.invoke', '--params', params, '--json']
                if (env.UNIOPC_PLUGIN_AUDIT_GATEWAY_URL) invokeArgs.push('--url', env.UNIOPC_PLUGIN_AUDIT_GATEWAY_URL)
                if (env.UNIOPC_PLUGIN_AUDIT_GATEWAY_TOKEN) invokeArgs.push('--token', env.UNIOPC_PLUGIN_AUDIT_GATEWAY_TOKEN)
                const invoked = await executeStep(installContext, 'invoke', invokeArgs, 'read_only_invoke_failed', {
                  jsonValidator: toolInvocationSucceeded,
                })
                releaseState.readOnlyInvoked = invoked.ok
              }
            }
          }
        }
      }
    } catch {
      addStepFailure(report, 'manifest_invalid', artifactId)
    } finally {
      if (enabled) {
        const result = await runCommand({
          step: 'disable',
          command: runtime.nodePath,
          args: [runtime.cliPath, 'plugins', 'disable', item.pluginId],
          cwd: prepared?.pluginRoot || baseDir,
          env: auditEnv,
          trackDescendants: true,
        })
        releaseState.disabled = result.code === 0 && result.cleaned !== false
        if (!releaseState.disabled) addStepFailure(report, 'lifecycle_disable_failed', artifactId)
      }
      if (installed) {
        const result = await runCommand({
          step: 'uninstall',
          command: runtime.nodePath,
          args: [runtime.cliPath, 'plugins', 'uninstall', item.pluginId, '--force'],
          cwd: prepared?.pluginRoot || baseDir,
          env: auditEnv,
          trackDescendants: true,
        })
        releaseState.uninstalled = result.code === 0 && result.cleaned !== false
        if (!releaseState.uninstalled) addStepFailure(report, 'lifecycle_uninstall_failed', artifactId)
      }
      await prepared?.cleanup?.()
      await installCopy?.cleanup?.()
      await staged?.cleanup?.()
      if (inspectorOutput) await rm(inspectorOutput, { recursive: true, force: true })
    }
    }
  } finally {
    const sandboxResult = await sandbox.close()
    report.releaseMatrix.runtimeOwnership.cleaned = sandboxResult?.cleaned === true
    await isolatedEnvironment.cleanup()
  }

  sortFindings(report.errors)
  sortFindings(report.warnings)
  report.ok = releaseMatrixPassed(report)
  return report
}

export function releaseMatrixPassed(report) {
  return report.errors.length === 0
    && report.releaseMatrix.runtimeOwnership.cleaned === true
    && report.releaseMatrix.artifacts.every((item) =>
      item.sha256Verified
      && item.identityVerified
      && item.compatibilityVerified
      && item.installed
      && item.enabled
      && item.restarted
      && item.runtimeInspected
      && item.readOnlyInvoked
      && item.disabled
      && item.uninstalled)
    && report.capabilities.artifacts.every((item) => item.runtimeVerified)
}

export async function runtimeFromEnvironment(env) {
  const nodePath = String(env.UNIOPC_OPENCLAW_NODE || '').trim()
  const cliPath = String(env.UNIOPC_OPENCLAW_CLI || '').trim()
  const packageRoot = String(env.UNIOPC_OPENCLAW_PACKAGE_ROOT || '').trim()
  if (!nodePath || !cliPath || !packageRoot) return null
  try {
    const expectedCliPath = resolve(packageRoot, 'uniopc-engine.mjs')
    const normalizedCliPath = process.platform === 'win32' ? resolve(cliPath).toLowerCase() : resolve(cliPath)
    const normalizedExpectedPath = process.platform === 'win32' ? expectedCliPath.toLowerCase() : expectedCliPath
    if (normalizedCliPath !== normalizedExpectedPath || !await pathExists(expectedCliPath)) return null
    const packageJson = await readJson(join(packageRoot, 'package.json'))
    const versionResult = await defaultRunCommand({ command: nodePath, args: ['--version'], cwd: packageRoot, env })
    const cliVersionResult = await defaultRunCommand({ command: nodePath, args: [expectedCliPath, '--version'], cwd: packageRoot, env })
    if (
      packageJson.version !== HOST_VERSION
      || versionResult.code !== 0
      || versionResult.stdout.trim() !== 'v24.19.0'
      || cliVersionResult.code !== 0
      || !cliVersionResult.stdout.includes(HOST_VERSION)
    ) return null
    return { version: packageJson.version, nodePath, cliPath, packageRoot }
  } catch {
    return null
  }
}

export async function auditTarget(target, { env = process.env, runtime: runtimeOverride, deps = {} } = {}) {
  const absoluteTarget = resolve(target)
  const targetStat = await stat(absoluteTarget).catch(() => null)
  if (!targetStat) {
    const report = {
      schemaVersion: 1,
      ok: false,
      errors: [finding('artifact_missing')],
      warnings: [],
      compatibility: { hostVersion: HOST_VERSION, artifacts: [] },
      capabilities: { artifacts: [] },
    }
    return report
  }
  const matrixPath = targetStat.isDirectory() ? join(absoluteTarget, MATRIX_FILE) : absoluteTarget
  const isMatrix = basename(matrixPath) === MATRIX_FILE || extname(matrixPath) === '.json'
  if (isMatrix && await pathExists(matrixPath)) {
    const runtime = runtimeOverride || (deps.sandbox ? await runtimeFromEnvironment(env) : null)
    return runReleaseMatrix({
      matrix: await readJson(matrixPath),
      baseDir: dirname(matrixPath),
      runtime: runtime || {},
      env,
      deps,
    })
  }

  const prepared = targetStat.isDirectory()
    ? { pluginRoot: absoluteTarget, cleanup: async () => {} }
    : await defaultPrepareArtifact(absoluteTarget, { runCommand: defaultRunCommand })
  try {
    const staticReport = await auditPluginDirectory(prepared.pluginRoot)
    const errors = [...staticReport.errors]
    if (staticReport.ok && !staticReport.capabilities.runtimeVerified) {
      errors.push(finding('runtime_registration_unverified'))
    }
    sortFindings(errors)
    return {
      schemaVersion: 1,
      mode: 'preflight',
      ok: false,
      errors,
      warnings: staticReport.warnings,
      compatibility: {
        hostVersion: staticReport.compatibility.hostVersion,
        artifacts: [{
          artifactId: staticReport.plugin?.id,
          pluginId: staticReport.plugin?.id,
          pluginApi: staticReport.compatibility.pluginApi,
          hostVersion: staticReport.compatibility.hostVersion,
          compatible: staticReport.compatibility.compatible,
          checks: staticReport.compatibility.checks || { builder: false, validator: false, inspector: false },
        }],
      },
      capabilities: {
        artifacts: [{
          artifactId: staticReport.plugin?.id,
          declared: staticReport.capabilities.declared,
          readOnlyDeclared: staticReport.capabilities.readOnlyDeclared,
          runtimeRegistered: [],
          runtimeVerified: false,
        }],
      },
    }
  } finally {
    await prepared.cleanup()
  }
}

export async function writeSanitizedReport(path, report) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
}

async function prepareBundledRuntime(runtimeArchivePath, env) {
  if (!runtimeArchivePath || !await pathExists(runtimeArchivePath)) return null
  const tempParent = String(env.TEMP || env.TMP || tmpdir())
  await mkdir(tempParent, { recursive: true })
  const root = await mkdtemp(join(tempParent, 'uniopc-release-runtime-'))
  const listed = await defaultRunCommand({ command: 'tar', args: ['-tf', runtimeArchivePath], cwd: root, env })
  const entries = String(listed.stdout || '').split(/\r?\n/).filter(Boolean)
  if (listed.code !== 0 || entries.some((entry) => {
    const normalized = entry.replaceAll('\\', '/')
    return normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')
  })) {
    await rm(root, { recursive: true, force: true })
    return null
  }
  const extracted = await defaultRunCommand({ command: 'tar', args: ['-xf', runtimeArchivePath, '-C', root], cwd: root, env })
  if (extracted.code !== 0) {
    await rm(root, { recursive: true, force: true })
    return null
  }

  const nodeCandidates = process.platform === 'win32'
    ? [join(root, 'tools', 'node', 'node.exe')]
    : [
        join(root, 'tools', 'node', 'bin', 'node'),
        join(root, 'tools', `node-v24.19.0`, 'bin', 'node'),
      ]
  const packageCandidates = [
    join(root, 'tools', 'node', 'node_modules', 'uniopc-engine'),
    join(root, 'tools', 'node', 'lib', 'node_modules', 'uniopc-engine'),
    join(root, 'tools', 'node-v24.19.0', 'lib', 'node_modules', 'uniopc-engine'),
  ]
  let nodePath = nodeCandidates.find((value) => entries.some((entry) => entry.replaceAll('\\', '/').endsWith(relative(root, value).replaceAll('\\', '/'))))
  if (!nodePath) {
    for (const candidate of nodeCandidates) {
      if (await pathExists(candidate)) {
        nodePath = candidate
        break
      }
    }
  }
  let packageRoot = null
  for (const candidate of packageCandidates) {
    if (await pathExists(join(candidate, 'package.json'))) {
      packageRoot = candidate
      break
    }
  }
  if (!nodePath || !packageRoot || !await pathExists(nodePath)) {
    await rm(root, { recursive: true, force: true })
    return null
  }
  const packageJson = await readJson(join(packageRoot, 'package.json')).catch(() => null)
  const nodeVersion = await defaultRunCommand({ command: nodePath, args: ['--version'], cwd: root, env })
  if (packageJson?.version !== HOST_VERSION || nodeVersion.code !== 0 || nodeVersion.stdout.trim() !== 'v24.19.0') {
    await rm(root, { recursive: true, force: true })
    return null
  }
  return {
    runtime: {
      version: packageJson.version,
      nodePath,
      cliPath: join(packageRoot, 'uniopc-engine.mjs'),
      packageRoot,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

function hasExactKeys(value, keys) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function validProofList(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 128)
    && new Set(value).size === value.length
    && [...value].sort().every((item, index) => item === value[index])
}

function attestationPublicKey(value) {
  const raw = String(value || '').trim()
  if (raw.startsWith('-----BEGIN PUBLIC KEY-----')) return raw
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new TypeError('invalid public key')
  const key = Buffer.from(raw, 'base64')
  if (key.toString('base64') !== raw) throw new TypeError('invalid public key')
  return { key, format: 'der', type: 'spki' }
}

function canonicalBase64(value, bytes) {
  const raw = String(value || '')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) return null
  const decoded = Buffer.from(raw, 'base64')
  return decoded.length === bytes && decoded.toString('base64') === raw ? decoded : null
}

function validTrustedWorkerLock(lock) {
  if (!hasExactKeys(lock, ['schemaVersion', 'protocol', 'workers']) || lock.schemaVersion !== 1) return false
  if (
    !hasExactKeys(lock.protocol, ['id', 'version', 'reportSchemaVersion'])
    || lock.protocol.id !== 'uniopc-openclaw-plugin-audit'
    || lock.protocol.version !== 1
    || lock.protocol.reportSchemaVersion !== 1
    || !Array.isArray(lock.workers)
    || lock.workers.length !== 2
  ) return false
  const expectedPlatforms = ['linux/amd64', 'linux/arm64']
  return lock.workers.every((worker, index) => (
    hasExactKeys(worker, ['platform', 'status', 'image'])
    && worker.platform === expectedPlatforms[index]
    && ['available', 'unavailable'].includes(worker.status)
    && (worker.status === 'available'
      ? typeof worker.image === 'string' && Boolean(containerImageDigest(worker.image))
      : worker.image === null)
  ))
}

function trustedWorkerForPlatform(lock, platform) {
  if (!validTrustedWorkerLock(lock)) return null
  const worker = lock.workers.find((candidate) => candidate.platform === platform)
  if (!worker || worker.status !== 'available') return null
  return { ...worker, protocol: { ...lock.protocol } }
}

function runtimeTargetFromAuditTarget(target) {
  const [platform, arch, extra] = String(target || '').split('/')
  if (extra || !['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) return null
  return { platform, arch }
}

function executionRuntimeTargetForWorker(workerPlatform) {
  if (workerPlatform === 'linux/amd64') return { platform: 'linux', arch: 'x64' }
  if (workerPlatform === 'linux/arm64') return { platform: 'linux', arch: 'arm64' }
  return null
}

function executionRuntimePlatformForWorker(workerPlatform) {
  const target = executionRuntimeTargetForWorker(workerPlatform)
  return target ? `${target.platform}/${target.arch}` : null
}

async function verifiedRuntimeIdentity({ snapshot, target, runtimeDirectory, verifyRuntimeContract }) {
  if (!snapshot || !/^[0-9a-f]{64}$/.test(snapshot.sha256 || '') || !target) throw new Error('runtime contract invalid')
  const contract = await verifyRuntimeContract(target, runtimeDirectory ? { runtimeDirectory } : undefined)
  if (
    !contract
    || contract.version !== HOST_VERSION
    || contract.target?.platform !== target.platform
    || contract.target?.arch !== target.arch
    || contract.artifact?.nodeVersion !== '24.19.0'
    || contract.verifiedArchive?.sha256 !== snapshot.sha256
  ) throw new Error('runtime contract invalid')
  return {
    target: `${target.platform}/${target.arch}`,
    openclawVersion: contract.version,
    nodeVersion: contract.artifact.nodeVersion,
    archiveSha256: snapshot.sha256,
  }
}

const RELEASE_PROOF_KEYS = [
  'builder', 'validator', 'inspector', 'installed', 'enabled', 'restarted',
  'runtimeInspected', 'readOnlyInvoked', 'disabled', 'uninstalled', 'cleaned',
]

function validReleaseMatrix(matrix) {
  if (!hasExactKeys(matrix, ['schemaVersion', 'attestation', 'artifacts'])) return false
  if (matrix.schemaVersion !== 1 || !portableRelativePath(matrix.attestation)) return false
  if (!Array.isArray(matrix.artifacts) || matrix.artifacts.length === 0) return false
  const ids = []
  const paths = new Set()
  for (const item of matrix.artifacts) {
    const portableArtifact = portableRelativePath(item?.artifact)
    if (!hasExactKeys(item, ['id', 'artifact', 'sha256', 'pluginId', 'pluginApi', 'readOnlyTool'])) return false
    if (
      !publicIdentifier(item.id)
      || !publicIdentifier(item.pluginId)
      || !/^[0-9a-f]{64}$/.test(String(item.sha256 || ''))
      || !publicRequirement(item.pluginApi)
      || !portableArtifact
      || paths.has(portableArtifact.key)
      || !hasExactKeys(item.readOnlyTool, ['name', 'arguments'])
      || !publicIdentifier(item.readOnlyTool.name)
      || !item.readOnlyTool.arguments
      || typeof item.readOnlyTool.arguments !== 'object'
      || Array.isArray(item.readOnlyTool.arguments)
    ) return false
    ids.push(item.id)
    paths.add(portableArtifact.key)
  }
  return new Set(ids).size === ids.length
    && [...ids].sort().every((id, index) => id === ids[index])
}

function verifyReleaseArtifactProof(proof, item, artifactSha256) {
  if (!hasExactKeys(proof, ['artifactId', 'sha256', 'pluginId', 'pluginApi', 'capabilities', 'proof'])) return false
  if (
    proof.artifactId !== item.id
    || proof.sha256 !== artifactSha256
    || proof.sha256 !== item.sha256
    || proof.pluginId !== item.pluginId
    || proof.pluginApi !== item.pluginApi
  ) return false
  if (!hasExactKeys(proof.capabilities, [
    'declared', 'readOnlyTool', 'readOnlyInvocationHash', 'runtimeRegistered', 'hash', 'runtimeVerified',
  ])) return false
  const capabilityProof = {
    declared: proof.capabilities.declared,
    readOnlyTool: proof.capabilities.readOnlyTool,
    readOnlyInvocationHash: proof.capabilities.readOnlyInvocationHash,
    runtimeRegistered: proof.capabilities.runtimeRegistered,
  }
  if (
    !validProofList(capabilityProof.declared)
    || !validProofList(capabilityProof.runtimeRegistered)
    || capabilityProof.readOnlyTool !== item.readOnlyTool.name
    || capabilityProof.readOnlyInvocationHash !== sha256Bytes(Buffer.from(canonicalJson({
      name: item.readOnlyTool.name,
      arguments: item.readOnlyTool.arguments,
    })))
    || !capabilityProof.declared.includes(capabilityProof.readOnlyTool)
    || !capabilityProof.runtimeRegistered.includes(capabilityProof.readOnlyTool)
    || !capabilityProof.declared.every((name) => capabilityProof.runtimeRegistered.includes(name))
    || proof.capabilities.hash !== sha256Bytes(Buffer.from(canonicalJson(capabilityProof)))
    || proof.capabilities.runtimeVerified !== true
  ) return false
  return hasExactKeys(proof.proof, RELEASE_PROOF_KEYS)
    && RELEASE_PROOF_KEYS.every((key) => proof.proof[key] === true)
}

export function verifyAuditAttestation({
  envelope,
  matrix,
  artifactSha256ById,
  executionRuntimeArchiveSha256,
  packageRuntimeArchiveSha256,
  packageTarget,
  env,
  now,
  workerLock = TRUSTED_WORKER_LOCK,
}) {
  try {
    if (!validReleaseMatrix(matrix)) return null
    if (!hasExactKeys(envelope, ['schemaVersion', 'keyId', 'payload', 'signature'])) return null
    if (envelope.schemaVersion !== 3 || envelope.keyId !== env.UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID) return null
    const payload = envelope.payload
    if (!hasExactKeys(payload, [
      'schemaVersion', 'release', 'matrix', 'artifacts', 'executionRuntime', 'packageRuntime', 'sandbox',
    ]) || payload.schemaVersion !== 3) return null
    if (!hasExactKeys(payload.release, [
      'nonce', 'commit', 'target', 'runId', 'issuedAt', 'expiresAt',
    ])) return null
    if (
      !canonicalBase64(payload.release.nonce, 32)
      || payload.release.nonce !== env.UNIOPC_PLUGIN_AUDIT_RELEASE_NONCE
      || payload.release.commit !== env.UNIOPC_PLUGIN_AUDIT_COMMIT
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(payload.release.commit)
      || payload.release.target !== env.UNIOPC_PLUGIN_AUDIT_TARGET
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]{2,127}$/.test(payload.release.target)
      || payload.release.runId !== env.UNIOPC_PLUGIN_AUDIT_RUN_ID
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(payload.release.runId)
    ) return null
    const issuedAt = Date.parse(payload.release.issuedAt)
    const expiresAt = Date.parse(payload.release.expiresAt)
    const nowTime = now.getTime()
    if (
      !Number.isFinite(issuedAt)
      || !Number.isFinite(expiresAt)
      || new Date(issuedAt).toISOString() !== payload.release.issuedAt
      || new Date(expiresAt).toISOString() !== payload.release.expiresAt
      || issuedAt > nowTime
      || expiresAt < nowTime
      || expiresAt <= issuedAt
      || expiresAt - issuedAt > 24 * 60 * 60 * 1000
    ) return null
    if (!hasExactKeys(payload.matrix, ['sha256', 'artifactCount'])) return null
    if (
      payload.matrix.sha256 !== sha256Bytes(Buffer.from(canonicalJson(matrix)))
      || payload.matrix.artifactCount !== matrix.artifacts.length
      || !Array.isArray(payload.artifacts)
      || payload.artifacts.length !== matrix.artifacts.length
    ) return null
    for (let index = 0; index < matrix.artifacts.length; index += 1) {
      const item = matrix.artifacts[index]
      if (!verifyReleaseArtifactProof(payload.artifacts[index], item, artifactSha256ById?.[item.id])) return null
    }
    const expectedExecutionPlatform = executionRuntimePlatformForWorker(payload.sandbox?.platform)
    if (!hasExactKeys(payload.executionRuntime, ['platform', 'openclawVersion', 'nodeVersion', 'inspectorVersion', 'archiveSha256'])) return null
    if (
      !expectedExecutionPlatform
      || payload.executionRuntime.platform !== expectedExecutionPlatform
      || payload.executionRuntime.openclawVersion !== HOST_VERSION
      || payload.executionRuntime.nodeVersion !== '24.19.0'
      || payload.executionRuntime.inspectorVersion !== INSPECTOR_VERSION
      || payload.executionRuntime.archiveSha256 !== executionRuntimeArchiveSha256
    ) return null
    if (!hasExactKeys(payload.packageRuntime, ['target', 'openclawVersion', 'nodeVersion', 'archiveSha256'])) return null
    if (
      payload.packageRuntime.target !== packageTarget
      || payload.packageRuntime.openclawVersion !== HOST_VERSION
      || payload.packageRuntime.nodeVersion !== '24.19.0'
      || payload.packageRuntime.archiveSha256 !== packageRuntimeArchiveSha256
    ) return null
    const trustedWorker = trustedWorkerForPlatform(workerLock, payload.sandbox?.platform)
    if (
      !trustedWorker
      || !hasExactKeys(payload.sandbox, ['enforced', 'kind', 'engine', 'image', 'platform', 'protocol'])
      || payload.sandbox.enforced !== true
      || payload.sandbox.kind !== 'linux-container'
      || !['docker', 'podman'].includes(payload.sandbox.engine)
      || payload.sandbox.image !== trustedWorker.image
      || payload.sandbox.platform !== trustedWorker.platform
      || canonicalJson(payload.sandbox.protocol) !== canonicalJson(trustedWorker.protocol)
    ) return null
    const signature = canonicalBase64(envelope.signature, 64)
    if (!signature) return null
    if (!verifySignature(
      null,
      Buffer.from(canonicalJson(payload)),
      attestationPublicKey(env.UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY),
      signature,
    )) return null
    return payload
  } catch {
    return null
  }
}

async function consumeReleaseNonce(payload, env) {
  const directory = String(env.UNIOPC_PLUGIN_AUDIT_CONSUMPTION_DIR || '').trim()
  if (!directory || !isAbsolute(directory)) return 'invalid'
  await mkdir(directory, { recursive: true })
  if (await pathContainsSymlink(directory)) return 'invalid'
  const directoryMetadata = await lstat(directory).catch(() => null)
  if (!directoryMetadata?.isDirectory() || directoryMetadata.isSymbolicLink()) return 'invalid'
  await chmod(directory, 0o700).catch(() => {})
  const resolvedDirectory = await realpath(directory).catch(() => null)
  const nonce = canonicalBase64(payload.release.nonce, 32)
  if (!resolvedDirectory || !nonce) return 'invalid'
  const digest = sha256Bytes(nonce)
  const recordPath = join(resolvedDirectory, `${digest}.consumed`)
  let handle
  try {
    handle = await open(recordPath, 'wx', 0o600)
    await handle.writeFile(`${canonicalJson({
      schemaVersion: 1,
      release: payload.release,
      envelopeSha256: sha256Bytes(Buffer.from(canonicalJson(payload))),
    })}\n`)
    await handle.sync()
    await handle.close()
    handle = null
    const directoryHandle = await open(resolvedDirectory, 'r').catch(() => null)
    await directoryHandle?.sync().catch(() => {})
    await directoryHandle?.close().catch(() => {})
    return 'consumed'
  } catch (error) {
    return error?.code === 'EEXIST' ? 'replayed' : 'invalid'
  } finally {
    await handle?.close().catch(() => {})
  }
}

function containerFailure(code = 'sandbox_unavailable') {
  return {
    schemaVersion: 1,
    ok: false,
    errors: [finding(code)],
    warnings: [],
  }
}

function containerImageDigest(image) {
  const match = String(image || '').match(/@((?:sha256:)[0-9a-f]{64})$/)
  return match?.[1] || null
}

export function buildContainerRunArguments({ image, inputRoot, target = 'linux/amd64' } = {}) {
  if (!containerImageDigest(image)) throw new TypeError('worker image must be pinned by sha256 digest')
  if (typeof inputRoot !== 'string' || !inputRoot.trim()) throw new TypeError('container input root is required')
  if (!/^linux\/(?:amd64|arm64)$/.test(target)) throw new TypeError('unsupported worker platform')
  const mount = `type=bind,src=${resolve(inputRoot)},dst=/audit-input,readonly`
  return [
    'run',
    '--rm',
    '--pull', 'never',
    '--platform', target,
    '--read-only',
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '128',
    '--memory', '1073741824',
    '--cpus', '2',
    '--user', '65532:65532',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=0700,uid=65532,gid=65532',
    '--tmpfs', '/audit-work:rw,nosuid,nodev,size=1073741824,mode=0700,uid=65532,gid=65532',
    '--mount', mount,
    image,
  ]
}

function sanitizedWorkerFailure(report) {
  if (!report || !Array.isArray(report.errors)) return null
  const errors = report.errors.flatMap((entry) => {
    const code = typeof entry?.code === 'string' && Object.hasOwn(messages, entry.code) ? entry.code : null
    if (!code) return []
    return [finding(code, publicIdentifier(entry.artifactId))]
  })
  if (errors.length === 0) return null
  sortFindings(errors)
  return { schemaVersion: 1, ok: false, errors, warnings: [] }
}

function containerClientEnvironment(env) {
  const next = {}
  for (const key of [
    'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT',
    'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
    'CONTAINER_HOST', 'CONTAINER_CONNECTION',
  ]) {
    if (Object.hasOwn(env, key) && String(env[key] || '').trim()) next[key] = env[key]
  }
  return next
}

async function availableContainerEngine(env, runCommand) {
  const configured = String(env.UNIOPC_PLUGIN_AUDIT_CONTAINER_ENGINE || '').trim().toLowerCase()
  const candidates = configured ? [configured] : ['docker', 'podman']
  if (candidates.some((engine) => !['docker', 'podman'].includes(engine))) return null
  const clientEnv = containerClientEnvironment(env)
  for (const engine of candidates) {
    try {
      const result = await runCommand({
        command: engine,
        args: ['version', '--format', '{{.Server.Version}}'],
        cwd: process.cwd(),
        env: clientEnv,
      })
      if (result?.code === 0 && String(result.stdout || '').trim()) return engine
    } catch {
      // Try the other supported engine. Missing/unreachable daemons are a
      // stable unavailable result and never authorize host execution.
    }
  }
  return null
}

function workerReportMatchesMatrix(report, matrix) {
  try {
    if (!report || report.schemaVersion !== 1 || report.ok !== true || !releaseMatrixPassed(report)) return false
    if (
      report.releaseMatrix.artifacts.length !== matrix.artifacts.length
      || report.compatibility.artifacts.length !== matrix.artifacts.length
      || report.capabilities.artifacts.length !== matrix.artifacts.length
    ) return false
    for (let index = 0; index < matrix.artifacts.length; index += 1) {
      const item = matrix.artifacts[index]
      const releaseState = report.releaseMatrix.artifacts[index]
      const compatibility = report.compatibility.artifacts[index]
      const capabilities = report.capabilities.artifacts[index]
      if (
        releaseState.artifactId !== publicIdentifier(item.id, 'release-artifact')
        || compatibility.artifactId !== releaseState.artifactId
        || compatibility.pluginId !== item.pluginId
        || compatibility.pluginApi !== item.pluginApi
        || compatibility.compatible !== true
        || !['builder', 'validator', 'inspector'].every((key) => compatibility.checks?.[key] === true)
        || capabilities.artifactId !== releaseState.artifactId
        || capabilities.runtimeVerified !== true
        || !Array.isArray(capabilities.declared)
        || !Array.isArray(capabilities.readOnlyDeclared)
        || !Array.isArray(capabilities.runtimeRegistered)
        || !capabilities.readOnlyDeclared.includes(item.readOnlyTool.name)
        || !capabilities.runtimeRegistered.includes(item.readOnlyTool.name)
        || !capabilities.declared.every((name) => capabilities.runtimeRegistered.includes(name))
      ) return false
    }
    return true
  } catch {
    return false
  }
}

function releaseMetadataFromEnvironment(env, now, nonce = randomBytes(32).toString('base64')) {
  const ciCommit = String(
    env.GITHUB_SHA || env.CI_COMMIT_SHA || env.BUILD_SOURCEVERSION || '',
  ).trim().toLowerCase()
  const ciRunId = String(
    env.GITHUB_RUN_ID || env.CI_PIPELINE_ID || env.BUILD_BUILDID || '',
  ).trim()
  const release = {
    nonce,
    commit: String(env.UNIOPC_PLUGIN_AUDIT_COMMIT || '').toLowerCase(),
    target: String(env.UNIOPC_PLUGIN_AUDIT_TARGET || ''),
    runId: String(env.UNIOPC_PLUGIN_AUDIT_RUN_ID || ''),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
  }
  if (
    !canonicalBase64(release.nonce, 32)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(release.commit)
    || !/^(?:darwin\/(?:arm64|x64)|win32\/x64|linux\/x64)$/.test(release.target)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(release.runId)
    || !ciCommit
    || release.commit !== ciCommit
    || !ciRunId
    || release.runId !== ciRunId
  ) return null
  return release
}

function attestationPrivateKey(value) {
  const raw = String(value || '').trim()
  if (raw.startsWith('-----BEGIN PRIVATE KEY-----')) return createPrivateKey(raw)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) {
    throw new TypeError('invalid private key')
  }
  const key = Buffer.from(raw, 'base64')
  if (key.toString('base64') !== raw) throw new TypeError('invalid private key')
  return createPrivateKey({ key, format: 'der', type: 'pkcs8' })
}

async function privateAuditKeyFromEnvironment(env) {
  const inline = String(env.UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY || '').trim()
  const path = String(env.UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY_PATH || '').trim()
  if (Boolean(inline) === Boolean(path)) throw new TypeError('exactly one audit private key source is required')
  return attestationPrivateKey(inline || await readFile(path, 'utf8'))
}

function createAttestationPayload({ matrix, report, executionRuntime, packageRuntime, release, engine, trustedWorker }) {
  return {
    schemaVersion: 3,
    release,
    matrix: {
      sha256: sha256Bytes(Buffer.from(canonicalJson(matrix))),
      artifactCount: matrix.artifacts.length,
    },
    artifacts: matrix.artifacts.map((item, index) => {
      const releaseState = report.releaseMatrix.artifacts[index]
      const compatibility = report.compatibility.artifacts[index]
      const capabilities = report.capabilities.artifacts[index]
      const capabilityProof = {
        declared: [...capabilities.declared].sort(),
        readOnlyTool: item.readOnlyTool.name,
        readOnlyInvocationHash: sha256Bytes(Buffer.from(canonicalJson({
          name: item.readOnlyTool.name,
          arguments: item.readOnlyTool.arguments,
        }))),
        runtimeRegistered: [...capabilities.runtimeRegistered].sort(),
      }
      return {
        artifactId: item.id,
        sha256: item.sha256,
        pluginId: item.pluginId,
        pluginApi: item.pluginApi,
        capabilities: {
          ...capabilityProof,
          hash: sha256Bytes(Buffer.from(canonicalJson(capabilityProof))),
          runtimeVerified: capabilities.runtimeVerified,
        },
        proof: {
          builder: compatibility.checks.builder,
          validator: compatibility.checks.validator,
          inspector: compatibility.checks.inspector,
          installed: releaseState.installed,
          enabled: releaseState.enabled,
          restarted: releaseState.restarted,
          runtimeInspected: releaseState.runtimeInspected,
          readOnlyInvoked: releaseState.readOnlyInvoked,
          disabled: releaseState.disabled,
          uninstalled: releaseState.uninstalled,
          cleaned: report.releaseMatrix.runtimeOwnership.cleaned,
        },
      }
    }),
    executionRuntime,
    packageRuntime,
    sandbox: {
      enforced: true,
      kind: 'linux-container',
      engine,
      image: trustedWorker.image,
      platform: trustedWorker.platform,
      protocol: trustedWorker.protocol,
    },
  }
}

async function writeAtomicAttestation(path, envelope) {
  const parent = dirname(path)
  if (await pathContainsSymlink(parent)) throw artifactError('artifact_path_invalid')
  const temporary = join(parent, `.attestation-${randomBytes(16).toString('hex')}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${canonicalJson(envelope)}\n`)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporary, path)
  } finally {
    await handle?.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function runContainerReleaseAudit({
  matrixPath,
  executionRuntimeArchivePath,
  packageRuntimeArchivePath,
  packageTarget,
  env = process.env,
  deps = {},
} = {}) {
  const runCommand = deps.runCommand || defaultRunCommand
  const verifyRuntimeContract = deps.verifyRuntimeContract || verifyReleaseContract
  const workerTarget = String(env.UNIOPC_PLUGIN_AUDIT_WORKER_PLATFORM || 'linux/amd64')
  const trustedWorker = trustedWorkerForPlatform(deps.workerLock || TRUSTED_WORKER_LOCK, workerTarget)
  if (!trustedWorker) return containerFailure()
  const configuredImage = String(env.UNIOPC_PLUGIN_AUDIT_WORKER_IMAGE || '').trim()
  if (configuredImage && configuredImage !== trustedWorker.image) return containerFailure()
  const image = trustedWorker.image
  const engine = await availableContainerEngine(env, runCommand)
  if (!engine) return containerFailure()

  const parent = String(env.TEMP || env.TMP || tmpdir())
  await mkdir(parent, { recursive: true })
  const inputRoot = await mkdtemp(join(parent, 'uniopc-container-audit-input-'))
  await chmod(inputRoot, 0o700).catch(() => {})
  try {
    let matrix
    try {
      const matrixSnapshot = await snapshotRegularFile(resolve(matrixPath), {
        outputDirectory: join(inputRoot, 'source-matrix'),
        maxBytes: 1024 * 1024,
      })
      matrix = JSON.parse(await readFile(matrixSnapshot.path, 'utf8'))
    } catch {
      return containerFailure('matrix_invalid')
    }
    if (!validReleaseMatrix(matrix)) return containerFailure('matrix_invalid')
    const baseDir = dirname(resolve(matrixPath))
    const artifactPaths = await canonicalReleaseArtifactPaths(matrix, baseDir)
    if (!artifactPaths) return containerFailure('matrix_invalid')

    const resolvedExecutionRuntime = resolve(String(executionRuntimeArchivePath || ''))
    const resolvedPackageRuntime = resolve(String(packageRuntimeArchivePath || ''))
    if (!executionRuntimeArchivePath || !packageRuntimeArchivePath || resolvedExecutionRuntime === resolvedPackageRuntime) {
      return containerFailure('attestation_invalid')
    }
    let executionRuntimeSnapshot
    let packageRuntimeSnapshot
    try {
      executionRuntimeSnapshot = await snapshotRegularFile(resolvedExecutionRuntime, {
        outputDirectory: join(inputRoot, 'execution-runtime'),
        maxBytes: 512 * 1024 * 1024,
      })
      packageRuntimeSnapshot = await snapshotRegularFile(resolvedPackageRuntime, {
        outputDirectory: join(inputRoot, 'package-runtime'),
        maxBytes: 512 * 1024 * 1024,
      })
    } catch {
      return containerFailure('runtime_environment_missing')
    }
    let executionRuntime
    let packageRuntime
    try {
      executionRuntime = await verifiedRuntimeIdentity({
        snapshot: executionRuntimeSnapshot,
        target: executionRuntimeTargetForWorker(workerTarget),
        runtimeDirectory: dirname(resolvedExecutionRuntime),
        verifyRuntimeContract,
      })
      packageRuntime = await verifiedRuntimeIdentity({
        snapshot: packageRuntimeSnapshot,
        target: runtimeTargetFromAuditTarget(packageTarget),
        runtimeDirectory: dirname(resolvedPackageRuntime),
        verifyRuntimeContract,
      })
    } catch {
      return containerFailure('runtime_environment_missing')
    }

    const workerArtifacts = []
    for (const item of matrix.artifacts) {
      const artifactPath = artifactPaths.get(item.id)
      if (!artifactPath) return containerFailure('artifact_path_invalid')
      let snapshot
      try {
        snapshot = await snapshotRegularFile(artifactPath, {
          outputDirectory: join(inputRoot, 'artifacts', item.id),
        })
      } catch (error) {
        return containerFailure(error?.code === 'artifact_size_exceeded' ? error.code : 'artifact_path_invalid')
      }
      if (snapshot.sha256 !== item.sha256) return containerFailure('artifact_sha_mismatch')
      workerArtifacts.push({
        ...item,
        artifact: relative(inputRoot, snapshot.path).replaceAll('\\', '/'),
      })
    }
    const workerMatrix = { ...matrix, artifacts: workerArtifacts }
    const workerMatrixBytes = Buffer.from(`${canonicalJson(workerMatrix)}\n`)
    const workerMatrixPath = join(inputRoot, `${sha256Bytes(workerMatrixBytes)}.matrix.json`)
    await writeFile(workerMatrixPath, workerMatrixBytes, { mode: 0o400, flag: 'wx' })
    await sealContainerInputTree(inputRoot)

    let args
    try {
      args = buildContainerRunArguments({ image, inputRoot, target: workerTarget })
    } catch {
      return containerFailure()
    }
    args.push(
      'audit-release-matrix',
      '--matrix', `/audit-input/${relative(inputRoot, workerMatrixPath).replaceAll('\\', '/')}`,
      '--runtime', `/audit-input/${relative(inputRoot, executionRuntimeSnapshot.path).replaceAll('\\', '/')}`,
      '--work', '/audit-work',
      '--protocol', trustedWorker.protocol.id,
      '--protocol-version', String(trustedWorker.protocol.version),
      '--report-schema-version', String(trustedWorker.protocol.reportSchemaVersion),
    )
    let result
    try {
      result = await runCommand({
        command: engine,
        args,
        cwd: process.cwd(),
        env: containerClientEnvironment(env),
      })
    } catch {
      return containerFailure()
    }
    const workerReport = safeParseJson(result?.stdout)
    if (result?.code !== 0 || !workerReport?.ok) {
      return sanitizedWorkerFailure(workerReport) || containerFailure()
    }
    if (!workerReportMatchesMatrix(workerReport, matrix)) return containerFailure('attestation_invalid')

    const now = deps.now?.() || new Date()
    const release = releaseMetadataFromEnvironment(env, now)
    const keyId = String(env.UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID || '').trim()
    if (!release || !publicIdentifier(keyId)) return containerFailure('attestation_invalid')

    // The private audit key is intentionally read only after the hardened
    // container has exited and its complete report has passed host validation.
    let privateKey
    try {
      privateKey = await privateAuditKeyFromEnvironment(env)
    } catch {
      return containerFailure('attestation_invalid')
    }
    const payload = createAttestationPayload({
      matrix,
      report: workerReport,
      executionRuntime: {
        platform: executionRuntime.target,
        openclawVersion: executionRuntime.openclawVersion,
        nodeVersion: executionRuntime.nodeVersion,
        inspectorVersion: INSPECTOR_VERSION,
        archiveSha256: executionRuntime.archiveSha256,
      },
      packageRuntime: {
        target: packageRuntime.target,
        openclawVersion: packageRuntime.openclawVersion,
        nodeVersion: packageRuntime.nodeVersion,
        archiveSha256: packageRuntime.archiveSha256,
      },
      release,
      engine,
      trustedWorker,
    })
    const envelope = {
      schemaVersion: 3,
      keyId,
      payload,
      signature: signPayload(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64'),
    }
    const attestationPath = artifactPathWithin(baseDir, matrix.attestation)
    if (!attestationPath) return containerFailure('attestation_invalid')
    try {
      await writeAtomicAttestation(attestationPath, envelope)
    } catch {
      return containerFailure('attestation_invalid')
    }
    return {
      schemaVersion: 1,
      ok: true,
      errors: [],
      warnings: [],
      attestationPath,
      envelope,
      report: workerReport,
    }
  } finally {
    await removeSealedContainerInputTree(inputRoot).catch(() => {})
  }
}

function emptyReleaseReport() {
  return {
    schemaVersion: 1,
    ok: false,
    errors: [],
    warnings: [],
    compatibility: { hostVersion: HOST_VERSION, artifacts: [] },
    capabilities: { artifacts: [] },
    releaseMatrix: {
      runtimeOwnership: { mode: 'signed-sandbox-attestation', cleaned: false },
      artifacts: [],
    },
  }
}

export async function auditPluginRelease({
  matrixPath,
  executionRuntimeArchivePath,
  packageRuntimeArchivePath,
  packageTarget,
  reportPath = resolve('dist', 'release-artifacts', 'plugin-audit-report.json'),
  env = process.env,
  deps = {},
} = {}) {
  const report = emptyReleaseReport()
  const absoluteMatrix = String(matrixPath || '').trim() ? resolve(matrixPath) : ''
  if (!absoluteMatrix || !await pathExists(absoluteMatrix)) {
    report.errors.push(finding('artifact_missing'))
    await writeSanitizedReport(reportPath, report)
    return report
  }
  if (![
    env.UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY,
    env.UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID,
    env.UNIOPC_PLUGIN_AUDIT_RELEASE_NONCE,
    env.UNIOPC_PLUGIN_AUDIT_COMMIT,
    env.UNIOPC_PLUGIN_AUDIT_TARGET,
    env.UNIOPC_PLUGIN_AUDIT_RUN_ID,
    env.UNIOPC_PLUGIN_AUDIT_CONSUMPTION_DIR,
  ].every((value) => String(value || '').trim())) {
    report.errors.push(finding('attestation_missing'))
    await writeSanitizedReport(reportPath, report)
    return report
  }

  const controllerParent = String(env.TEMP || env.TMP || tmpdir())
  await mkdir(controllerParent, { recursive: true })
  const controllerRoot = await mkdtemp(join(controllerParent, 'uniopc-release-inputs-'))
  await chmod(controllerRoot, 0o700).catch(() => {})
  const finish = async () => {
    sortFindings(report.errors)
    report.ok = releaseMatrixPassed(report)
    await writeSanitizedReport(reportPath, report)
    return report
  }
  try {
    let matrix
    try {
      const snapshot = await snapshotRegularFile(absoluteMatrix, {
        outputDirectory: join(controllerRoot, 'matrix'),
        maxBytes: 1024 * 1024,
      })
      matrix = JSON.parse(await readFile(snapshot.path, 'utf8'))
    } catch {
      report.errors.push(finding('matrix_invalid'))
      return finish()
    }
    if (!validReleaseMatrix(matrix)) {
      report.errors.push(finding(Array.isArray(matrix?.artifacts) && matrix.artifacts.length === 0 ? 'matrix_empty' : 'matrix_invalid'))
      return finish()
    }
    const baseDir = dirname(absoluteMatrix)
    const artifactPaths = await canonicalReleaseArtifactPaths(matrix, baseDir)
    if (!artifactPaths) {
      report.errors.push(finding('matrix_invalid'))
      return finish()
    }
    if (
      !executionRuntimeArchivePath
      || !packageRuntimeArchivePath
      || resolve(executionRuntimeArchivePath) === resolve(packageRuntimeArchivePath)
      || !await pathExists(executionRuntimeArchivePath)
      || !await pathExists(packageRuntimeArchivePath)
    ) {
      report.errors.push(finding('runtime_environment_missing'))
      return finish()
    }

    let executionRuntimeSnapshot
    let packageRuntimeSnapshot
    try {
      executionRuntimeSnapshot = await snapshotRegularFile(executionRuntimeArchivePath, {
        outputDirectory: join(controllerRoot, 'execution-runtime'),
        maxBytes: 512 * 1024 * 1024,
      })
      packageRuntimeSnapshot = await snapshotRegularFile(packageRuntimeArchivePath, {
        outputDirectory: join(controllerRoot, 'package-runtime'),
        maxBytes: 512 * 1024 * 1024,
      })
    } catch {
      report.errors.push(finding('runtime_environment_missing'))
      return finish()
    }

    const artifactSha256ById = {}
    const releaseStates = new Map()
    for (const item of matrix.artifacts) {
      const artifactId = publicIdentifier(item.id, 'release-artifact')
      const releaseState = {
        artifactId,
        sha256Verified: false,
        identityVerified: false,
        compatibilityVerified: false,
        installed: false,
        enabled: false,
        restarted: false,
        runtimeInspected: false,
        readOnlyInvoked: false,
        disabled: false,
        uninstalled: false,
      }
      report.releaseMatrix.artifacts.push(releaseState)
      releaseStates.set(item.id, releaseState)
      const artifactPath = artifactPaths.get(item.id)
      if (!artifactPath) {
        addStepFailure(report, 'artifact_path_invalid', artifactId)
        continue
      }
      try {
        const snapshot = await snapshotRegularFile(artifactPath, {
          outputDirectory: join(controllerRoot, 'artifacts', artifactId),
        })
        artifactSha256ById[item.id] = snapshot.sha256
        if (snapshot.sha256 !== item.sha256) {
          addStepFailure(report, 'artifact_sha_mismatch', artifactId)
          continue
        }
        releaseState.sha256Verified = true
      } catch (error) {
        const code = error?.code === 'artifact_size_exceeded'
          ? 'artifact_size_exceeded'
          : error?.code === 'artifact_integrity_changed'
            ? 'artifact_integrity_changed'
            : 'artifact_path_invalid'
        addStepFailure(report, code, artifactId)
      }
    }
    if (report.errors.length) return finish()

    const attestationPath = artifactPathWithin(baseDir, matrix.attestation)
    let envelope
    try {
      if (!attestationPath) throw artifactError('artifact_path_invalid')
      const snapshot = await snapshotRegularFile(attestationPath, {
        outputDirectory: join(controllerRoot, 'attestation'),
        maxBytes: 1024 * 1024,
      })
      envelope = JSON.parse(await readFile(snapshot.path, 'utf8'))
    } catch {
      report.errors.push(finding('attestation_missing'))
      return finish()
    }
    const payload = verifyAuditAttestation({
      envelope,
      matrix,
      artifactSha256ById,
      executionRuntimeArchiveSha256: executionRuntimeSnapshot.sha256,
      packageRuntimeArchiveSha256: packageRuntimeSnapshot.sha256,
      packageTarget,
      env,
      now: deps.now?.() || new Date(),
      workerLock: deps.workerLock || TRUSTED_WORKER_LOCK,
    })
    if (!payload) {
      report.errors.push(finding('attestation_invalid'))
      return finish()
    }
    const consumption = deps.consumeReleaseNonce
      ? await deps.consumeReleaseNonce(payload, env)
      : await consumeReleaseNonce(payload, env)
    if (consumption !== 'consumed') {
      report.errors.push(finding(consumption === 'replayed' ? 'attestation_replayed' : 'attestation_invalid'))
      return finish()
    }

    for (let index = 0; index < matrix.artifacts.length; index += 1) {
      const item = matrix.artifacts[index]
      const artifactPayload = payload.artifacts[index]
      const releaseState = releaseStates.get(item.id)
      releaseState.identityVerified = true
      releaseState.compatibilityVerified = true
      for (const key of [
        'installed', 'enabled', 'restarted', 'runtimeInspected', 'readOnlyInvoked', 'disabled', 'uninstalled',
      ]) releaseState[key] = artifactPayload.proof[key]
      report.compatibility.artifacts.push({
        artifactId: releaseState.artifactId,
        pluginId: publicIdentifier(artifactPayload.pluginId, 'runtime-plugin'),
        pluginApi: publicRequirement(artifactPayload.pluginApi),
        hostVersion: HOST_VERSION,
        compatible: true,
        checks: {
          builder: artifactPayload.proof.builder,
          validator: artifactPayload.proof.validator,
          inspector: artifactPayload.proof.inspector,
        },
      })
      report.capabilities.artifacts.push({
        artifactId: releaseState.artifactId,
        declared: artifactPayload.capabilities.declared.map((name) => publicIdentifier(name, 'runtime-capability')),
        readOnlyDeclared: [publicIdentifier(artifactPayload.capabilities.readOnlyTool, 'runtime-capability')],
        runtimeRegistered: artifactPayload.capabilities.runtimeRegistered.map((name) => publicIdentifier(name, 'runtime-capability')),
        runtimeVerified: artifactPayload.capabilities.runtimeVerified,
      })
    }
    report.releaseMatrix.runtimeOwnership.cleaned = payload.artifacts.every((item) => item.proof.cleaned)
    return finish()
  } finally {
    await rm(controllerRoot, { recursive: true, force: true }).catch(() => {})
  }
}

async function main() {
  const target = process.argv[2]
  if (!target) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      ok: false,
      errors: [finding('artifact_missing')],
      warnings: [],
      compatibility: { hostVersion: HOST_VERSION, artifacts: [] },
      capabilities: { artifacts: [] },
    })}\n`)
    process.exitCode = 1
    return
  }
  if (target === '--produce-release-attestation') {
    const report = await runContainerReleaseAudit({
      matrixPath: process.argv[3],
      executionRuntimeArchivePath: process.argv[4],
      packageRuntimeArchivePath: process.argv[5],
      packageTarget: process.argv[6],
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = report.ok ? 0 : 1
    return
  }
  if (target === '--verify-release-attestation') {
    const report = await auditPluginRelease({
      matrixPath: process.argv[3],
      executionRuntimeArchivePath: process.argv[4],
      packageRuntimeArchivePath: process.argv[5],
      packageTarget: process.argv[6],
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = report.ok ? 0 : 1
    return
  }
  const report = await auditTarget(target)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.ok ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      ok: false,
      errors: [finding('manifest_invalid')],
      warnings: [],
      compatibility: { hostVersion: HOST_VERSION, artifacts: [] },
      capabilities: { artifacts: [] },
    })}\n`)
    process.exitCode = 1
  })
}
