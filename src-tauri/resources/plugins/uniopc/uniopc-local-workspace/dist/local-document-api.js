function requiredEnv(env, key) {
    const value = String(env?.[key] || '').trim();
    if (!value)
        throw new Error(`${key} is required`);
    return value;
}
function optionalText(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function objectValue(value) {
    return value && typeof value === 'object' ? value : {};
}
function firstText(...values) {
    for (const value of values) {
        const text = optionalText(value);
        if (text)
            return text;
    }
    return '';
}
const LOCAL_DOCUMENT_ACTIONS = new Set([
    'uniopc_local_documents_list',
    'uniopc_local_document_get',
    'uniopc_local_document_create',
    'uniopc_local_document_update',
]);
function requiredAction(value) {
    const action = typeof value === 'string' ? value : '';
    if (!LOCAL_DOCUMENT_ACTIONS.has(action)) {
        throw new Error('invalid_action: unsupported local document action');
    }
    return action;
}
function agentContextFromRuntimeContext(runtimeContext = {}) {
    const context = objectValue(runtimeContext);
    const agent = objectValue(context.agent);
    const identity = objectValue(context.identity);
    const session = objectValue(context.session);
    const runtime = objectValue(context.runtime);
    return {
        openclawProfile: firstText(context.openclawProfile, context.openclaw_profile, context.profile, context.profileKey, agent.openclawProfile, agent.openclaw_profile, identity.openclawProfile, identity.openclaw_profile, runtime.openclawProfile, runtime.openclaw_profile),
        openclawAgentId: firstText(context.openclawAgentId, context.openclaw_agent_id, context.agentId, context.agentAccountId, agent.openclawAgentId, agent.openclaw_agent_id, agent.agentId, identity.openclawAgentId, identity.openclaw_agent_id, identity.agentId, session.agentId, runtime.agentId),
    };
}
function agentContextFromEnv(env = process.env, runtimeContext = {}) {
    const runtime = agentContextFromRuntimeContext(runtimeContext);
    return {
        openclawProfile: runtime.openclawProfile || optionalText(env.UNIOPC_OPENCLAW_PROFILE),
        openclawAgentId: runtime.openclawAgentId
            || optionalText(env.UNIOPC_AGENT_ID)
            || optionalText(env.OPENCLAW_AGENT_ID),
    };
}
function runtimeSessionKey(runtimeContext = {}) {
    const context = objectValue(runtimeContext);
    const session = objectValue(context.session);
    const runtime = objectValue(context.runtime);
    return firstText(context.sessionKey, context.session_key, context.sessionId, session.key, session.sessionKey, session.session_key, session.sessionId, runtime.sessionKey, runtime.session_key);
}
function localBridgeUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('local_documents_url_not_loopback: local document bridge URL is invalid');
    }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
        throw new Error('local_documents_url_not_loopback: local document bridge must use IPv4 loopback');
    }
    return url.toString();
}
async function responseJson(response) {
    const text = await response.text();
    if (!text.trim())
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error('invalid_response: local document bridge returned invalid JSON');
    }
}
export async function callLocalDocument(action, payload = {}, { env = process.env, runtimeContext = {}, fetchImpl = globalThis.fetch, signal, } = {}) {
    if (typeof fetchImpl !== 'function')
        throw new Error('fetch is required');
    const endpoint = localBridgeUrl(requiredEnv(env, 'UNIOPC_LOCAL_DOCUMENTS_URL'));
    const token = requiredEnv(env, 'UNIOPC_LOCAL_DOCUMENTS_TOKEN');
    const agent = agentContextFromEnv(env, runtimeContext);
    if (!agent.openclawProfile) {
        throw new Error('missing_agent_profile: local document tools require a current desktop profile');
    }
    const sessionKey = runtimeSessionKey(runtimeContext);
    if (!sessionKey) {
        throw new Error('missing_runtime_session: local document tools require a live runtime session key');
    }
    const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        signal,
        body: JSON.stringify({
            action: requiredAction(action),
            payload: objectValue(payload),
            agent,
            session: { key: sessionKey },
        }),
    });
    const data = await responseJson(response);
    if (!response.ok || data?.error) {
        const code = optionalText(data?.error?.code) || `http_${response.status}`;
        const message = optionalText(data?.error?.message) || response.statusText || 'local document request failed';
        throw new Error(`${code}: ${message}`);
    }
    return data;
}
