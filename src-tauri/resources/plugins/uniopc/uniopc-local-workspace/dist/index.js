import { callLocalDocument as defaultCallLocalDocument } from './local-document-api.js';
const TOOL_PLUGIN_METADATA = Symbol.for('openclaw.plugin-sdk.tool-plugin.metadata');
const emptyConfigSchema = {
    safeParse(value) {
        if (value === undefined)
            return { success: true, data: undefined };
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0) {
            return { success: false, error: { issues: [{ path: [], message: 'config must be empty' }] } };
        }
        return { success: true, data: value };
    },
    jsonSchema: { type: 'object', additionalProperties: false, properties: {} },
};
function jsonResult(payload) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload };
}
function defineSelfContainedToolPlugin(definition) {
    const tools = definition.tools((tool) => tool);
    const entry = {
        id: definition.id,
        name: definition.name,
        description: definition.description,
        configSchema: emptyConfigSchema,
        register(api) {
            for (const definition of tools) {
                api.registerTool((toolContext) => definition.factory({ toolContext }), { name: definition.name, ...(definition.optional ? { optional: true } : {}) });
            }
        },
    };
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
    });
    return entry;
}
const TOOL_NAMES = {
    list: 'uniopc_local_documents_list',
    get: 'uniopc_local_document_get',
    create: 'uniopc_local_document_create',
    update: 'uniopc_local_document_update',
};
const WRITE_TOOL_NAMES = [TOOL_NAMES.create, TOOL_NAMES.update];
const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};
const createAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
};
const updateAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
};
const schemas = {
    list: { type: 'object', properties: { category: { type: 'string', description: 'Local document category.' } }, additionalProperties: false, required: [] },
    get: { type: 'object', properties: { id: { type: 'string', description: 'Local document id.' } }, additionalProperties: false, required: ['id'] },
    create: { type: 'object', properties: { title: { type: 'string', description: 'Local document title.' }, category: { type: 'string', description: 'Local document category.' }, markdown: { type: 'string', description: 'Markdown document content. Use headings, paragraphs, lists, and tables normally; do not generate BlockSuite JSON or CRDT data.' }, metadata: { type: 'object', additionalProperties: true, description: 'Optional local document metadata.' } }, additionalProperties: false, required: ['title', 'category', 'markdown'] },
    update: { type: 'object', properties: { id: { type: 'string', description: 'Local document id.' }, title: { type: 'string', description: 'Local document title.' }, category: { type: 'string', description: 'Local document category.' }, markdown: { type: 'string', description: 'Markdown document content. Use headings, paragraphs, lists, and tables normally; do not generate BlockSuite JSON or CRDT data.' }, metadata: { type: 'object', additionalProperties: true, description: 'Optional local document metadata.' }, baseHash: { type: 'string', description: 'Current content hash read before editing.' } }, additionalProperties: false, required: ['id', 'title', 'category', 'markdown', 'baseHash'] },
};
function localDocumentTool({ action, description, parameters, annotations, caller, }) {
    return {
        name: action,
        description,
        parameters,
        factory: ({ toolContext }) => ({
            name: action,
            label: action,
            description,
            parameters,
            annotations,
            async execute(_toolCallId, params, signal) {
                return jsonResult(await caller(action, params, { runtimeContext: toolContext, signal }));
            },
        }),
    };
}
export function createLocalWorkspaceEntry({ callLocalDocument = defaultCallLocalDocument, } = {}) {
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
    });
    const registerTools = entry.register;
    entry.register = (api) => {
        registerTools(api);
        // The desktop bridge grants a direct `/plugin:uniopc-local-workspace`
        // invocation only to its current profile, session and run. Use that
        // one-turn user consent rather than OpenClaw's generic approval broker:
        // `gateway run --auth password` in OpenClaw 2026.8.1 has no broker route,
        // so `requireApproval` would fail before the authenticated bridge can
        // evaluate the grant.
    };
    return entry;
}
export default createLocalWorkspaceEntry();
