import { callLocalDocument as defaultCallLocalDocument } from './local-document-api.js'

const TOOL_PLUGIN_METADATA = Symbol.for('openclaw.plugin-sdk.tool-plugin.metadata')
const emptyConfigSchema = {
  safeParse(value: unknown) {
    if (value === undefined) return { success: true as const, data: undefined }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0) {
      return { success: false as const, error: { issues: [{ path: [], message: 'config must be empty' }] } }
    }
    return { success: true as const, data: value }
  },
  jsonSchema: { type: 'object' as const, additionalProperties: false, properties: {} },
}

type ToolDefinition = {
  name: string
  label?: string
  description: string
  parameters: typeof schemas[keyof typeof schemas]
  optional?: boolean
  factory: (context: { toolContext: object }) => unknown
}

function jsonResult(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload }
}

function defineSelfContainedToolPlugin(definition: {
  id: string
  name: string
  description: string
  tools: (tool: (definition: ToolDefinition) => ToolDefinition) => ToolDefinition[]
}) {
  const tools = definition.tools((tool) => tool)
  const entry = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    configSchema: emptyConfigSchema,
    register(api: { registerTool: (tool: unknown, options: { name: string; optional?: boolean }) => void }) {
      for (const definition of tools) {
        api.registerTool(
          (toolContext: object) => definition.factory({ toolContext }),
          { name: definition.name, ...(definition.optional ? { optional: true } : {}) },
        )
      }
    },
  }
  Object.defineProperty(entry, TOOL_PLUGIN_METADATA, {
    value: {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      activation: { onStartup: true },
      configSchema: emptyConfigSchema.jsonSchema,
      tools: tools.map((tool) => ({
        name: tool.name,
        label: tool.label ?? tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.optional ? { optional: true } : {}),
      })),
    },
    enumerable: false,
  })
  return entry
}

const TOOL_NAMES = {
  list: 'uniopc_local_documents_list',
  get: 'uniopc_local_document_get',
  create: 'uniopc_local_document_create',
  update: 'uniopc_local_document_update',
} as const
const WRITE_TOOL_NAMES = [TOOL_NAMES.create, TOOL_NAMES.update] as const

type LocalDocumentAction = typeof TOOL_NAMES[keyof typeof TOOL_NAMES]
type LocalDocumentCaller = (
  action: LocalDocumentAction,
  payload: Record<string, unknown>,
  options: { runtimeContext: object; signal?: AbortSignal },
) => Promise<unknown>
type ToolAnnotations = {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const createAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}
const updateAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
}

const schemas = {
  list: { type: 'object' as const, properties: { category: { type: 'string' as const, description: 'Local document category.' } }, additionalProperties: false, required: [] },
  get: { type: 'object' as const, properties: { id: { type: 'string' as const, description: 'Local document id.' } }, additionalProperties: false, required: ['id'] },
  create: { type: 'object' as const, properties: { title: { type: 'string' as const, description: 'Local document title.' }, category: { type: 'string' as const, description: 'Local document category.' }, markdown: { type: 'string' as const, description: 'Markdown document content. Use headings, paragraphs, lists, and tables normally; do not generate BlockSuite JSON or CRDT data.' }, metadata: { type: 'object' as const, additionalProperties: true, description: 'Optional local document metadata.' } }, additionalProperties: false, required: ['title', 'category', 'markdown'] },
  update: { type: 'object' as const, properties: { id: { type: 'string' as const, description: 'Local document id.' }, title: { type: 'string' as const, description: 'Local document title.' }, category: { type: 'string' as const, description: 'Local document category.' }, markdown: { type: 'string' as const, description: 'Markdown document content. Use headings, paragraphs, lists, and tables normally; do not generate BlockSuite JSON or CRDT data.' }, metadata: { type: 'object' as const, additionalProperties: true, description: 'Optional local document metadata.' }, baseHash: { type: 'string' as const, description: 'Current content hash read before editing.' } }, additionalProperties: false, required: ['id', 'title', 'category', 'markdown', 'baseHash'] },
} as const

function localDocumentTool({
  action,
  description,
  parameters,
  annotations,
  caller,
}: {
  action: LocalDocumentAction
  description: string
  parameters: typeof schemas[keyof typeof schemas]
  annotations: ToolAnnotations
  caller: LocalDocumentCaller
}) {
  return {
    name: action,
    description,
    parameters,
    factory: ({ toolContext }: { toolContext: object }) => ({
      name: action,
      label: action,
      description,
      parameters,
      annotations,
      async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
        return jsonResult(await caller(action, params, { runtimeContext: toolContext, signal }))
      },
    }),
  }
}

export function createLocalWorkspaceEntry({
  callLocalDocument = defaultCallLocalDocument as LocalDocumentCaller,
}: {
  callLocalDocument?: LocalDocumentCaller
} = {}) {
  const entry = defineSelfContainedToolPlugin({
    id: 'uniopc-local-workspace',
    name: '本地工作区',
    description: 'Expose local Uniopc desktop documents through an authenticated loopback bridge.',
    tools: (tool) => [
      tool(localDocumentTool({
        action: TOOL_NAMES.list,
        description: 'List local document metadata in the current Uniopc desktop profile.',
        parameters: schemas.list,
        annotations: readOnlyAnnotations,
        caller: callLocalDocument,
      })),
      tool(localDocumentTool({
        action: TOOL_NAMES.get,
        description: 'Read a local document authorized by an explicit @ document reference or a user-requested / local-workspace call for this runtime turn.',
        parameters: schemas.get,
        annotations: readOnlyAnnotations,
        caller: callLocalDocument,
      })),
      tool(localDocumentTool({
        action: TOOL_NAMES.create,
        description: 'Create a formatted local document from Markdown in the current Uniopc desktop profile. Do not generate BlockSuite JSON or CRDT data.',
        parameters: schemas.create,
        annotations: createAnnotations,
        caller: callLocalDocument,
      })),
      tool(localDocumentTool({
        action: TOOL_NAMES.update,
        description: 'Update an authorized local document from Markdown using content-hash conflict checking. Do not generate BlockSuite JSON or CRDT data.',
        parameters: schemas.update,
        annotations: updateAnnotations,
        caller: callLocalDocument,
      })),
    ],
  })
  const registerTools = entry.register
  entry.register = (api: {
    registerTool: (tool: unknown, options: { name: string; optional?: boolean }) => void
    on: (hookName: string, handler: (event: { toolName: string }) => unknown, options: { matcher: readonly string[] }) => void
  }) => {
    registerTools(api)
    // The desktop bridge grants a direct `/plugin:uniopc-local-workspace`
    // invocation only to its current profile, session and run. Use that
    // one-turn user consent rather than OpenClaw's generic approval broker:
    // `gateway run --auth password` in OpenClaw 2026.8.1 has no broker route,
    // so `requireApproval` would fail before the authenticated bridge can
    // evaluate the grant.
  }
  return entry
}

export default createLocalWorkspaceEntry()
