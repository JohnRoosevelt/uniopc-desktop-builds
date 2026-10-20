import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'

import { ENGINE_COMMANDS } from './engine/contracts.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const desktopRoot = path.resolve(__dirname, '../..')
const traverse = traverseModule.default ?? traverseModule

export const mainSmokeCaseIds = [
  'app-shell',
  'auth-workspace-bootstrap',
  'conversations',
  'cloud-workbench',
  'cloud-project-flow',
  'cloud-documents',
  'cloud-document-flow',
  'app-center',
  'employees',
  'employees-permissions',
  'plugins',
  'mcp-hub',
  'operations',
  'models',
  'model-provider-settings',
  'settings',
  'settings-persistence',
  'desktop-release-readiness',
]

export const endToEndDimensionIds = [
  'app-shell',
  'auth-workspace',
  'local-openclaw-runtime',
  'remote-gateway',
  'conversation',
  'employees-permissions',
  'plugins-mcp',
  'cloud-workbench-documents',
  'app-center-business',
  'models-providers',
  'settings-persistence',
  'security-policy',
  'packaging-update',
]

export const releaseBehaviorAssertionIds = [
  'release-model-identity',
  'release-session-ownership',
  'release-plugin-catalog',
  'release-local-workspace-tool',
  'release-truthful-error',
]

export const releaseBehaviorSurfaces = [
  {
    id: 'release-model-identity',
    commands: ['conversation_load_history'],
    smokeCases: ['conversations', 'conversation-stream'],
  },
  {
    id: 'release-session-ownership',
    commands: ['conversation_list_sessions'],
    smokeCases: ['conversations', 'conversation-stream'],
  },
  {
    id: 'release-plugin-catalog',
    commands: ['openclaw_profile_tool_capabilities_list'],
    smokeCases: ['mcp-hub', 'plugin-mcp-tool-sync'],
  },
  {
    id: 'release-local-workspace-tool',
    commands: [
      'local_document_create',
      'local_documents_list',
      'conversation_send_turn',
      'conversation_load_history',
      'local_document_archive',
    ],
    smokeCases: ['conversations', 'plugin-mcp-tool-sync'],
  },
  {
    id: 'release-truthful-error',
    commands: ['conversation_send_turn'],
    smokeCases: ['conversations', 'conversation-stream'],
  },
]

export const officialParitySurfaces = [
  {
    id: 'gateway-runtime',
    commands: [
      'openclaw_connection_snapshot',
      'openclaw_connection_start_local',
      'openclaw_connection_stop_local',
      'openclaw_status',
    ],
    smokeCases: ['models', 'operations', 'openclaw-gateway-readiness'],
    testFiles: [
      'OpenClawRuntime.source.test.mjs',
    ],
  },
  {
    id: 'conversation-ipc',
    commands: [
      'conversation_load_history',
      'conversation_send_turn',
      'conversation_subscribe_session',
      'conversation_abort_turn',
    ],
    smokeCases: ['conversations', 'conversation-stream'],
    testFiles: [
      'ConversationsGatewayEvents.source.test.mjs',
      'conversationStore.test.mjs',
    ],
  },
  {
    id: 'plugin-policy',
    commands: [
      'openclaw_profile_plugins_list',
      'openclaw_profile_plugin_set',
      'openclaw_profile_tool_capabilities_list',
      'openclaw_mcp_servers_list',
    ],
    smokeCases: ['plugins', 'mcp-hub', 'plugin-mcp-tool-sync'],
    testFiles: [
      'profilePluginConsistency.test.mjs',
      'mcpConfig.test.mjs',
    ],
  },
  {
    id: 'browser-runtime',
    commands: [
      'openclaw_browser_runtime_snapshot',
      'openclaw_browser_runtime_set_enabled',
      'openclaw_browser_action',
    ],
    smokeCases: ['conversations'],
    testFiles: [
      'openclawBrowserRuntime.source.test.mjs',
      'tauriMockIpc.test.mjs',
    ],
  },
  {
    id: 'workspace-projects',
    commands: [
      'openclaw_agents_list',
    ],
    smokeCases: ['cloud-workbench', 'employees'],
    testFiles: [
      'desktopTestArchitecture.test.mjs',
      'employeeDirectory.test.mjs',
    ],
  },
]

function read(relativePath) {
  return fs.readFileSync(path.join(desktopRoot, relativePath), 'utf8')
}

function walkFiles(dir, predicate, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === 'dist') continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(fullPath, predicate, files)
    } else if (predicate(fullPath)) {
      files.push(fullPath)
    }
  }
  return files
}

export function extractRegisteredCommands(source) {
  const match = source.match(/tauri::generate_handler!\[([\s\S]*?)\]\)/)
  if (!match) return []

  return [...match[1].matchAll(/commands(?:::[a-zA-Z0-9_]+)+/g)]
    .map(item => item[0].split('::').at(-1))
    .sort()
}

export function extractFrontendInvokeCommands(source) {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript', 'importAttributes'],
  })
  const invokeBindings = new Set(['invoke', 'invokeWithTimeout'])
  const registryBindings = new Set()
  const initializers = new Map()

  traverse(ast, {
    ImportDeclaration(path) {
      const sourceName = path.node.source.value
      for (const specifier of path.node.specifiers) {
        if (specifier.type !== 'ImportSpecifier') continue
        const importedName = specifier.imported.name ?? specifier.imported.value
        if (sourceName === '@tauri-apps/api/core' && importedName === 'invoke') {
          invokeBindings.add(specifier.local.name)
        }
        if (sourceName.includes('tauriInvokeTimeout') && importedName === 'invokeWithTimeout') {
          invokeBindings.add(specifier.local.name)
        }
        if (sourceName.endsWith('/engine/contracts.js')
          || sourceName.endsWith('/engine/contracts')
          || sourceName === './contracts.js') {
          if (importedName === 'ENGINE_COMMANDS') registryBindings.add(specifier.local.name)
        }
      }
    },
    VariableDeclarator(path) {
      if (path.node.id.type === 'Identifier' && path.node.init) {
        initializers.set(path.node.id.name, path.node.init)
      }
    },
  })

  function evaluate(node, seen = new Set()) {
    if (!node) return undefined
    if (node.type === 'StringLiteral') return node.value
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
      return node.quasis[0]?.value?.cooked ?? ''
    }
    if (node.type === 'Identifier') {
      if (registryBindings.has(node.name)) return ENGINE_COMMANDS
      if (seen.has(node.name)) return undefined
      const initializer = initializers.get(node.name)
      if (!initializer) return undefined
      return evaluate(initializer, new Set([...seen, node.name]))
    }
    if (node.type === 'ObjectExpression') {
      return Object.fromEntries(node.properties.flatMap(property => {
        if (property.type !== 'ObjectProperty') return []
        const key = property.computed
          ? evaluate(property.key, seen)
          : property.key.name ?? property.key.value
        return typeof key === 'string' ? [[key, evaluate(property.value, seen)]] : []
      }))
    }
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      const object = evaluate(node.object, seen)
      const key = node.computed ? evaluate(node.property, seen) : node.property.name
      return object && typeof key === 'string' ? object[key] : undefined
    }
    return undefined
  }

  function isInvokeBinding(node, seen = new Set()) {
    if (node?.type !== 'Identifier') return false
    if (invokeBindings.has(node.name)) return true
    if (seen.has(node.name)) return false
    const initializer = initializers.get(node.name)
    return isInvokeBinding(initializer, new Set([...seen, node.name]))
  }

  const commands = []
  traverse(ast, {
    CallExpression(path) {
      const { callee, arguments: args } = path.node
      let commandNode = null
      if (isInvokeBinding(callee)) commandNode = args[0]
      if (callee.type === 'Identifier' && callee.name === 'commandMethod') commandNode = args[1]
      if (callee.type === 'Identifier' && callee.name === 'call') commandNode = args[0]
      const command = evaluate(commandNode)
      if (typeof command === 'string' && /^[a-zA-Z0-9_]+$/.test(command)) commands.push(command)
    },
  })
  return [...new Set(commands)].sort()
}

export function extractEngineClientCommands() {
  return Object.values(ENGINE_COMMANDS)
    .flatMap(commands => Object.values(commands))
    .sort()
}

export function extractSmokeCaseIds(source) {
  const match = source.match(/export const DEFAULT_SMOKE_CASES = \[([\s\S]*?)\]\n\nexport const E2E_TEST_DIMENSIONS/)
  const smokeSource = match ? match[1] : source
  return [...smokeSource.matchAll(/\bid:\s*['"]([a-zA-Z0-9_-]+)['"]/g)]
    .map(item => item[1])
    .sort()
}

export function extractEndToEndDimensionIds(source) {
  const match = source.match(/export const E2E_TEST_DIMENSIONS = \[([\s\S]*?)\]\n/)
  const dimensionSource = match ? match[1] : ''
  return [...dimensionSource.matchAll(/\bid:\s*['"]([a-zA-Z0-9_-]+)['"]/g)]
    .map(item => item[1])
    .sort()
}

export function extractReleaseBehaviorAssertionIds(source) {
  const match = source.match(/export const RELEASE_BEHAVIOR_CASES = \[([\s\S]*?)\]\n\nconst RELEASE_BEHAVIOR_ENV/)
  const behaviorSource = match ? match[1] : ''
  return [...behaviorSource.matchAll(/\bid:\s*['"]([a-zA-Z0-9_-]+)['"]/g)]
    .map(item => item[1])
    .sort()
}

export function collectDesktopTestArchitecture() {
  const registeredCommands = extractRegisteredCommands(read('src-tauri/src/lib.rs'))
  const registeredSet = new Set(registeredCommands)

  const frontendSources = walkFiles(
    path.join(desktopRoot, 'src'),
    file => /\.(js|jsx|mjs|ts|tsx)$/.test(file) && !file.endsWith('.test.mjs'),
  )
  const frontendInvokeCommands = [
    ...new Set(frontendSources.flatMap(file => extractFrontendInvokeCommands(fs.readFileSync(file, 'utf8')))),
  ].sort()
  const engineClientCommands = extractFrontendInvokeCommands(read('src/lib/engine/client.js'))

  const smokeCaseIds = extractSmokeCaseIds(read('scripts/e2e-tauri.mjs'))
  const e2eDimensionIds = extractEndToEndDimensionIds(read('scripts/e2e-tauri.mjs'))
  const releaseBehaviorAssertionIds = extractReleaseBehaviorAssertionIds(read('scripts/e2e-tauri.mjs'))
  const testFiles = walkFiles(
    path.join(desktopRoot, 'src'),
    file => file.endsWith('.test.mjs'),
  )
    .map(file => path.relative(desktopRoot, file))
    .sort()
    .concat(['scripts/e2e-tauri.test.mjs', 'scripts/test-desktop.test.mjs'])

  return {
    registeredCommands,
    e2eDimensionIds,
    engineClientCommands,
    frontendInvokeCommands,
    releaseBehaviorAssertionIds,
    smokeCaseIds,
    testFiles,
    unregisteredFrontendInvokes: frontendInvokeCommands
      .filter(command => !registeredSet.has(command)),
  }
}
