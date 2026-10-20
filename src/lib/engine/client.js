import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import {
  ENGINE_COMMANDS,
  ENGINE_ERROR_CODES,
  EngineClientError,
  normalizeEngineError,
  normalizeEngineRequest,
  normalizeEngineResponse,
} from './contracts.js'
import { mcpConfigEquivalent } from '../mcpConfig.js'

const READ_TIMEOUT_MS = 45_000
const RESOURCE_READ_TIMEOUT_MS = 15_000
const PLUGIN_WRITE_TIMEOUT_MS = 210_000

function commandMethod(call, command, timeoutMs = READ_TIMEOUT_MS) {
  return (args = {}, options = {}) => call(command, args, { timeoutMs, ...options })
}

function domain(commands) {
  return Object.freeze(commands)
}

export function createEngineClient({ invoke = tauriInvoke } = {}) {
  if (typeof invoke !== 'function') throw new TypeError('engineClient requires an invoke function')

  async function call(command, args = {}, { signal = null, timeoutMs = READ_TIMEOUT_MS } = {}) {
    if (signal?.aborted) {
      throw new EngineClientError({
        code: ENGINE_ERROR_CODES.cancelled,
        command,
        message: 'Uniopc engine request was cancelled',
      })
    }

    let timeoutId = null
    let removeAbortListener = null
    const barriers = [Promise.resolve().then(() => invoke(command, normalizeEngineRequest(args)))]

    if (signal) {
      barriers.push(new Promise((_, reject) => {
        const onAbort = () => reject(new EngineClientError({
          code: ENGINE_ERROR_CODES.cancelled,
          command,
          message: 'Uniopc engine request was cancelled',
        }))
        signal.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => signal.removeEventListener('abort', onAbort)
      }))
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      barriers.push(new Promise((_, reject) => {
        timeoutId = globalThis.setTimeout(() => reject(new EngineClientError({
          code: ENGINE_ERROR_CODES.timeout,
          command,
          message: `Uniopc engine command timed out after ${timeoutMs}ms`,
          retryable: true,
          timeoutMs,
        })), timeoutMs)
      }))
    }

    try {
      return normalizeEngineResponse(await Promise.race(barriers))
    } catch (error) {
      throw normalizeEngineError(error, command)
    } finally {
      if (timeoutId !== null) globalThis.clearTimeout(timeoutId)
      removeAbortListener?.()
    }
  }

  async function setMcpServer(args = {}, options = {}) {
    const normalizedArgs = normalizeEngineRequest(args)
    try {
      return await call(ENGINE_COMMANDS.plugins.setMcpServer, normalizedArgs, options)
    } catch (error) {
      if (!error?.retryable || error?.code === ENGINE_ERROR_CODES.cancelled) throw error
      const { profile, name, config } = normalizedArgs.req || {}
      if (!profile || !name) throw error
      try {
        const snapshot = await call(
          ENGINE_COMMANDS.plugins.listMcpServers,
          { profile },
          { timeoutMs: RESOURCE_READ_TIMEOUT_MS, ...options },
        )
        const savedServer = Array.isArray(snapshot?.servers)
          ? snapshot.servers.find(server => server?.name === name)
          : null
        if (savedServer && mcpConfigEquivalent(savedServer.config, config)) return snapshot
      } catch (confirmationError) {
        if (confirmationError?.code === ENGINE_ERROR_CODES.cancelled) throw confirmationError
        // Preserve the original write error if the confirmation read also fails.
      }
      throw error
    }
  }

  return Object.freeze({
    status: domain({
      get: commandMethod(call, ENGINE_COMMANDS.status.get),
      profile: commandMethod(call, ENGINE_COMMANDS.status.profile),
      bridge: commandMethod(call, ENGINE_COMMANDS.status.bridge),
      connection: commandMethod(call, ENGINE_COMMANDS.status.connection),
    }),
    sessions: domain({
      sendTurn: commandMethod(call, ENGINE_COMMANDS.sessions.sendTurn, 0),
      abortTurn: commandMethod(call, ENGINE_COMMANDS.sessions.abortTurn),
      subscribe: commandMethod(call, ENGINE_COMMANDS.sessions.subscribe),
      loadHistory: commandMethod(call, ENGINE_COMMANDS.sessions.loadHistory),
      files: commandMethod(call, ENGINE_COMMANDS.sessions.files),
      list: commandMethod(call, ENGINE_COMMANDS.sessions.list),
      create: commandMethod(call, ENGINE_COMMANDS.sessions.create),
      rename: commandMethod(call, ENGINE_COMMANDS.sessions.rename),
      setPermission: commandMethod(call, ENGINE_COMMANDS.sessions.setPermission),
      patchState: commandMethod(call, ENGINE_COMMANDS.sessions.patchState),
      setReasoning: commandMethod(call, ENGINE_COMMANDS.sessions.setReasoning),
      setModel: commandMethod(call, ENGINE_COMMANDS.sessions.setModel),
      setThinking: commandMethod(call, ENGINE_COMMANDS.sessions.setThinking),
      listPluginApprovals: commandMethod(call, ENGINE_COMMANDS.sessions.listPluginApprovals),
      resolvePluginApproval: commandMethod(call, ENGINE_COMMANDS.sessions.resolvePluginApproval),
      listExecApprovals: commandMethod(call, ENGINE_COMMANDS.sessions.listExecApprovals),
      resolveExecApproval: commandMethod(call, ENGINE_COMMANDS.sessions.resolveExecApproval),
    }),
    models: domain({
      snapshot: commandMethod(call, ENGINE_COMMANDS.models.snapshot),
    }),
    agents: domain({
      list: commandMethod(call, ENGINE_COMMANDS.agents.list),
      listTemplates: commandMethod(call, ENGINE_COMMANDS.agents.listTemplates),
      create: commandMethod(call, ENGINE_COMMANDS.agents.create),
      update: commandMethod(call, ENGINE_COMMANDS.agents.update),
      delete: commandMethod(call, ENGINE_COMMANDS.agents.delete),
      setSkills: commandMethod(call, ENGINE_COMMANDS.agents.setSkills),
      listDocuments: commandMethod(call, ENGINE_COMMANDS.agents.listDocuments),
      getDocument: commandMethod(call, ENGINE_COMMANDS.agents.getDocument),
      saveDocument: commandMethod(call, ENGINE_COMMANDS.agents.saveDocument),
      skillhubSnapshot: commandMethod(call, ENGINE_COMMANDS.agents.skillhubSnapshot, RESOURCE_READ_TIMEOUT_MS),
      feishuOverview: commandMethod(call, ENGINE_COMMANDS.agents.feishuOverview),
      saveFeishuAccount: commandMethod(call, ENGINE_COMMANDS.agents.saveFeishuAccount),
      bindFeishu: commandMethod(call, ENGINE_COMMANDS.agents.bindFeishu),
      unbindFeishu: commandMethod(call, ENGINE_COMMANDS.agents.unbindFeishu),
      wechatOverview: commandMethod(call, ENGINE_COMMANDS.agents.wechatOverview),
      installWechatPlugin: commandMethod(call, ENGINE_COMMANDS.agents.installWechatPlugin, PLUGIN_WRITE_TIMEOUT_MS),
      startWechatQr: commandMethod(call, ENGINE_COMMANDS.agents.startWechatQr),
      waitWechatQr: commandMethod(call, ENGINE_COMMANDS.agents.waitWechatQr),
      listChannelPairingRequests: commandMethod(call, ENGINE_COMMANDS.agents.listChannelPairingRequests),
      bindChannel: commandMethod(call, ENGINE_COMMANDS.agents.bindChannel),
      unbindChannel: commandMethod(call, ENGINE_COMMANDS.agents.unbindChannel),
      approveChannelPairing: commandMethod(call, ENGINE_COMMANDS.agents.approveChannelPairing),
      setChannelPolicy: commandMethod(call, ENGINE_COMMANDS.agents.setChannelPolicy),
    }),
    plugins: domain({
      listMcpServers: commandMethod(call, ENGINE_COMMANDS.plugins.listMcpServers, RESOURCE_READ_TIMEOUT_MS),
      setMcpServer,
      unsetMcpServer: commandMethod(call, ENGINE_COMMANDS.plugins.unsetMcpServer),
      listProfile: commandMethod(call, ENGINE_COMMANDS.plugins.listProfile),
      listSupported: commandMethod(call, ENGINE_COMMANDS.plugins.listSupported),
      listToolCapabilities: commandMethod(call, ENGINE_COMMANDS.plugins.listToolCapabilities, RESOURCE_READ_TIMEOUT_MS),
      doctorCheck: commandMethod(call, ENGINE_COMMANDS.plugins.doctorCheck),
      reconcile: commandMethod(call, ENGINE_COMMANDS.plugins.reconcile, PLUGIN_WRITE_TIMEOUT_MS),
      writeGrants: commandMethod(call, ENGINE_COMMANDS.plugins.writeGrants),
      prepareLifecycle: commandMethod(call, ENGINE_COMMANDS.plugins.prepareLifecycle),
      commitLifecycle: commandMethod(call, ENGINE_COMMANDS.plugins.commitLifecycle, PLUGIN_WRITE_TIMEOUT_MS),
      cancelLifecycle: commandMethod(call, ENGINE_COMMANDS.plugins.cancelLifecycle),
      uninstallCloud: commandMethod(call, ENGINE_COMMANDS.plugins.uninstallCloud, PLUGIN_WRITE_TIMEOUT_MS),
      setProfile: commandMethod(call, ENGINE_COMMANDS.plugins.setProfile, PLUGIN_WRITE_TIMEOUT_MS),
    }),
  })
}

export const engineClient = createEngineClient()
