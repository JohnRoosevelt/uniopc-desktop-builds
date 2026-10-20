const METADATA = Symbol.for('openclaw.plugin-sdk.tool-plugin.metadata')

function text(value) { return typeof value === 'string' ? value.trim() : '' }
function context(runtime = {}) {
  const session = runtime.session || {}
  const agent = runtime.agent || {}
  return {
    profile: text(runtime.openclawProfile) || text(runtime.openclaw_profile) || text(runtime.profile) || text(agent.openclawProfile) || text(process.env.UNIOPC_OPENCLAW_PROFILE),
    sessionKey: text(runtime.sessionKey) || text(runtime.session_key) || text(session.key) || text(session.sessionKey),
  }
}
async function createDocx(runtime, params, signal) {
  const url = text(process.env.UNIOPC_LOCAL_DOCUMENTS_URL)
  const token = text(process.env.UNIOPC_LOCAL_DOCUMENTS_TOKEN)
  const { profile, sessionKey } = context(runtime)
  if (!url || !token || !profile || !sessionKey) throw new Error('document_bridge_unavailable')
  const response = await fetch(url, { method: 'POST', signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'uniopc_documents_create_docx', payload: params, agent: { openclawProfile: profile, openclawAgentId: '' }, session: { key: sessionKey } }) })
  const data = await response.json()
  if (!response.ok || data?.error) throw new Error(`${data?.error?.code || 'document_generation_failed'}: ${data?.error?.message || response.statusText}`)
  return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data }
}
const definition = { name: 'uniopc_documents_create_docx', description: 'Create a real Word .docx file. Use this for a user-requested document; provide the complete Markdown content and a concise title.', parameters: { type: 'object', additionalProperties: false, required: ['title', 'markdown'], properties: { title: { type: 'string', description: 'Document title and output filename basis.' }, markdown: { type: 'string', description: 'Complete document content in Markdown. Headings and bullet lists are formatted in the generated DOCX.' } } } }
const entry = { id: 'uniopc-documents', name: '文档处理', description: 'Create real DOCX files through the Uniopc desktop bridge.', configSchema: { safeParse: value => value === undefined || (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) ? { success: true, data: value } : { success: false, error: { issues: [{ path: [], message: 'config must be empty' }] } }, jsonSchema: { type: 'object', properties: {}, additionalProperties: false } }, register(api) { api.registerTool(runtime => ({ ...definition, label: definition.name, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, execute: (_id, params, signal) => createDocx(runtime, params, signal) }), { name: definition.name }) } }
Object.defineProperty(entry, METADATA, { enumerable: false, value: { id: entry.id, name: entry.name, description: entry.description, activation: { onStartup: true }, configSchema: entry.configSchema.jsonSchema, tools: [{ ...definition, label: definition.name }] } })
export default entry
