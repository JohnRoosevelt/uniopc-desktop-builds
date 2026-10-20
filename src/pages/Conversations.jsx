import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { createConversationPermissionCoordinator } from '../lib/conversationPermissionCoordinator.js'
import { engineClient } from '../lib/engine/client.js'
import { sanitizeBrand } from '../lib/brandSanitizer'
import { gatewayStreamErrorMessage, isGatewayModelCredentialsUnavailable } from '../lib/gatewayErrors'
import { ConversationArtifactsSlot } from '../components/ConversationArtifactsSlot'
import { browserDockKeyboardTransition } from '../lib/browserDockKeyboard'
import { mapBrowserDockPointer } from '../lib/browserDockPointer'
import { browserDockAgentTargetCandidate, createBrowserDockActionQueue, resolveBrowserDockTab, selectBrowserDockTab } from '../lib/browserDockSession'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  abortConversationTurn,
  createConversationSession,
  isConversationDeliveryUnconfirmedError,
  listConversationSessions,
  loadConversationHistory,
  patchConversationSessionState,
  renameConversationSession,
  sendConversationTurn,
  setConversationSessionPermission,
  setConversationSessionModel,
  setConversationSessionReasoning,
  subscribeConversationSession,
} from '../lib/conversations/client'
import { listAutomations } from '../lib/automations'
import {
  conversationAttachmentTypeLabel,
  CONVERSATION_IMAGE_MAX_COUNT,
  nativeDragPositionToViewport,
  readFileAsConversationImageAttachment,
  validateConversationImageAttachments,
} from '../lib/conversationAttachments'
import {
  ensureConversationBridgeStatus,
  ensureOpenClawStatus,
  getGatewayConnectionSnapshot,
  isGatewayConnectionReady,
  useRuntimeStatusStore,
} from '../lib/runtimeStatus'
import {
  createConversationRecord,
  dedupeConversationMessages,
  deriveConversationSummary,
  mergeConversationHistoryMessages,
  mergeConversationOptimisticMessages,
  reconcileConversationSessionMessage,
  listStoredConversations,
  saveStoredConversations,
  subscribeConversationStorageError,
} from '../lib/conversationStore'
import {
  conversationOutboxStatusLabel,
  confirmConversationOutbox,
  enqueueConversationOutbox,
  listConversationOutbox,
  MAX_ENTRIES_PER_CONVERSATION as MAX_QUEUED_MESSAGES,
  claimQueuedConversationOutbox,
  outboxEntriesFor,
  OUTBOX_STATUS,
  removeConversationOutbox,
  updateConversationOutbox,
  shouldQueueConversationSubmission,
} from '../lib/conversationOutbox'
import { collectTimelineVideoMedia, recordToolArtifacts } from '../lib/conversationArtifacts'
import { loadEmployeeDirectory } from '../lib/employeeDirectory'
import {
  invalidateLocalEmployeesCache,
  loadLocalEmployees,
  readPersistedLocalEmployees,
} from '../lib/openclawEmployees'
import { formatOpenClawModelLabel } from '../lib/openclawModels'
import { startAudioRecording } from '../lib/audioRecorder'
import { transcribeDictationBlob } from '../lib/voiceDictation'
import {
  fetchLlmCreditBalance,
  getOfficialModelCatalog,
  getOfficialModelStatus,
  prepareUniopcOfficialModelForSelection,
  recoverOfficialModelAuth,
  subscribeOfficialModelCatalog,
  subscribeOfficialModelStatus,
} from '../lib/uniopcOfficialModel'
import { deriveProfileChatReadiness } from '../lib/profileChatReadiness'
import { useAuth } from '../hooks/useAuth'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import { profileWorkspaceNavigationState, useProfileWorkspace } from '../hooks/useProfileWorkspace'
import {
  buildConversationRecordId,
  buildConversationSessionRecordId,
  buildSessionKey,
} from '../lib/conversationKeys'
import { buildConversationRoster } from '../lib/conversationRoster'
import {
  markConversationTargetRead,
  readConversationReadMarks,
  writeConversationReadMarks,
} from '../lib/conversationReadState'
import {
  defaultConversationSessionKey,
  resolveActiveConversationTarget,
  sessionKeyBelongsToEmployee,
  sortConversationSessionsByRecency,
} from '../lib/conversationSelection'
import { buildEmployeeCreatePath } from '../lib/employeeNavigation'
import { profileWorkspacePath } from '../lib/profileWorkspace'
import {
  activeCommandQuery,
  activeMentionQuery,
  buildMentionResourceOptions,
  enrichConversationMentions,
  inferDocumentTitleMentions,
  extractConversationMentions,
  extractConversationToolInvocations,
  insertCommandToken,
  insertMentionToken,
  mentionResourcesLoadingAfterCoreResult,
  mergeMentionResources,
  nearestVisibleMentionIndex,
  selectAgentVisibleSkills,
  shouldRefreshSlashMentionResources,
  visibleMentionOptions,
  MENTION_KINDS,
} from '../lib/conversationMentions'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { displayEmployeeName } from '../lib/employeeDisplay'
import {
  capabilityKindFromCode,
  splitConversationMediaSegments,
  tokenizeConversationMessageContent,
} from '../lib/conversationMessageFormatting'
import { repairStreamingMarkdownTail } from '../lib/markdownStreamRepair'
import { plainSummary } from '../lib/plainSummary'
import {
  shouldDeferOpenClawDirectoryHydration,
} from '../lib/openclawAccess'
import {
  isConversationScrollPinnedToBottom,
  shouldAutoScrollConversationList,
  smoothScrollConversationToBottom,
} from '../lib/conversationScroll'
import EmployeeAvatar from '../components/EmployeeAvatar'
import EmployeeListPane from '../components/EmployeeListPane'
import ConversationStatusBanner from './conversations/ConversationStatusBanner'
import { lazyPage } from '../lib/lazyPage'
import { SURFACE } from '../lib/theme'
import { supabase } from '../lib/supabase'
import { syncMyCloudAiEmployees } from '../lib/cloudWorkspace'
import { listLocalDocuments } from '../lib/localDocuments'

const InlineEmployeeSettingsPanel = lazyPage(() => import('./conversations/InlineEmployeeSettingsPanel'))

const BLOCKED_CONVERSATION_PROVIDER_STATUSES = new Set(['cooldown', 'disabled', 'expired', 'missing'])
const UNIOPC_OFFICIAL_PROVIDER = 'uniopc-official'
const UNIOPC_OFFICIAL_MODEL_REF = 'uniopc-official/uniopc-default'
// Max messages a user can queue while a turn is running (Accio caps this too).
// Stable empty reference so idle conversations don't churn identity each render.
const EMPTY_QUEUED_MESSAGES = []
// How long a turn may go without a single gateway frame before we stop trusting
// the spinner and ask the engine what actually happened. Generous on purpose: a
// reasoning model can think for a long stretch without emitting anything.
const LOST_RUN_SILENCE_MS = 120 * 1000
const LOST_RUN_PROBE_INTERVAL_MS = 15 * 1000

function isModelRateLimitError(error) {
  const normalized = String(error || '').toLowerCase()
  return normalized.includes('rate-limit')
    || normalized.includes('rate_limit')
    || normalized.includes('rate limited')
    || normalized.includes('usage limit')
    || normalized.includes('cooldown')
    || normalized.includes('free plan')
    || normalized.includes('billing error')
    || normalized.includes('insufficient balance')
    || normalized.includes('run out of credits')
    || normalized.includes('out of credits')
}

// macOS 走 native_voice_input(Speech 框架,本地实时听写);Windows/Linux 没有
// 系统级语音识别,听写走云端 transcribe(录一段 -> 上传转写 -> 文本回填)。
const NATIVE_VOICE_INPUT_PLATFORM =
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

function formatNativeVoiceInputError(error) {
  const message = String(error?.message || error || '').trim()
  if (!message) return '未知错误'
  // webview getUserMedia 拒权(云端听写路径,Windows/Linux)。
  if (message.includes('NotAllowedError') || message.includes('Permission denied') || message.includes('Permission dismissed')) {
    return '请允许 Uniopc 使用麦克风。'
  }
  if (message.includes('codesigned app or debug binary')) {
    return '当前开发二进制尚未绑定 macOS 语音权限说明。请打开打包后的 Uniopc.app，或先对调试二进制重新签名后再测试语音输入。'
  }
  if (message.includes('Microphone permission')) {
    return '请在系统设置里允许 Uniopc 使用麦克风。'
  }
  if (message.includes('Speech Recognition permission')) {
    return '请在系统设置里允许 Uniopc 使用语音识别。'
  }
  return message
}

function isNativeVoiceInputError(error) {
  const message = String(error || '')
  return message.startsWith('语音输入失败') || message.startsWith('停止语音输入失败')
}

// A turn can end in `error` because a single tool/file step failed (e.g. the model
// tried to read a path that doesn't exist: `show …/plugin.json` failed). That is NOT
// an engine-health problem, so it must not surface the alarming "去运行中心检查 Uniopc
// 引擎" recovery banner — it reads as if the runtime is broken when nothing is.
// Keep this narrow: real gateway/connection/auth failures must still get the CTA.
function isNonFatalToolStepError(error) {
  const message = String(error || '')
  const normalized = message.toLowerCase()
  if (!normalized) return false
  if (
    normalized.includes('gateway') ||
    normalized.includes('connection') ||
    normalized.includes('econnrefused') ||
    normalized.includes('econnreset') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('unauthorized') ||
    normalized.includes('password_mismatch') ||
    normalized.includes('pairing') ||
    normalized.includes('device identity')
  ) {
    return false
  }
  return (
    /`[^`]+`\s+failed/i.test(message) || // a tool invocation, e.g. `show …/plugin.json` failed
    normalized.includes('enoent') ||
    normalized.includes('no such file')
  )
}

// 能力 chip 是分类调色板：plugin / mcp / skill 三类各一个色相，
// 色相是这里唯一的分类信号（chip 上只有名字，没有图标或前缀）。
//
// 注意：这里不区分 user/assistant。原来两套是因为用户气泡是硬编码浅色底、
// 助手气泡是深色底，所以要各配一套。气泡改用主题感知的 token 之后，
// 一套语义色在两种气泡、两个主题下都成立。
const CAPABILITY_TONE = {
  plugin: 'border-subtle bg-info-surface text-info-text',
  mcp: 'border-brand/25 bg-state-selected text-accent-text',
  skill: 'border-subtle bg-success-surface text-success-text',
}

function capabilityTokenClass(kind) {
  return CAPABILITY_TONE[kind] || CAPABILITY_TONE.skill
}

function ConversationCapabilityChip({ value, kind }) {
  return (
    <span
      className={`mx-0.5 inline-flex max-w-full align-baseline rounded-md border px-1.5 py-0.5 text-[0.92em] font-medium leading-5 ${capabilityTokenClass(kind)}`}
    >
      <span className="truncate">{value}</span>
    </span>
  )
}

function ConversationMediaToken({ token }) {
  const isVideo = token.mediaKind === 'video'
  const [resolvedVideoPath, setResolvedVideoPath] = useState(null)
  const [resolveError, setResolveError] = useState('')
  const [videoError, setVideoError] = useState('')
  const videoRef = useRef(null)
  const src = resolvedVideoPath ? convertFileSrc(resolvedVideoPath) : ''

  useEffect(() => {
    if (!isVideo) return
    let cancelled = false
    setResolvedVideoPath(null)
    setResolveError('')
    setVideoError('')

    invoke('resolve_media_asset_path', { path: token.value })
      .then(path => {
        if (!cancelled) setResolvedVideoPath(path)
      })
      .catch(() => {
        if (!cancelled) setResolveError('媒体文件不存在或不可访问')
      })

    return () => { cancelled = true }
  }, [isVideo, token.value])

  useEffect(() => {
    if (!isVideo || !src || !videoRef.current) return
    videoRef.current.load()
  }, [isVideo, src])

  if (isVideo) {
    return (
      <figure className="my-2">
        {src ? (
          <video
            key={src}
            ref={videoRef}
            controls
            playsInline
            preload="metadata"
            className="block max-h-[480px] max-w-full rounded-lg border border-default object-contain"
            onLoadedMetadata={() => setVideoError('')}
            onError={event => {
              const code = event.currentTarget.error?.code
              setVideoError(code ? `错误代码 ${code}` : '媒体资源无法加载')
            }}
          >
            <source src={src} type="video/mp4" />
          </video>
        ) : !resolveError && (
          <div className="rounded-lg border border-default px-3 py-2 text-sm text-secondary">正在加载视频…</div>
        )}
        {(resolveError || videoError) && (
          <figcaption role="alert" className="mt-1 text-xs text-warning-text">
            视频无法播放：{resolveError || videoError}。
          </figcaption>
        )}
      </figure>
    )
  }
  return (
    <img
      src={convertFileSrc(token.value)}
      alt="generated media"
      className="my-2 block max-h-[360px] max-w-full rounded-lg border border-default object-contain"
      loading="lazy"
    />
  )
}

function ConversationToolOutputMedia({ timeline, messageContent = '' }) {
  const videos = collectTimelineVideoMedia(timeline, { messageContent })
  if (videos.length === 0) return null
  return (
    <div className="mb-2 w-full">
      {videos.map(token => <ConversationMediaToken key={token.value} token={token} />)}
    </div>
  )
}

function ConversationInlineTokens({ content, role, documentLabels }) {
  return tokenizeConversationMessageContent(content, { documentLabels }).map((token, index) => {
    if (token.type === 'capability') {
      return <ConversationCapabilityChip key={`${token.type}-${index}`} value={token.label || token.value} kind={token.kind} role={role} />
    }
    if (token.type === 'media') {
      return <ConversationMediaToken key={`${token.type}-${index}`} token={token} />
    }
    if (token.type === 'code') {
      return (
        <code
          key={`${token.type}-${index}`}
          className={`rounded px-1.5 py-0.5 text-[0.92em] ${role === 'user' ? 'bg-surface-sunken text-primary' : 'bg-surface-overlay text-accent-text'}`}
        >
          {token.value}
        </code>
      )
    }
    return <span key={`${token.type}-${index}`}>{token.value}</span>
  })
}

const CONVERSATION_REMARK_PLUGINS = [remarkGfm]

const CONVERSATION_MARKDOWN_COMPONENTS = {
  a({ node: _node, children, ...props }) {
    return (
      <a
        {...props}
        target="_blank"
        rel="noreferrer noopener"
        className="text-accent-text underline decoration-brand/40 underline-offset-2 transition-colors hover:text-accent-text"
      >
        {children}
      </a>
    )
  },
  code({ node: _node, className, children, ...props }) {
    const isBlock = /language-/.test(String(className || ''))
    if (!isBlock) {
      const text = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : ''
      const kind = capabilityKindFromCode(text)
      if (kind) return <ConversationCapabilityChip value={text} kind={kind} role="assistant" />
      return (
        <code className="rounded bg-surface-overlay px-1.5 py-0.5 text-[0.92em] text-accent-text" {...props}>
          {children}
        </code>
      )
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  },
  pre({ node: _node, children, ...props }) {
    return (
      <pre
        className="my-2 overflow-x-auto rounded-lg border border-default bg-scrim px-3.5 py-3 text-sm leading-6"
        {...props}
      >
        {children}
      </pre>
    )
  },
  table({ node: _node, children, ...props }) {
    return (
      <div className="my-2 max-w-full overflow-x-auto">
        <table {...props}>{children}</table>
      </div>
    )
  },
  img({ node: _node, ...props }) {
    return <img {...props} loading="lazy" className="my-2 block max-h-[360px] max-w-full rounded-lg border border-default object-contain" />
  },
}

// Typing and runtime status updates must not reparse every historical answer.
// Streaming still renders on each changed content/streaming prop.
const ConversationMarkdownBody = memo(function ConversationMarkdownBody({ content, streaming = false }) {
  const displayContent = streaming ? repairStreamingMarkdownTail(content) : content
  const segments = splitConversationMediaSegments(displayContent)
  return (
    <div className={`conversation-markdown${streaming ? ' conversation-streaming-cursor' : ''}`}>
      {segments.map((segment, index) => segment.type === 'media'
        ? <ConversationMediaToken key={`media-${index}`} token={segment} />
        : (
          <ReactMarkdown
            key={`text-${index}`}
            remarkPlugins={CONVERSATION_REMARK_PLUGINS}
            components={CONVERSATION_MARKDOWN_COMPONENTS}
          >
            {segment.value}
          </ReactMarkdown>
        ))}
    </div>
  )
})

function ConversationMessageContent({ content, role, streaming = false, documentLabels }) {
  if (!content) return streaming ? <ConversationThinkingIndicator /> : ''
  if (role === 'user') return <ConversationInlineTokens content={sanitizeBrand(content)} role={role} documentLabels={documentLabels} />
  return <ConversationMarkdownBody content={sanitizeBrand(content)} streaming={streaming} />
}

function ConversationStreamingAssistantBubble({ content }) {
  return (
    <ConversationMessageContent
      content={content}
      role="assistant"
      streaming
    />
  )
}

function formatConversationReasoningDuration(startedAt, finishedAt = Date.now()) {
  const start = Number(startedAt) || 0
  const finish = Number(finishedAt) || Date.now()
  if (!start || finish <= start) return ''
  const seconds = Math.max(1, Math.round((finish - start) / 1000))
  return `${seconds}s`
}

function conversationToolStepStatusIcon(status) {
  if (status === 'ok') return <span className="text-xs text-success-text" aria-hidden="true">✓</span>
  if (status === 'error') return <span className="text-xs text-danger-text" aria-hidden="true">✗</span>
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border border-brand/40 border-t-transparent"
      aria-hidden="true"
    />
  )
}

// Accio-style unified "已处理 Ns" process strip: one collapsible per turn that
// folds the agent's reasoning AND its tool calls together under a single
// duration header, leaving only the final answer outside. Replaces the old
// separate reasoning panel + tool timeline (their data helpers are unchanged).
// (Exported for test harnesses.)
export function ConversationProcessTimeline({ reasoning, timeline, expanded, onToggle }) {
  const steps = timeline?.steps || []
  const hasReasoning = Boolean(reasoning)
  const hasTools = steps.length > 0
  if (!hasReasoning && !hasTools) return null

  const running = Boolean(reasoning?.streaming) || Boolean(hasTools && !timeline.finishedAt)
  const starts = [reasoning?.startedAt, timeline?.startedAt].filter(Boolean)
  const ends = [reasoning?.finishedAt, timeline?.finishedAt].filter(Boolean)
  const start = starts.length ? Math.min(...starts) : Date.now()
  const end = running || !ends.length ? Date.now() : Math.max(...ends)
  const duration = formatConversationReasoningDuration(start, end)
  const summary = running
    ? `处理中... ${duration || '1s'}`
    : `已处理 ${duration || ''}`.trim()

  return (
    <div className="max-w-full overflow-hidden text-secondary">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="inline-flex max-w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-state-hover"
      >
        {running
          ? conversationToolStepStatusIcon('running')
          : <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-stone-500" />}
        <span className="truncate text-xs font-semibold text-primary">{summary}</span>
        {hasTools && <span className="shrink-0 text-2xs text-tertiary">{steps.length} 个工具</span>}
        <span className="shrink-0 text-xs text-tertiary" aria-hidden="true">{expanded ? '^' : 'v'}</span>
      </button>
      {expanded && (
        <div className="mt-0.5 border-l border-subtle pl-2">
          {hasReasoning && (
            <div className="px-1 py-2 text-sm leading-6 whitespace-pre-wrap text-secondary/90 [overflow-wrap:anywhere] [word-break:break-word]">
              {reasoning.content
                ? <ConversationMessageContent content={reasoning.content} role="assistant" streaming={Boolean(reasoning.streaming)} />
                : <ConversationThinkingIndicator />}
            </div>
          )}
          {hasTools && (
            <div className={`py-1 ${hasReasoning ? 'border-t border-subtle' : ''}`}>
              {steps.map(step => (
                <div key={step.key} className="flex items-start gap-2.5 px-1 py-1.5">
                  <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center">
                    {conversationToolStepStatusIcon(step.status)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium text-primary">{sanitizeBrand(step.name)}</span>
                      {step.finishedAt && step.startedAt && (
                        <span className="shrink-0 text-2xs text-tertiary">
                          {formatConversationReasoningDuration(step.startedAt, step.finishedAt)}
                        </span>
                      )}
                    </div>
                    {step.args && (
                      <code className="mt-0.5 block truncate text-xs text-tertiary">{sanitizeBrand(step.args)}</code>
                    )}
                    {step.status === 'error' && step.resultPreview && (
                      <div className="mt-0.5 text-xs leading-5 text-danger-text [overflow-wrap:anywhere]">{sanitizeBrand(step.resultPreview)}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function hostRecoveryPath(rateLimitError, profileWorkspace = null) {
  const childPath = rateLimitError ? 'models' : 'operations'
  return profileWorkspace ? profileWorkspacePath(profileWorkspace, childPath) : `/${childPath}`
}

function hostRecoveryLabel(rateLimitError) {
  return rateLimitError ? '去重新绑定模型账号' : '去运行中心检查 Uniopc 引擎'
}

function cleanAccountText(value = '') {
  return String(value || '').trim()
}

function accountDisplayName({ user = null, profile = null } = {}) {
  return cleanAccountText(profile?.nickname) ||
    cleanAccountText(user?.displayName) ||
    cleanAccountText(user?.user_metadata?.display_name) ||
    cleanAccountText(user?.email) ||
    '你'
}

function accountAvatarUrl({ user = null, profile = null } = {}) {
  return cleanAccountText(profile?.avatar_url) ||
    cleanAccountText(profile?.avatarUrl) ||
    cleanAccountText(user?.user_metadata?.avatar_url) ||
    cleanAccountText(user?.user_metadata?.picture)
}

function ConversationThinkingIndicator() {
  return (
    <span className="conversation-thinking-indicator" aria-label="Think...">
      <span>Think</span>
      <span className="conversation-thinking-dots" aria-hidden="true">
        <span className="conversation-thinking-dot">.</span>
        <span className="conversation-thinking-dot">.</span>
        <span className="conversation-thinking-dot">.</span>
      </span>
    </span>
  )
}

function buildEmployeeConversation(employee, sessionKey = '', sessionTitle = '') {
  const gatewaySessionKey = sessionKey || buildSessionKey(employee.id)
  const recordId = buildConversationSessionRecordId(employee.id, gatewaySessionKey)
  const employeeLabel = displayEmployeeName(employee)
  return createConversationRecord({
    id: recordId,
    sessionId: gatewaySessionKey || recordId,
    employeeId: employee.id,
    employeeName: employeeLabel,
    employeeRole: employee.role,
    title: sessionTitle || employeeLabel,
    summary: employee.description || '',
    gatewaySessionKey,
    meta: null,
  })
}


function conversationMessageTimestamp(message) {
  if (!message) return 0
  if (Number.isFinite(message.createdAt)) return message.createdAt
  if (!message.createdAt) return 0
  const parsed = new Date(message.createdAt).getTime()
  return Number.isNaN(parsed) ? 0 : parsed
}

function latestConversationMessageTimestamp(messages = [], fallback = 0) {
  if (!Array.isArray(messages) || messages.length === 0) return fallback || 0
  return messages.reduce((latest, message) => Math.max(latest, conversationMessageTimestamp(message)), fallback || 0)
}

const PROMPT_SUGGESTIONS = [
  '总结一下今天应该优先推进的工作',
  '列出当前业务最需要处理的事项',
  '帮我规划下一步行动',
]

const EMPTY_MENTION_RESOURCES = {
  plugins: [],
  mcps: [],
  skills: [],
  toolPlugins: [],
  documents: [],
}

const CONVERSATION_APPROVAL_MODES = [
  {
    id: 'default',
    label: '默认权限',
    summary: '清除会话覆盖，跟随当前员工与 Gateway 的默认策略',
    openClaw: 'permissionMode: null',
  },
  {
    id: 'read-only',
    label: '只读',
    summary: '仅可读取工作区内容，不能执行命令或写入文件',
    openClaw: 'permissionMode: read-only',
  },
  {
    id: 'guarded',
    label: '受保护',
    summary: '工作区内可读写；超出允许范围时需人工批准',
    openClaw: 'permissionMode: guarded',
  },
  {
    id: 'workspace',
    label: '工作区',
    summary: '工作区内可读写；超出范围由 AI 审核并在需要时升级人工批准',
    openClaw: 'permissionMode: workspace',
  },
  {
    id: 'full',
    label: '完全访问权限',
    summary: '不受工作区边界限制；仅用于受信任的管理员会话',
    openClaw: 'permissionMode: full',
  },
]

function findConversationApprovalMode(id) {
  return CONVERSATION_APPROVAL_MODES.find(item => item.id === id) || CONVERSATION_APPROVAL_MODES[0]
}

// Reasoning display is not user-configurable: the session is always patched to
// reasoningLevel=stream so the collapsible thinking panel fills in live.
// (Accio-style: capture the thought process always; never make the user choose.)
const CONVERSATION_REASONING_STREAM_LEVEL = 'stream'

function normalizeConversationReasoningMode(value) {
  const normalized = String(value || '').trim()
  if (normalized === 'streaming') return 'stream'
  if (normalized === 'off' || normalized === 'on' || normalized === 'stream') return normalized
  return 'off'
}

function profileDefaultModelRefFromSnapshot(snapshot, fallbackModelRef = '') {
  return String(
    snapshot?.resolvedDefaultModel ||
      snapshot?.primaryModel ||
      fallbackModelRef ||
      '',
  ).trim()
}

function providerIdFromConversationModelRef(modelRef) {
  const raw = String(modelRef || '').trim()
  if (!raw.includes('/')) return ''
  return raw.split('/')[0]
}

function conversationProviderLookup(snapshot) {
  const lookup = new Map()
  for (const provider of Array.isArray(snapshot?.providers) ? snapshot.providers : []) {
    const id = String(provider?.id || '').trim()
    if (id) lookup.set(id, provider)
  }
  return lookup
}

function shouldHideConversationModelChoice({ modelRef, providerReady, providerStatus, profileDefaultProvider }) {
  const providerId = providerIdFromConversationModelRef(modelRef)
  if (BLOCKED_CONVERSATION_PROVIDER_STATUSES.has(providerStatus)) return true
  if (providerId === 'qwen' && providerReady === false && profileDefaultProvider !== 'qwen') return true
  return false
}

function officialModelDetail(entry) {
  const multiplier = Number(entry?.creditMultiplier)
  // Every official model shows its multiplier (the default shows 1x) so the
  // rows read as peers; the account-level balance lives in the menu header.
  if (Number.isFinite(multiplier) && multiplier > 0) {
    return `官方模型 · ${Math.round(multiplier * 100) / 100}x credits`
  }
  return '官方模型 · 按 credits 计量'
}

function conversationModelChoicesFromSnapshot(snapshot, fallbackModelRef = '', officialCatalog = []) {
  const profileDefault = profileDefaultModelRefFromSnapshot(snapshot, fallbackModelRef)
  const profileDefaultProvider = providerIdFromConversationModelRef(profileDefault)
  const providerLookup = conversationProviderLookup(snapshot)
  const catalog = Array.isArray(officialCatalog) ? officialCatalog : []
  // Official models render as PEERS straight from the admin-managed catalog —
  // there is no synthetic "default" entry in the UI. Which model is the
  // backend's fallback is real config (`isDefault`, used for legacy-ref
  // selection mapping below), not a branded row. Every official model routes
  // through llm-proxy and is metered in credits; picking any of them connects
  // on demand. Only a cold start with no cached catalog (never connected)
  // shows the single branded bootstrap entry.
  const choices = []
  const seen = new Set(['', UNIOPC_OFFICIAL_MODEL_REF])
  if (catalog.length > 0) {
    for (const entry of catalog) {
      const modelRef = `${UNIOPC_OFFICIAL_PROVIDER}/${entry.id}`
      if (seen.has(modelRef)) continue
      seen.add(modelRef)
      choices.push({
        id: modelRef,
        label: entry.displayName || entry.id,
        modelRef,
        providerReady: true,
        selectable: true,
        isOfficial: true,
        isOfficialDefault: entry.isDefault === true,
        officialBadge: entry.badge || '',
        detail: officialModelDetail(entry),
      })
    }
  } else {
    choices.push({
      id: 'uniopc-official',
      label: '默认模型（Uniopc 官方）',
      modelRef: UNIOPC_OFFICIAL_MODEL_REF,
      providerReady: true,
      selectable: true,
      isOfficial: true,
      isOfficialDefault: true,
      officialBadge: '',
      detail: '官方模型 · 按 credits 计量',
    })
  }
  return choices
}

function formatConversationModelChip(modelRef, fallbackRef = '') {
  const value = String(modelRef || fallbackRef || '').trim()
  if (!value) return '默认'
  if (value.includes('gpt-5.5')) return '5.5'
  if (value.includes('gpt-5.4')) return '5.4 快'
  if (value.includes('MiniMax-M2.7')) return 'M2.7'
  const [, model] = value.split('/')
  return model || value
}

function sessionModelRefFromMeta(meta = null) {
  const model = String(meta?.model || '').trim()
  if (!model) return ''
  const provider = String(meta?.modelProvider || '').trim()
  if (provider && !model.includes('/')) return `${provider}/${model}`
  return model
}

function formatSessionTitle(session, fallback = '主聊天') {
  const title = String(
    session?.label ||
      session?.title ||
      session?.displayName ||
      session?.derivedTitle ||
      '',
  ).trim()
  if (title) return title
  const key = String(session?.sessionKey || session?.key || '').trim()
  if (!key) return fallback
  const tail = key.split(':').filter(Boolean).at(-1)
  return tail === 'main' ? fallback : tail
}

function formatSessionTime(value) {
  if (!value) return ''
  const numeric = Number(value)
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function mentionBadgeClass(kind) {
  if (kind === 'plugin') return 'border-violet-300/35 bg-violet-400/10 text-accent-text'
  if (kind === 'mcp') return 'border-sky-300/35 bg-sky-400/10 text-info-text'
  if (kind === 'doc') return 'border-rose-300/35 bg-rose-400/10 text-danger-text'
  return 'border-emerald-300/35 bg-emerald-400/10 text-success-text'
}

function SessionPicker({
  open,
  pickerRef,
  activeEmployee,
  activeSessionKey,
  activeTitle,
  sessions,
  loading,
  error,
  search,
  creating,
  editingSessionKey,
  editingSessionLabel,
  renamingSessionKey,
  onToggle,
  onSearch,
  onSelect,
  onCreate,
  onRefresh,
  onStartRename,
  onRenameLabelChange,
  onCancelRename,
  onRenameSession,
}) {
  if (!activeEmployee) return null
  return (
    <div ref={pickerRef} className="relative">
      <button
        type="button"
        data-e2e-active-session-key={activeSessionKey}
        aria-expanded={open}
        onClick={onToggle}
        className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg border border-subtle bg-surface-raised px-2.5 text-sm text-secondary transition-colors hover:bg-state-hover hover:text-primary"
        title="切换聊天记录"
      >
        <span className="text-sm text-tertiary">▣</span>
        <span className="truncate">{activeTitle || '主聊天'}</span>
        <span className="text-xs text-tertiary">⌄</span>
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-30 w-[320px] overflow-hidden rounded-lg border border-default bg-surface-raised shadow-xl">
          <div className="flex items-center gap-1.5 border-b border-subtle p-1.5">
            <input
              value={search}
              onChange={event => onSearch(event.target.value)}
              placeholder="搜索聊天记录..."
              className="h-7 min-w-0 flex-1 rounded-md border border-subtle bg-surface-raised px-2 text-xs text-primary outline-none placeholder:text-tertiary"
            />
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-base text-secondary transition-colors hover:bg-state-hover hover:text-primary"
              title="刷新聊天记录"
            >
              ↻
            </button>
            <button
              type="button"
              onClick={onCreate}
              disabled={creating}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-brand text-base font-medium leading-none text-white transition-colors hover:bg-brand-strong disabled:opacity-50"
              title="新聊天"
              aria-label={creating ? '正在创建新聊天' : '新聊天'}
            >
              +
            </button>
          </div>
          <div className="max-h-[300px] overflow-y-auto py-0.5">
            {loading && (
              <div className="px-3 py-3 text-sm text-tertiary">正在读取 Gateway 聊天记录...</div>
            )}
            {!loading && error && (
              <div className="px-3 py-3 text-sm text-danger-text">{error}</div>
            )}
            {!loading && !error && sessions.length === 0 && (
              <div className="px-3 py-3 text-sm text-tertiary">当前员工暂无 Gateway 聊天记录。</div>
            )}
            {sessions.map(session => {
              const sessionKey = session.sessionKey || session.key
              const selected = sessionKey === activeSessionKey
              const editing = sessionKey === editingSessionKey
              const renaming = sessionKey === renamingSessionKey
              const title = formatSessionTitle(session)
              if (editing) {
                return (
                  <form
                    key={sessionKey}
                    className="flex items-center gap-1.5 px-2.5 py-1.5"
                    onSubmit={event => {
                      event.preventDefault()
                      onRenameSession(session)
                    }}
                  >
                    <input
                      autoFocus
                      value={editingSessionLabel}
                      onChange={event => onRenameLabelChange(event.target.value)}
                      className="h-7 min-w-0 flex-1 rounded-md border border-brand/40 bg-surface-raised px-2 text-xs text-primary outline-none"
                      placeholder="聊天名称"
                    />
                    <button
                      type="submit"
                      disabled={renaming || !editingSessionLabel.trim()}
                      className="inline-flex h-7 items-center rounded-md bg-brand px-2 text-2xs font-medium text-white transition-colors hover:bg-brand-strong disabled:opacity-50"
                    >
                      {renaming ? '保存中' : '保存'}
                    </button>
                    <button
                      type="button"
                      onClick={onCancelRename}
                      className="inline-flex h-7 items-center rounded-md px-2 text-2xs text-secondary transition-colors hover:bg-state-hover hover:text-primary"
                    >
                      取消
                    </button>
                  </form>
                )
              }
              return (
                <div
                  key={sessionKey}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
                    selected
                      ? 'bg-state-selected text-accent-text'
                      : 'text-primary hover:bg-state-hover'
                  }`}
                >
                  <button
                    type="button"
                    data-e2e-session-key={sessionKey}
                    onClick={() => onSelect(session)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current text-2xs">
                      {selected ? '✓' : ''}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium leading-5">{title}</span>
                      <span className="block truncate text-2xs leading-4 text-tertiary">
                        {formatSessionTime(session.updatedAt || session.createdAt) || sessionKey}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onStartRename(session)}
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-2xs text-tertiary transition-colors hover:bg-state-hover hover:text-primary"
                  >
                    重命名
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function ConversationDock({ mode, activeProfile, activeSessionKey, sessions, selectedBrowserTargetId, onBrowserTargetChange, onClose }) {
  const [browserRuntime, setBrowserRuntime] = useState(null)
  const [browserFrame, setBrowserFrame] = useState(null)
  const [browserFrameMode, setBrowserFrameMode] = useState('stream')
  const [browserTargetId, setBrowserTargetId] = useState(selectedBrowserTargetId || '')
  const [browserLoading, setBrowserLoading] = useState(false)
  const [dockError, setDockError] = useState('')
  const [jobs, setJobs] = useState([])
  const [splitSessionKey, setSplitSessionKey] = useState('')
  const [splitMessages, setSplitMessages] = useState([])
  const browserViewportRef = useRef(null)
  const browserFrameImageRef = useRef(null)
  const browserKeyboardInputRef = useRef(null)
  const browserTargetIdRef = useRef('')
  const browserRuntimeRef = useRef(null)
  const pendingAgentTargetRef = useRef(null)
  const browserActionQueueRef = useRef(createBrowserDockActionQueue())
  const browserRuntimeRefreshBusyRef = useRef(false)
  const lastBrowserStreamFrameRef = useRef(0)
  const browserCompositionRef = useRef({ composing: false, suppressNextCommitKey: false })
  browserRuntimeRef.current = browserRuntime
  const runBrowserDockAction = useCallback(async (action, values = {}) => {
    const targetId = browserTargetId
    if (!activeProfile || !targetId) return
    setDockError('')
    return browserActionQueueRef.current(async () => {
      try {
        const result = await invoke('openclaw_browser_dock_action', { req: { profile: activeProfile, targetId, action, ...values } })
        if (action === 'frame') setBrowserFrame(result)
      } catch (err) {
        setDockError(String(err?.message || err || '连接工作区 Browser Runtime 失败'))
      }
    })
  }, [activeProfile, browserTargetId])

  const chooseBrowserDockTarget = useCallback(targetId => {
    browserTargetIdRef.current = targetId
    setBrowserTargetId(targetId)
    onBrowserTargetChange(targetId)
  }, [onBrowserTargetChange])

  useEffect(() => {
    browserTargetIdRef.current = selectedBrowserTargetId || ''
    pendingAgentTargetRef.current = null
    setBrowserTargetId(selectedBrowserTargetId || '')
    setBrowserRuntime(null)
    setBrowserFrame(null)
  }, [activeProfile, selectedBrowserTargetId])

  useEffect(() => {
    pendingAgentTargetRef.current = null
  }, [activeSessionKey])

  const forwardBrowserKeyboardEvent = useCallback((type, event) => {
    const transition = browserDockKeyboardTransition(browserCompositionRef.current, {
      type,
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent?.isComposing,
      keyCode: event.nativeEvent?.keyCode,
      data: event.data,
    })
    browserCompositionRef.current = {
      composing: transition.composing,
      suppressNextCommitKey: transition.suppressNextCommitKey,
      suppressCompositionInput: transition.suppressCompositionInput,
    }
    if (type === 'keydown' && (transition.action || transition.suppressKey)) event.preventDefault()
    if (type === 'compositionend') {
      window.setTimeout(() => {
        browserCompositionRef.current = browserDockKeyboardTransition(browserCompositionRef.current, { type: 'commit-window-expired' })
      }, 0)
    }
    if (transition.action?.type === 'text') runBrowserDockAction('text', { text: transition.action.text })
    if (transition.action?.type === 'key') runBrowserDockAction('key', { key: transition.action.key, modifiers: transition.action.modifiers })
  }, [runBrowserDockAction])

  useEffect(() => {
    if (mode !== 'browser' || !activeProfile) return undefined
    let disposed = false
    const refresh = async () => {
      if (disposed || browserRuntimeRefreshBusyRef.current) return
      browserRuntimeRefreshBusyRef.current = true
      try {
        const snapshot = await invoke('openclaw_browser_dock_snapshot', { req: { profile: activeProfile, browserProfile: 'openclaw' } })
        if (disposed) return
        browserRuntimeRef.current = snapshot
        setBrowserRuntime(snapshot)
        const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : []
        const pendingTarget = pendingAgentTargetRef.current
        if (pendingTarget) {
          if (pendingTarget.expiresAt <= Date.now() || pendingTarget.sessionKey !== activeSessionKey) {
            pendingAgentTargetRef.current = null
          } else {
            const resolved = resolveBrowserDockTab(tabs, pendingTarget.targetRef)
            if (resolved) {
              pendingAgentTargetRef.current = null
              chooseBrowserDockTarget(resolved)
            }
          }
        }
        const selected = selectBrowserDockTab(tabs, browserTargetIdRef.current)
        const targetId = selected?.id || selected?.targetId || ''
        if (targetId !== browserTargetIdRef.current) chooseBrowserDockTarget(targetId)
        if (snapshot.status !== 'ready') {
          setBrowserFrame(null)
          setDockError(snapshot.message || 'Browser Runtime 尚未就绪。')
        }
      } catch (err) {
        if (!disposed) setDockError(String(err?.message || err || '读取 Browser Runtime 失败'))
      } finally {
        browserRuntimeRefreshBusyRef.current = false
      }
    }
    setBrowserLoading(true)
    refresh().finally(() => { if (!disposed) setBrowserLoading(false) })
    const timer = window.setInterval(refresh, 1000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [activeProfile, activeSessionKey, chooseBrowserDockTarget, mode])

  useEffect(() => {
    if (mode !== 'browser' || !activeProfile || !activeSessionKey) return undefined
    let disposed = false
    const unlistenPromise = listen('conversation-gateway-event', event => {
      if (disposed) return
      const payload = event?.payload || {}
      const snapshot = browserRuntimeRef.current
      const candidate = browserDockAgentTargetCandidate(payload, activeSessionKey, snapshot?.localManaged === true)
      if (!candidate || snapshot?.profile !== activeProfile) return
      const resolved = resolveBrowserDockTab(snapshot.tabs, candidate)
      if (resolved) {
        pendingAgentTargetRef.current = null
        chooseBrowserDockTarget(resolved)
      } else {
        pendingAgentTargetRef.current = { targetRef: candidate, sessionKey: activeSessionKey, expiresAt: Date.now() + 10000 }
      }
    })
    return () => {
      disposed = true
      unlistenPromise.then(unlisten => unlisten()).catch(() => null)
      if (disposed) pendingAgentTargetRef.current = null
    }
  }, [activeProfile, activeSessionKey, chooseBrowserDockTarget, mode])

  useEffect(() => {
    if (mode !== 'browser' || !activeProfile || !browserTargetId || browserRuntime?.status !== 'ready') return undefined
    let disposed = false
    let screenshotBusy = false
    lastBrowserStreamFrameRef.current = 0
    setBrowserFrame(null)
    setBrowserFrameMode('stream')
    const unlistenPromise = listen('openclaw-browser-frame', event => {
      if (disposed) return
      const frame = event.payload
      if (frame?.profile !== activeProfile || frame?.targetId !== browserTargetId) return
      lastBrowserStreamFrameRef.current = Date.now()
      setBrowserFrame(frame)
      setBrowserRuntime(current => {
        if (current?.profile !== activeProfile) return current
        const updated = { ...current, tabs: current.tabs.map(tab => (tab.id || tab.targetId) === browserTargetId ? { ...tab, url: frame.url || tab.url, title: frame.title || tab.title } : tab) }
        browserRuntimeRef.current = updated
        return updated
      })
      setBrowserFrameMode('stream')
      setDockError('')
    })
    unlistenPromise.then(async unlisten => {
      if (disposed) { unlisten(); return }
      await invoke('openclaw_browser_dock_stream_start', { req: { profile: activeProfile, targetId: browserTargetId } })
      if (disposed) await invoke('openclaw_browser_dock_stream_stop', { req: { profile: activeProfile, targetId: browserTargetId } })
    }).catch(err => { if (!disposed) setDockError(String(err?.message || err || '启动浏览器实时画面失败，正在尝试截图模式')) })
    const fallback = window.setInterval(async () => {
      if (disposed || screenshotBusy || Date.now() - lastBrowserStreamFrameRef.current < 1500) return
      screenshotBusy = true
      try {
        const startedAt = Date.now()
        const frame = await invoke('openclaw_browser_dock_action', { req: { profile: activeProfile, targetId: browserTargetId, action: 'frame' } })
        if (!disposed && lastBrowserStreamFrameRef.current < startedAt) { setBrowserFrame(frame); setBrowserFrameMode('screenshot') }
      } catch (err) {
        if (!disposed && !lastBrowserStreamFrameRef.current) setDockError(String(err?.message || err || '浏览器实时画面与截图均不可用'))
      } finally { screenshotBusy = false }
    }, 500)
    return () => {
      disposed = true
      window.clearInterval(fallback)
      unlistenPromise.then(unlisten => unlisten()).catch(() => null)
      invoke('openclaw_browser_dock_stream_stop', { req: { profile: activeProfile, targetId: browserTargetId } }).catch(() => null)
    }
  }, [activeProfile, browserRuntime?.status, browserTargetId, mode])

  useEffect(() => {
    if (mode !== 'tasks' || !activeProfile) return
    setDockError('')
    listAutomations(activeProfile)
      .then(result => setJobs(Array.isArray(result?.jobs) ? result.jobs : Array.isArray(result) ? result : []))
      .catch(err => setDockError(String(err?.message || err || '读取后台任务失败')))
  }, [activeProfile, mode])

  useEffect(() => {
    if (mode !== 'split') return
    const fallback = sessions.find(item => (item.sessionKey || item.key) !== activeSessionKey)
    setSplitSessionKey(current => current || fallback?.sessionKey || fallback?.key || '')
  }, [activeSessionKey, mode, sessions])

  useEffect(() => {
    if (mode !== 'split' || !activeProfile || !splitSessionKey) {
      if (mode === 'split') setSplitMessages([])
      return
    }
    setDockError('')
    loadConversationHistory(splitSessionKey, activeProfile, { includeSessionMeta: false })
      .then(history => setSplitMessages(history.messages || []))
      .catch(err => setDockError(String(err?.message || err || '读取拆分会话失败')))
  }, [activeProfile, mode, splitSessionKey])

  const title = mode === 'browser' ? '浏览器' : mode === 'tasks' ? '后台任务' : '拆分视图'
  const closeDock = () => {
    onClose()
  }
  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-[360px] max-w-[92vw] flex-col border-l border-default bg-surface-raised shadow-xl">
      <div className="flex h-12 shrink-0 border-b border-subtle items-center justify-between px-3">
        <span className="text-sm font-semibold text-primary">{title}</span>
        <button type="button" onClick={closeDock} className="rounded-md px-2 py-1 text-sm text-tertiary hover:bg-state-hover hover:text-primary" title="关闭侧边面板">×</button>
      </div>
      {dockError && <div className="mx-3 mt-3 rounded-md border border-rose-400/25 bg-rose-400/10 px-2.5 py-2 text-xs text-danger-text">{dockError}</div>}
      {mode === 'browser' && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <div className="flex items-center justify-between gap-2 text-xs text-tertiary">
            <span className="min-w-0 truncate" data-testid="browser-dock-title">{browserRuntime?.status === 'ready' ? `与 AI 共享的工作区浏览器 · ${browserFrameMode === 'stream' ? '实时画面' : '截图模式'}` : browserRuntime?.message || '等待工作区浏览器…'}</span>
            <div className="flex shrink-0 items-center gap-1">
              {browserRuntime?.tabs?.map(tab => <button key={tab.id || tab.targetId} type="button" onClick={() => chooseBrowserDockTarget(tab.id || tab.targetId)} title={tab.title || tab.url || '浏览器标签'} className={`max-w-20 truncate rounded px-1.5 py-1 ${browserTargetId === (tab.id || tab.targetId) ? 'bg-state-selected text-primary' : 'hover:bg-state-hover'}`}>{tab.title || '标签'}</button>)}
            </div>
          </div>
          <div data-testid="browser-dock-address" className="min-w-0 truncate rounded border border-subtle bg-surface-page px-2 py-1 text-2xs text-secondary" title={browserFrame?.url || browserRuntime?.tabs?.find(tab => (tab.id || tab.targetId) === browserTargetId)?.url || ''} aria-label="当前网页地址">
            {browserFrame?.title ? <span className="mr-1 font-medium text-primary">{browserFrame.title}</span> : null}
            {browserFrame?.url || browserRuntime?.tabs?.find(tab => (tab.id || tab.targetId) === browserTargetId)?.url || '尚未打开网页'}
          </div>
          <div ref={browserViewportRef} data-testid="browser-dock-viewport" className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-subtle bg-surface-page" aria-label="与 AI 共享的浏览器网页画面" role="application">
            {browserFrame?.image ? <img ref={browserFrameImageRef} data-testid="browser-dock-image" src={browserFrame.image} alt={browserFrame.title || '当前网页'} draggable="false" className="absolute inset-0 h-full w-full select-none object-contain" /> : <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-tertiary">{browserLoading ? '正在同步共享浏览器画面…' : browserRuntime?.status === 'ready' ? 'AI 尚未打开网页。你可以在对话中让 AI 打开网页，这里会显示同一个页面。' : browserRuntime?.message || '请在运行中心连接工作区浏览器。'}</div>}
            <textarea ref={browserKeyboardInputRef} aria-label="浏览器网页键盘输入" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} onClick={event => { if (!browserFrame) return; const rect = event.currentTarget.getBoundingClientRect(); const point = mapBrowserDockPointer(event.clientX, event.clientY, rect, browserFrameImageRef.current?.naturalWidth || browserFrame.width, browserFrameImageRef.current?.naturalHeight || browserFrame.height); if (point) runBrowserDockAction('click', point) }} onWheel={event => { event.preventDefault(); if (!browserFrame) return; const rect = event.currentTarget.getBoundingClientRect(); const point = mapBrowserDockPointer(event.clientX, event.clientY, rect, browserFrameImageRef.current?.naturalWidth || browserFrame.width, browserFrameImageRef.current?.naturalHeight || browserFrame.height); if (point) runBrowserDockAction('scroll', { ...point, deltaX: event.deltaX, deltaY: event.deltaY }) }} onCompositionStart={event => forwardBrowserKeyboardEvent('compositionstart', event)} onCompositionUpdate={event => forwardBrowserKeyboardEvent('compositionupdate', event)} onCompositionEnd={event => { forwardBrowserKeyboardEvent('compositionend', event); event.currentTarget.value = '' }} onKeyDown={event => forwardBrowserKeyboardEvent('keydown', event)} onInput={event => { const native = event.nativeEvent; const transition = browserDockKeyboardTransition(browserCompositionRef.current, { type: 'input', data: native?.data, value: event.currentTarget.value, inputType: native?.inputType }); browserCompositionRef.current = { composing: transition.composing, suppressNextCommitKey: transition.suppressNextCommitKey, suppressCompositionInput: transition.suppressCompositionInput }; if (transition.action?.type === 'text') runBrowserDockAction('text', { text: transition.action.text }); if (!transition.composing) event.currentTarget.value = '' }} onPaste={event => { const text = event.clipboardData.getData('text'); if (text) { event.preventDefault(); runBrowserDockAction('text', { text }) } }} className="absolute inset-0 h-full w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-transparent caret-transparent opacity-[0.01] outline-none" />
          </div>
          <p className="text-2xs leading-4 text-tertiary">你和 AI 在同一页面操作。点击网页后可输入文字或滚动。</p>
        </div>
      )}
      {mode === 'tasks' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {jobs.length === 0 ? <div className="rounded-md border border-subtle p-3 text-xs leading-5 text-tertiary">当前 Profile 没有后台定时任务。可在“自动化”页创建任务；任务运行产生的 cron/subagent 会话会回到会话列表。</div> : jobs.map(job => <div key={job.id || job.name} className="mb-2 rounded-md border border-subtle p-2.5"><div className="text-sm font-medium text-primary">{job.name || job.id}</div><div className="mt-1 text-xs text-tertiary">{job.enabled === false ? '已暂停' : '已启用'} · {job.schedule?.kind || job.schedule?.expr || '计划任务'}</div></div>)}
        </div>
      )}
      {mode === 'split' && (
        <div className="flex min-h-0 flex-1 flex-col p-3">
          <select value={splitSessionKey} onChange={event => setSplitSessionKey(event.target.value)} className="mb-3 h-8 rounded-md border border-subtle bg-transparent px-2 text-xs text-primary outline-none">
            <option value="">选择另一段会话</option>
            {sessions.filter(item => (item.sessionKey || item.key) !== activeSessionKey).map(item => <option key={item.sessionKey || item.key} value={item.sessionKey || item.key}>{formatSessionTitle(item)}</option>)}
          </select>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-md border border-subtle p-3">
            {splitMessages.length === 0 ? <div className="text-xs leading-5 text-tertiary">选择一段会话，在此并排只读查看；主对话不会被中断。</div> : splitMessages.map(message => <div key={message.id} className="text-xs leading-5"><div className="mb-0.5 font-medium text-secondary">{message.role === 'user' ? '你' : '助手'}</div><div data-selectable="true" className="whitespace-pre-wrap text-primary">{message.content}</div></div>)}
          </div>
        </div>
      )}
    </aside>
  )
}

function orderEmployeesForChat(items) {
  return [...items].sort((a, b) => {
    const aDefault = Boolean(a.isDefault)
    const bDefault = Boolean(b.isDefault)
    if (aDefault !== bDefault) return aDefault ? -1 : 1
    const aKey = String(a.name || a.id || '')
    const bKey = String(b.name || b.id || '')
    return aKey.localeCompare(bKey, 'zh-CN')
  })
}

function messageTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export default function Conversations() {
  const { user } = useAuth()
  const activeOpenClaw = useActiveOpenClawProfile()
  const workspace = useProfileWorkspace()
  const profile = workspace ? workspace.activeProfile : activeOpenClaw.activeProfile || ''
  // An account/Profile switch creates a fresh composer. Async completions from
  // the old one cannot populate the new user's draft, roster or outbox.
  return <ConversationWorkspace key={`${user?.uid || ''}:${profile}`} />
}

function ConversationWorkspace() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user, profile } = useAuth()
  const activeOpenClaw = useActiveOpenClawProfile()
  const profileWorkspace = useProfileWorkspace()
  const profileWorkspaceState = profileWorkspaceNavigationState(profileWorkspace)
  const workspaceProfile = profileWorkspace || activeOpenClaw.workspaceProfile
  const runtime = useRuntimeStatusStore()
  const storageOwnerId = user?.uid || null
  const [searchParams, setSearchParams] = useSearchParams()
  const [employees, setEmployees] = useState([])
  const [conversations, setConversations] = useState(() => listStoredConversations(storageOwnerId))
  // Pending user turns live outside persisted transcript history. A history
  // request may finish after send, but it must never erase the just-sent bubble.
  const [activeOptimisticUserMessage, setActiveOptimisticUserMessage] = useState(null)
  const [conversationOwnerId, setConversationOwnerId] = useState(storageOwnerId)
  const [readMarks, setReadMarks] = useState(() => readConversationReadMarks(storageOwnerId))
  const [historyRefreshNonce, setHistoryRefreshNonce] = useState(0)
  const [selectedSessionByEmployee, setSelectedSessionByEmployee] = useState({})
  const [conversationSessions, setConversationSessions] = useState([])
  const [conversationSessionsLoading, setConversationSessionsLoading] = useState(false)
  const [conversationSessionsError, setConversationSessionsError] = useState('')
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false)
  const [sessionSearch, setSessionSearch] = useState('')
  const [creatingConversationSession, setCreatingConversationSession] = useState(false)
  const [editingSessionKey, setEditingSessionKey] = useState('')
  const [editingSessionLabel, setEditingSessionLabel] = useState('')
  const [renamingSessionKey, setRenamingSessionKey] = useState('')
  const [input, setInput] = useState('')
  const [imageAttachments, setImageAttachments] = useState([])
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const [sendingConversationIds, setSendingConversationIds] = useState(() => new Set())
  const [streamingAssistantTextByConversation, setStreamingAssistantTextByConversation] = useState({})
  const [reasoningPanelByConversation, setReasoningPanelByConversation] = useState({})
  const [toolTimelineByConversation, setToolTimelineByConversation] = useState({})
  // Finished process strips persist keyed by their answer message id (history
  // messages carry no runId), so "已处理 · N个工具" stays with the reply across
  // turns and page reloads instead of living only in ephemeral live state.
  const [toolTimelineByMessageId, setToolTimelineByMessageId] = useState(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem('imai.tool-timelines.v1') || '{}')
      return stored && typeof stored === 'object' ? stored : {}
    } catch {
      return {}
    }
  })
  const [expandedProcessMsgIds, setExpandedProcessMsgIds] = useState(() => new Set())
  const [, setToolTimelineTick] = useState(0)
  const [scrollFabVisible, setScrollFabVisible] = useState(false)
  const [copiedMessageId, setCopiedMessageId] = useState('')
  // Track hover in JS rather than CSS group-hover: the Tauri/Chromium webview can
  // leave :hover "stuck" when the message list re-renders (streaming/scroll)
  // without a mouse-move, so the copy affordance would linger after the pointer left.
  const [hoveredMessageId, setHoveredMessageId] = useState('')
  const [pendingGatewayRunByConversation, setPendingGatewayRunByConversation] = useState({})
  // Last time a gateway frame touched each conversation. Feeds the lost-run
  // watchdog: a turn whose `final` frame never arrives would otherwise spin
  // forever, because a healthy socket produces neither seq_gap nor reconnect.
  const gatewayActivityAtRef = useRef({})
  // Profile+session this page last issued a subscribe for, so a transcript
  // refresh does not re-subscribe to a session it is already subscribed to.
  const subscribedSessionRef = useRef('')
  // A matching `aborted` event is expected after a user presses Stop. Keep the
  // marker local to this page so an unrelated Gateway abort still remains
  // visible as a failure.
  const userCancelledGatewayRunRef = useRef(null)
  // The gateway-event listener is intentionally installed once. Keep its
  // durable-outbox scope fresh without making a reconnect re-register it.
  const outboxIdentityRef = useRef(null)
  const [chatNotice, setChatNotice] = useState('')
  // Accio-style "send while running" queue: messages typed during an in-flight
  // turn are held per-conversation and drained one-by-one once the turn ends
  // (final/error/aborted). This is a product-layer queue between turns — NOT the
  // gateway `chat.inject` mid-turn steering primitive.
  const [outboxEntries, setOutboxEntries] = useState(() => listConversationOutbox(storageOwnerId))
  const [loadingEmployees, setLoadingEmployees] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [error, setError] = useState('')
  const [rightPaneMode, setRightPaneMode] = useState('chat')
  const [conversationDock, setConversationDock] = useState(null)
  const [browserTargetByProfile, setBrowserTargetByProfile] = useState({})
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false)
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false)
  const [sessionActionLoading, setSessionActionLoading] = useState(false)
  const [processExpandedByConversation, setProcessExpandedByConversation] = useState({})
  const [approvalMode, setApprovalMode] = useState('default')
  const permissionCoordinatorRef = useRef(createConversationPermissionCoordinator())
  const permissionScopeRef = useRef(null)
  const [permissionSaveVersion, setPermissionSaveVersion] = useState(0)
  const sessionListRequestRef = useRef(0)
  const execApprovalRefreshRef = useRef({ profile: '', revision: 0, request: 0 })
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false)
  const [pendingPluginApprovals, setPendingPluginApprovals] = useState([])
  const [resolvingPluginApprovalId, setResolvingPluginApprovalId] = useState('')
  const [pendingExecApprovals, setPendingExecApprovals] = useState([])
  const [resolvingExecApprovalId, setResolvingExecApprovalId] = useState('')
  const [selectedModelOverride, setSelectedModelOverride] = useState('')
  const [modelSnapshot, setModelSnapshot] = useState(null)
  const modelSnapshotRequestRef = useRef(0)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [llmBalance, setLlmBalance] = useState(null)
  const [voiceListening, setVoiceListening] = useState(false)
  // 云端听写(非 macOS):录音已停、转写还在路上。期间麦克风按钮锁定。
  const [voiceProcessing, setVoiceProcessing] = useState(false)
  const [nativeVoicePartial, setNativeVoicePartial] = useState('')
  // 云端听写的录音 controller(startAudioRecording 返回值);native 路径不用。
  const cloudDictationRef = useRef(null)
  // 组件卸载后云端转写轮询立即停手,不再 setState。
  const voiceDisposedRef = useRef(false)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const imeCompositionRef = useRef(false)
  const imageDragDepthRef = useRef(0)
  const composerRef = useRef(null)
  const mentionListRef = useRef(null)
  const mentionAutoScrollRef = useRef(false)
  const slashMentionResourcesRefreshKeyRef = useRef('')
  const sessionPickerRef = useRef(null)
  const sessionActionMenuRef = useRef(null)
  const conversationScrollPinnedRef = useRef(true)
  const lastAutoScrolledConversationRef = useRef(null)
  // Conversations whose turn hit `final` but whose reloaded history has not
  // landed yet — their streaming bubble must survive until the reload commits.
  const finalizedGatewayConversationsRef = useRef(new Set())
  const [mentionResources, setMentionResources] = useState(EMPTY_MENTION_RESOURCES)
  const [mentionResourcesLoading, setMentionResourcesLoading] = useState(false)
  const [mentionResourcesError, setMentionResourcesError] = useState('')
  const [mentionQuery, setMentionQuery] = useState(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const employeeIdFromUrl = searchParams.get('agent')
  const activeProfile = profileWorkspace ? profileWorkspace.activeProfile : activeOpenClaw.activeProfile || ''
  const rememberBrowserTarget = useCallback(targetId => {
    if (!activeProfile) return
    setBrowserTargetByProfile(current => ({ ...current, [activeProfile]: targetId }))
  }, [activeProfile])
  const gatewayPort = profileWorkspace ? profileWorkspace.gatewayPort : workspaceProfile?.gatewayPort || workspaceProfile?.gateway_port || null
  const runtimeOpenClawStatus = runtime.openClaw.status
  const gatewayConnectionSnapshot = getGatewayConnectionSnapshot(activeProfile, gatewayPort)
  const gatewayReady = Boolean(
    activeProfile && isGatewayConnectionReady(gatewayConnectionSnapshot),
  )
  const deferOpenClawDirectoryHydration = shouldDeferOpenClawDirectoryHydration({
    userId: user?.uid,
    workspaceProfileLoading: profileWorkspace ? profileWorkspace.loading : activeOpenClaw.loading,
  })
  const useCloudEmployeeDirectory = false

  useEffect(() => {
    outboxIdentityRef.current = { ownerId: storageOwnerId, profile: activeProfile }
  }, [storageOwnerId, activeProfile])

  useEffect(() => {
    let disposed = false
    let unlisten = null
    const appWindow = getCurrentWindow()
    const appWebview = getCurrentWebview()
    appWebview.onDragDropEvent(async event => {
      const payload = event.payload || {}
      const position = payload.position
      const isMacOS = /Mac/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`)
      const scaleFactor = isMacOS ? 1 : await appWindow.scaleFactor().catch(() => 1)
      const rect = composerRef.current?.getBoundingClientRect()
      const point = nativeDragPositionToViewport(position, {
        eventType: payload.type,
        platform: isMacOS ? 'macos' : 'other',
        scaleFactor,
        viewportHeight: window.innerHeight,
      })
      const insideComposer = Boolean(rect && point
        && point.x >= rect.left
        && point.x <= rect.right
        && point.y >= rect.top
        && point.y <= rect.bottom)
      if (payload.type === 'drop') {
        setIsDraggingFiles(false)
        if (insideComposer) addNativeAttachmentPaths(payload.paths)
      } else if (payload.type === 'enter' || payload.type === 'over') {
        setIsDraggingFiles(insideComposer)
      } else {
        setIsDraggingFiles(false)
      }
    }).then(stopListening => {
      if (disposed) stopListening()
      else unlisten = stopListening
    }).catch(() => null)
    return () => {
      disposed = true
      unlisten?.()
      setIsDraggingFiles(false)
    }
  }, [activeProfile, imageAttachments.length])

  const conversationRoster = useMemo(
    () => buildConversationRoster({ employees, conversations, readMarks }),
    [employees, conversations, readMarks],
  )

  useEffect(() => {
    setConversations(listStoredConversations(storageOwnerId))
    setActiveOptimisticUserMessage(null)
    setConversationOwnerId(storageOwnerId)
    setReadMarks(readConversationReadMarks(storageOwnerId))
  }, [storageOwnerId])

  useEffect(() => {
    if (conversationOwnerId !== storageOwnerId) return
    saveStoredConversations(storageOwnerId, conversations)
  }, [conversationOwnerId, conversations, storageOwnerId])

  useEffect(() => {
    if (conversationOwnerId !== storageOwnerId) return
    writeConversationReadMarks(storageOwnerId, readMarks)
  }, [conversationOwnerId, readMarks, storageOwnerId])

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      if (deferOpenClawDirectoryHydration || !gatewayReady) {
        // Even while directory hydration is deferred, paint the last-known local
        // roster so the list isn't blank during the wait.
        const cached = activeProfile ? readPersistedLocalEmployees(activeProfile) : []
        setEmployees(cached.length > 0 ? orderEmployeesForChat(cached) : [])
        setLoadingEmployees(cached.length === 0)
        setError('')
        return
      }
      if (activeProfile) {
        ensureConversationBridgeStatus({ profile: activeProfile }).catch(() => null)
      }
      if (!useCloudEmployeeDirectory) {
        ensureOpenClawStatus().catch(() => null)
      }
      try {
        if (!cancelled) {
          await Promise.all([
            hydrateEmployees(activeProfile),
          ])
        }
      } catch {
        // hydrateEmployees keeps its cached roster on failure; don't blank the list here.
      }
    }

    bootstrap()

    return () => {
      cancelled = true
    }
  }, [workspaceProfile, activeProfile, deferOpenClawDirectoryHydration, gatewayReady, useCloudEmployeeDirectory, user?.uid])

  const activeTargetSelection = resolveActiveConversationTarget({
    employeeIdFromUrl,
    employees,
    roster: conversationRoster,
  })
  const activeEmployeeId = activeTargetSelection?.type === 'employee' ? activeTargetSelection.id : null

  useEffect(() => {
    if (!activeEmployeeId) return
    ensureConversationRecord(activeEmployeeId, employees)
  }, [activeEmployeeId, employees])


  useEffect(() => {
    if (!activeEmployeeId) return
    if (employeeIdFromUrl === activeEmployeeId) return
    setSearchParams({ agent: activeEmployeeId }, { replace: true })
  }, [activeEmployeeId, employeeIdFromUrl, setSearchParams])


  const activeEmployee = employees.find(item => item.id === activeEmployeeId) || null
  const activeTarget = activeEmployee
  // Explicit pick first; otherwise default to the NEWEST session in the picker
  // (list is recency-sorted), not the hardcoded `agent:<id>:main` — that main
  // session is usually the oldest, so the old default put the check mark on
  // the bottom row. `defaultConversationSessionKey` ignores rows still
  // belonging to a previously active employee and falls back to `:main`.
  const selectedEmployeeSessionKey = activeEmployee
    ? selectedSessionByEmployee[activeEmployee.id] ||
      outboxEntries.find(entry => entry.profile === activeProfile
        && entry.employeeId === activeEmployee.id && entry.status === OUTBOX_STATUS.queued)?.sessionKey ||
      defaultConversationSessionKey({ employeeId: activeEmployee.id, sessions: conversationSessions })
    : ''
  const activeConversationId = activeEmployee
    ? buildConversationSessionRecordId(activeEmployee.id, selectedEmployeeSessionKey)
    : null
  const activeConversation =
    conversations.find(item => item.id === activeConversationId) ||
    null
  const activeConversationSessionKey = activeEmployee
    ? activeConversation?.gatewaySessionKey || selectedEmployeeSessionKey || buildSessionKey(activeEmployee.id)
    : ''
  const activeConversationRouteReady = Boolean(
    activeEmployee
      && activeConversation
      && activeConversation.employeeId === activeEmployee.id
      && sessionKeyBelongsToEmployee({
        employeeId: activeEmployee.id,
        sessionKey: activeConversationSessionKey,
      }),
  )
  const activePendingGatewayRunId = activeConversationId
    ? pendingGatewayRunByConversation[activeConversationId] || ''
    : ''
  // A gateway session can be re-keyed while its first streaming frame arrives.
  // Keep the one locally accepted user turn visible independently of that
  // mutable session/run identity; the merge folds it into the canonical row.
  const activeOptimisticMessages = activeOptimisticUserMessage?.conversationId === activeConversationId
    ? [activeOptimisticUserMessage]
    : []
  const activeMessages = mergeConversationOptimisticMessages(
    activeConversation?.messages,
    activeOptimisticMessages,
  )
  const hasPendingTurn = activeMessages.some(message => ['sending', 'streaming'].includes(message.status))
  const activeSending = Boolean(activeConversationId && sendingConversationIds.has(activeConversationId))
  const activeTargetType = activeTargetSelection?.type || ''
  const activeTargetId = activeTargetSelection?.id || ''
  const activeLatestMessageAt = activeMessages.reduce(
    (latest, message) => Math.max(latest, Number.isFinite(message?.createdAt) ? message.createdAt : 0),
    0,
  )
  useEffect(() => {
    // Viewing a target clears its unread badge: advance the read marker to the
    // newest message we're already showing (or now, for an empty thread).
    if (!activeTargetId || !activeTargetType) return
    setReadMarks(prev => markConversationTargetRead(prev, activeTargetType, activeTargetId, activeLatestMessageAt || Date.now()))
  }, [activeTargetType, activeTargetId, activeLatestMessageAt])
  useEffect(() => {
    // Drop any manual expand/collapse override when the turn or conversation
    // changes, so the strip falls back to its auto (open-while-running) default.
    // Declared after activePendingGatewayRunId so the dep is initialized (no TDZ).
    if (!activeConversationId) return
    setProcessExpandedByConversation(prev => {
      if (!(activeConversationId in prev)) return prev
      const next = { ...prev }
      delete next[activeConversationId]
      return next
    })
  }, [activeConversationId, activePendingGatewayRunId])
  const activeStreamingAssistantText = activeConversationId
    ? streamingAssistantTextByConversation[activeConversationId] || ''
    : ''
  const activeReasoningPanel = activeConversationId
    ? reasoningPanelByConversation[activeConversationId] || null
    : null
  const activeToolTimeline = activeConversationId
    ? toolTimelineByConversation[activeConversationId] || null
    : null
  const activeProcessRunning =
    Boolean(activeReasoningPanel?.streaming) ||
    Boolean(activeToolTimeline && activeToolTimeline.steps.length > 0 && !activeToolTimeline.finishedAt)
  // The merged process strip auto-opens while a turn runs and auto-collapses
  // when it finishes; an explicit user toggle overrides until the next turn.
  const activeProcessExpanded = activeConversationId && (activeConversationId in processExpandedByConversation)
    ? processExpandedByConversation[activeConversationId]
    : activeProcessRunning
  // Accio-style single reply block: the process strip ("已处理 Ns") renders at the
  // TOP of the assistant turn it belongs to, with the answer below — one avatar,
  // one bubble group. During a live turn it sits above the streaming bubble; once
  // finished it moves above its answer message (the last assistant message).
  const activeProcessStripVisible =
    Boolean(activeReasoningPanel || (activeToolTimeline && activeToolTimeline.steps.length > 0))
  // Persist the archive so finished strips survive reloads (cap to bound storage).
  useEffect(() => {
    try {
      const entries = Object.entries(toolTimelineByMessageId)
      const capped = entries.length > 300 ? Object.fromEntries(entries.slice(-300)) : toolTimelineByMessageId
      window.localStorage.setItem('imai.tool-timelines.v1', JSON.stringify(capped))
    } catch {
      /* storage full / unavailable — keep the in-memory copy */
    }
  }, [toolTimelineByMessageId])
  // Once a turn's tool timeline finishes (and the answer message has loaded from
  // history), archive it onto that answer message so it stays with the reply.
  useEffect(() => {
    if (activePendingGatewayRunId) return
    const timeline = activeToolTimeline
    if (!timeline || !timeline.finishedAt || timeline.steps.length === 0) return
    let hostId = ''
    for (let i = activeMessages.length - 1; i >= 0; i -= 1) {
      if (activeMessages[i]?.role === 'assistant') {
        hostId = String(activeMessages[i].id ?? '')
        break
      }
    }
    if (!hostId) return
    setToolTimelineByMessageId(prev => (prev[hostId] ? prev : { ...prev, [hostId]: timeline }))
  }, [activeToolTimeline, activePendingGatewayRunId, activeMessages, activeConversationId])
  const hasPendingGatewayRun = Boolean(activePendingGatewayRunId)
  const turnInFlight = activeSending || hasPendingTurn || hasPendingGatewayRun
  const activeQueuedMessages = activeConversationId
    ? outboxEntriesFor(outboxEntries, activeConversationId, activeProfile)
    : EMPTY_QUEUED_MESSAGES
  const activeStreamingMessage =
    activeMessages.find(message => message.role === 'assistant' && message.status === 'streaming' && message.runId) ||
    (activePendingGatewayRunId ? { runId: activePendingGatewayRunId } : null)
  const hasMessages = activeMessages.length > 0 || hasPendingGatewayRun
  const activeApprovalMode = findConversationApprovalMode(approvalMode)
  const currentUserDisplayName = accountDisplayName({ user, profile })
  const currentUserAvatarUrl = accountAvatarUrl({ user, profile })
  const activeEmployeeModelRef =
    runtimeOpenClawStatus?.resolvedDefaultModel ||
    runtimeOpenClawStatus?.defaultModel ||
    activeEmployee?.model ||
    activeEmployee?.defaultModel ||
    ''
  const activeProfileDefaultModelRef = profileDefaultModelRefFromSnapshot(modelSnapshot, activeEmployeeModelRef)
  // Official chat catalog (names/badges/multipliers) — cached by
  // uniopcOfficialModel.js, refreshed on every successful connect.
  const [officialModelCatalog, setOfficialModelCatalog] = useState(getOfficialModelCatalog)
  useEffect(() => subscribeOfficialModelCatalog(setOfficialModelCatalog), [])
  const [officialModelStatus, setOfficialModelStatus] = useState(getOfficialModelStatus)
  useEffect(() => subscribeOfficialModelStatus(setOfficialModelStatus), [])
  const conversationModelChoices = useMemo(
    () => conversationModelChoicesFromSnapshot(modelSnapshot, activeEmployeeModelRef, officialModelCatalog),
    [activeEmployeeModelRef, modelSnapshot, officialModelCatalog],
  )
  const modelChipRef = selectedModelOverride || activeProfileDefaultModelRef
  // Official models show their catalog display name in the bottom-bar chip
  // (e.g. "Qwen-3.7" instead of the raw "uniopc-default" id).
  const modelChipLabel = (() => {
    const ref = String(modelChipRef || '').trim()
    if (ref.startsWith(`${UNIOPC_OFFICIAL_PROVIDER}/`)) {
      const id = ref.slice(UNIOPC_OFFICIAL_PROVIDER.length + 1)
      // The default may be referenced by the fixed `uniopc-default` id OR by
      // the (renameable) public alias the profile default resolved to.
      const entry = officialModelCatalog.find(item => item.id === id)
        || (id === 'uniopc-default' ? officialModelCatalog.find(item => item.isDefault) : null)
      const name = entry?.displayName || (entry && entry.id !== 'uniopc-default' ? entry.id : '')
      if (name) return name
    }
    return formatConversationModelChip(ref)
  })()
  const profileChatReadiness = deriveProfileChatReadiness({
    activeProfile,
    gatewayReady,
    officialModelState: officialModelStatus.state,
    officialModelProfile: officialModelStatus.profile,
    officialModelError: officialModelStatus.error,
    modelLabel: modelChipLabel,
  })
  const conversationModelReady = Boolean(!activeEmployee || profileChatReadiness.sendReady)

  useEffect(() => {
    setApprovalMenuOpen(false)
    setModelMenuOpen(false)
    setAttachmentMenuOpen(false)
    setSessionMenuOpen(false)
    setSessionPickerOpen(false)
    setSelectedModelOverride('')
    setEditingSessionKey('')
    setEditingSessionLabel('')
    setRenamingSessionKey('')
  }, [activeConversationId])

  useEffect(() => {
    if (!selectedModelOverride) return
    if (conversationModelChoices.some(choice => choice.modelRef === selectedModelOverride && choice.selectable)) return
    setSelectedModelOverride('')
  }, [conversationModelChoices, selectedModelOverride])

  // Refresh the official-model credit balance whenever the model menu opens.
  useEffect(() => {
    if (!modelMenuOpen) return
    fetchLlmCreditBalance()
      .then(balance => {
        if (typeof balance === 'number') setLlmBalance(balance)
      })
      .catch(() => null)
  }, [modelMenuOpen])

  const activeSessionTitle = useMemo(() => {
    const session = conversationSessions.find(item => item.sessionKey === activeConversationSessionKey || item.key === activeConversationSessionKey)
    return formatSessionTitle(session || activeConversation, activeEmployee ? displayEmployeeName(activeEmployee) : '主聊天')
  }, [activeConversation, activeConversationSessionKey, activeEmployee, conversationSessions])

  const activeGatewaySession = useMemo(
    () => conversationSessions.find(item => (item.sessionKey || item.key) === activeConversationSessionKey) || null,
    [activeConversationSessionKey, conversationSessions],
  )

  permissionScopeRef.current = { profile: activeProfile, sessionKey: activeConversationSessionKey }
  if (execApprovalRefreshRef.current.profile !== activeProfile) {
    execApprovalRefreshRef.current = { profile: activeProfile, revision: 0, request: 0 }
  }

  useEffect(() => {
    setApprovalMode(permissionCoordinatorRef.current.mode(activeProfile, activeConversationSessionKey))
  }, [activeProfile, activeConversationSessionKey, activeGatewaySession?.permissionMode, permissionSaveVersion])

  const refreshConversationSessions = useCallback(async ({ silent = false } = {}) => {
    if (!gatewayReady) return
    if (!activeEmployee) {
      setConversationSessions([])
      setConversationSessionsError('')
      setConversationSessionsLoading(false)
      return
    }
    if (!activeProfile) {
      setConversationSessions([])
      setConversationSessionsError('请先完成本机 Uniopc 引擎 Host 初始化，再读取聊天记录。')
      setConversationSessionsLoading(false)
      return
    }
    if (!silent) {
      setConversationSessionsLoading(true)
      setConversationSessionsError('')
    }
    const request = ++sessionListRequestRef.current
    const permissionRevision = permissionCoordinatorRef.current.snapshot()
    try {
      const result = await listConversationSessions({
        agentId: activeEmployee.id,
        profile: activeProfile,
        search: sessionSearch,
        limit: 50,
      })
      // Frontend recency guarantee: never trust the gateway's list order (it
      // is undocumented), and never let a fresh session sink to the bottom.
      if (request !== sessionListRequestRef.current || permissionScopeRef.current?.profile !== activeProfile) return
      const sessions = sortConversationSessionsByRecency(
        permissionCoordinatorRef.current.observe(activeProfile, result.sessions || [], permissionRevision),
      )
      setPermissionSaveVersion(version => version + 1)
      setConversationSessions(sessions)
      sessions.forEach(session => {
        const key = session.sessionKey || session.key
        if (key) {
          ensureConversationRecord(activeEmployee.id, employees, key, formatSessionTitle(session, displayEmployeeName(activeEmployee)))
        }
      })
      setConversationSessionsError('')
    } catch (err) {
      if (request === sessionListRequestRef.current && permissionScopeRef.current?.profile === activeProfile) setConversationSessionsError(String(err?.message || err || '读取 Gateway 聊天记录失败'))
    } finally {
      if (request === sessionListRequestRef.current && permissionScopeRef.current?.profile === activeProfile) setConversationSessionsLoading(false)
    }
  }, [activeEmployee, activeProfile, employees, sessionSearch, gatewayReady])

  useEffect(() => {
    refreshConversationSessions({ silent: false }).catch(() => null)
  }, [activeEmployee?.id, activeProfile, historyRefreshNonce, refreshConversationSessions])

  const loadMentionResources = useCallback(async ({ silent = false } = {}) => {
    if (!gatewayReady) return
    if (!activeEmployee) {
      setMentionResources(EMPTY_MENTION_RESOURCES)
      setMentionResourcesError('')
      return
    }
    if (!activeProfile) {
      setMentionResources(EMPTY_MENTION_RESOURCES)
      setMentionResourcesError('请先完成本机 Uniopc 引擎 Host 初始化，再读取 Uniopc 引擎 能力。')
      return
    }
    if (!silent) {
      setMentionResourcesLoading(true)
      setMentionResourcesError('')
    }

    let loadingSettled = false
    try {
      const activeEmployeeAgentId = activeEmployee?.openclawAgentId || activeEmployee?.id || ''
      if (!silent) {
        setMentionResources(current => mergeMentionResources(current, {
          mcps: [],
          skills: [],
          toolPlugins: [],
        }))
      }
      const mcpPromise = engineClient.plugins.listMcpServers({ profile: activeProfile })
      const skillPromise = engineClient.agents.skillhubSnapshot({ profile: activeProfile })
      const toolCapabilityPromise = engineClient.plugins.listToolCapabilities({ profile: activeProfile })
      const documentResourcePromises = [
        listLocalDocuments('', { profile: activeProfile }),
      ]
      const toolCapabilityResult = await Promise.allSettled([toolCapabilityPromise]).then(results => results[0])
      const toolPlugins = toolCapabilityResult.status === 'fulfilled' && Array.isArray(toolCapabilityResult.value?.plugins)
        ? toolCapabilityResult.value.plugins
        : []
      setMentionResources(current => mergeMentionResources(current, {
        toolPlugins,
        documents: [],
      }))
      if (!silent) {
        setMentionResourcesLoading(mentionResourcesLoadingAfterCoreResult({
          loading: true,
          toolPlugins,
          pendingMcp: true,
          pendingSkills: true,
        }))
        loadingSettled = toolPlugins.some(plugin => plugin?.status === 'ready')
      }

      const [mcpResult, skillResult] = await Promise.allSettled([mcpPromise, skillPromise])
      const mcps = mcpResult.status === 'fulfilled' && Array.isArray(mcpResult.value?.servers)
        ? mcpResult.value.servers
        : []
      const skillSnapshot = skillResult.status === 'fulfilled' ? skillResult.value : null
      const profileSkills = Array.isArray(skillSnapshot?.skills) ? skillSnapshot.skills : []
      const activeAgentSkills = Array.isArray(skillSnapshot?.agents)
        ? skillSnapshot.agents.find(agent => agent?.id === activeEmployeeAgentId)?.skills
        : []
      const assignedSkillNames = new Set(
        (Array.isArray(activeAgentSkills) ? activeAgentSkills : [])
          .map(name => String(name || '').trim())
          .filter(Boolean),
      )
      const skills = selectAgentVisibleSkills(profileSkills, assignedSkillNames, toolPlugins)
      const baseResources = {
        plugins: [],
        mcps,
        skills,
        toolPlugins,
        documents: [],
      }
      setMentionResources(current => mergeMentionResources(current, baseResources))
      slashMentionResourcesRefreshKeyRef.current = `${activeProfile}:${activeEmployeeAgentId}`

      const failures = [mcpResult, skillResult, toolCapabilityResult]
        .filter(result => result.status === 'rejected')
      setMentionResourcesError(failures.length === 3
        ? '暂时读取不到 Uniopc 引擎 能力列表，请检查当前 profile 的 Gateway。'
        : '')
      if (!silent) {
        setMentionResourcesLoading(false)
        loadingSettled = true
      }
      const [documentResult] = await Promise.allSettled(documentResourcePromises)
      const documents = documentResult.status === 'fulfilled' && Array.isArray(documentResult.value)
        ? documentResult.value
        : []
      setMentionResources(current => mergeMentionResources(current, {
        documents,
      }))
    } finally {
      if (!silent && !loadingSettled) setMentionResourcesLoading(false)
    }
  }, [activeEmployee, activeProfile, gatewayReady])

  useEffect(() => () => {
    voiceDisposedRef.current = true
    invoke('native_voice_input_cancel').catch(() => {})
    cloudDictationRef.current?.cancel?.()
    cloudDictationRef.current = null
  }, [])

  const refreshModelSnapshot = useCallback(async () => {
    if (deferOpenClawDirectoryHydration || !activeProfile || !gatewayReady) {
      if (deferOpenClawDirectoryHydration || !activeProfile) setModelSnapshot(null)
      return null
    }

    const requestId = modelSnapshotRequestRef.current + 1
    modelSnapshotRequestRef.current = requestId
    try {
      const snapshot = await engineClient.models.snapshot({ profile: activeProfile })
      if (modelSnapshotRequestRef.current === requestId) setModelSnapshot(snapshot)
      return snapshot
    } catch {
      if (modelSnapshotRequestRef.current === requestId) setModelSnapshot(null)
      return null
    }
  }, [activeProfile, deferOpenClawDirectoryHydration, gatewayReady])

  useEffect(() => {
    if (deferOpenClawDirectoryHydration || !activeProfile) {
      setModelSnapshot(null)
      return undefined
    }
    if (!gatewayReady) {
      return undefined
    }

    refreshModelSnapshot().catch(() => null)
    return () => {
      modelSnapshotRequestRef.current += 1
    }
  }, [activeProfile, gatewayReady, refreshModelSnapshot])

  useEffect(() => {
    if (
      !activeProfile
      || !gatewayReady
      || officialModelStatus.profile !== activeProfile
      || officialModelStatus.state !== 'connected'
    ) return
    refreshModelSnapshot().catch(() => null)
  }, [
    activeProfile,
    gatewayReady,
    officialModelStatus.profile,
    officialModelStatus.state,
    refreshModelSnapshot,
  ])

  useEffect(() => {
    let cancelled = false
    let disposeSnapshot = null

    listen('project-snapshot-changed', (event) => {
      if (deferOpenClawDirectoryHydration) return
      if (useCloudEmployeeDirectory) return
      const payload = event?.payload || {}
      const source = String(payload.source || '')
      const sameProfile = !payload.profile || payload.profile === activeProfile
      if (!source.startsWith('agents.') || !sameProfile) return
      invalidateLocalEmployeesCache(activeProfile)
      if (!cancelled) {
        refreshEmployeesFromLocalSnapshot(activeProfile).catch(() => null)
      }
    }).then((unlisten) => {
      if (cancelled) {
        if (typeof unlisten === 'function') unlisten()
        return
      }
      disposeSnapshot = unlisten
    }).catch(() => null)

    return () => {
      cancelled = true
      if (typeof disposeSnapshot === 'function') disposeSnapshot()
    }
  }, [activeProfile, deferOpenClawDirectoryHydration, useCloudEmployeeDirectory])

  const mentionOptions = useMemo(() => {
    const commandMode = mentionQuery?.trigger === 'slash'
    const options = buildMentionResourceOptions(mentionResources, { commandMode })
    return visibleMentionOptions(mentionQuery?.query || '', options)
  }, [mentionQuery, mentionResources])

  const authorizedMentionOptions = useMemo(
    () => buildMentionResourceOptions(mentionResources, { commandMode: false }),
    [mentionResources],
  )

  const documentMentionLabels = useMemo(
    () => Object.fromEntries(
      authorizedMentionOptions
        .filter(option => option.kind === 'doc' && option.name && option.label)
        .map(option => [option.name, option.label]),
    ),
    [authorizedMentionOptions],
  )

  useEffect(() => {
    const el = listRef.current
    if (!el || !activeConversationId) return

    const activeConversationChanged = lastAutoScrolledConversationRef.current !== activeConversationId
    if (!shouldAutoScrollConversationList({
      activeConversationChanged,
      wasPinnedToBottom: conversationScrollPinnedRef.current,
    })) {
      return
    }

    el.scrollTop = el.scrollHeight
    conversationScrollPinnedRef.current = true
    lastAutoScrolledConversationRef.current = activeConversationId
  }, [activeConversationId, activeMessages.length, activeMessages.at(-1)?.content, activeSending, hasPendingTurn, activeStreamingAssistantText, activeReasoningPanel?.content, activeReasoningPanel?.expanded, activeToolTimeline?.steps?.length, activeToolTimeline?.expanded])

  // Live "处理中... Xs" timer for the tool timeline (Accio-style 1s cadence).
  useEffect(() => {
    const running = Boolean(activeToolTimeline && !activeToolTimeline.finishedAt)
    if (!running) return
    const timer = window.setInterval(() => setToolTimelineTick(tick => tick + 1), 1000)
    return () => window.clearInterval(timer)
  }, [Boolean(activeToolTimeline && !activeToolTimeline.finishedAt), activeConversationId])

  useEffect(() => {
    if (mentionIndex >= mentionOptions.length) {
      setMentionIndex(0)
    }
  }, [mentionIndex, mentionOptions.length])

  // Keyboard ↑/↓ moves the highlight; keep it inside the scroll viewport so the
  // list follows the selection instead of only scrolling by mouse wheel.
  useEffect(() => {
    const list = mentionListRef.current
    if (!list) return
    const active = list.querySelector(`[data-mention-index="${mentionIndex}"]`)
    if (!active) return
    mentionAutoScrollRef.current = true
    if (typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' })
    } else {
      // offsetTop is relative to the positioned menu wrapper, not this scroll
      // box, so measure with rects instead.
      const listRect = list.getBoundingClientRect()
      const rect = active.getBoundingClientRect()
      if (rect.top < listRect.top) list.scrollTop += rect.top - listRect.top
      else if (rect.bottom > listRect.bottom) list.scrollTop += rect.bottom - listRect.bottom
    }
    const release = window.setTimeout(() => { mentionAutoScrollRef.current = false }, 120)
    return () => window.clearTimeout(release)
  }, [mentionIndex, mentionOptions.length, mentionQuery?.trigger])

  // Wheel/trackpad scrolling must not strand the highlight off-screen: when the
  // selected row leaves the viewport, snap the selection to the nearest visible
  // row so Enter always commits something the user can see.
  const handleMentionListScroll = useCallback(() => {
    if (mentionAutoScrollRef.current) return
    const list = mentionListRef.current
    if (!list) return
    const listRect = list.getBoundingClientRect()
    const items = Array.from(list.querySelectorAll('[data-mention-index]')).map(node => {
      const rect = node.getBoundingClientRect()
      return { index: Number(node.dataset.mentionIndex), top: rect.top, bottom: rect.bottom }
    })
    const nextIndex = nearestVisibleMentionIndex({
      viewport: { top: listRect.top, bottom: listRect.bottom },
      items,
      activeIndex: mentionIndex,
    })
    if (nextIndex !== mentionIndex) setMentionIndex(nextIndex)
  }, [mentionIndex])

  useEffect(() => {
    function closeConversationMenusOnOutsidePointer(event) {
      if (composerRef.current?.contains(event.target)) return
      if (sessionPickerRef.current?.contains(event.target)) return
      if (sessionActionMenuRef.current?.contains(event.target)) return
      setApprovalMenuOpen(false)
      setModelMenuOpen(false)
      setAttachmentMenuOpen(false)
      setSessionMenuOpen(false)
      setSessionPickerOpen(false)
    }

    document.addEventListener('mousedown', closeConversationMenusOnOutsidePointer)
    document.addEventListener('touchstart', closeConversationMenusOnOutsidePointer)
    return () => {
      document.removeEventListener('mousedown', closeConversationMenusOnOutsidePointer)
      document.removeEventListener('touchstart', closeConversationMenusOnOutsidePointer)
    }
  }, [])

  useEffect(() => {
    if (!activeEmployee) return
    loadMentionResources().catch(() => {
      setMentionResources({
        ...EMPTY_MENTION_RESOURCES,
        plugins: [],
      })
      setMentionResourcesError('暂时读取不到 Uniopc 引擎 能力列表，请稍后重试。')
      setMentionResourcesLoading(false)
    })
  }, [activeEmployee, loadMentionResources])

  useEffect(() => {
    if (mentionQuery?.trigger !== 'slash') return
    if (!activeEmployee || mentionResourcesLoading || mentionResourcesError) return
    const activeEmployeeId = activeEmployee?.openclawAgentId || activeEmployee?.id || ''
    if (!shouldRefreshSlashMentionResources({
      trigger: mentionQuery?.trigger,
      profile: activeProfile,
      employeeId: activeEmployeeId,
      refreshedKey: slashMentionResourcesRefreshKeyRef.current,
    })) return
    slashMentionResourcesRefreshKeyRef.current = `${activeProfile}:${activeEmployeeId}`
    loadMentionResources({ silent: true }).catch(() => {
      setMentionResourcesError('暂时读取不到 Uniopc 引擎 能力列表，请稍后重试。')
      setMentionResourcesLoading(false)
    })
  }, [activeEmployee, activeProfile, loadMentionResources, mentionQuery?.trigger, mentionResourcesError, mentionResourcesLoading])

  useEffect(() => {
    let disposed = false
    let cleanup = null

    listen('native-voice-input-event', event => {
      if (disposed) return
      const payload = event?.payload || {}
      const status = typeof payload.status === 'string' ? payload.status : ''
      const transcript = typeof payload.transcript === 'string' ? payload.transcript.trim() : ''
      if (status === 'started') {
        setVoiceListening(true)
        setNativeVoicePartial('')
        return
      }
      if (status === 'partial') {
        setNativeVoicePartial(transcript)
        return
      }
      if (status === 'final') {
        appendVoiceTranscript(transcript)
        setNativeVoicePartial('')
        setVoiceListening(false)
        return
      }
      if (status === 'stopped' || status === 'cancelled') {
        setNativeVoicePartial('')
        setVoiceListening(false)
        return
      }
      if (status === 'error') {
        const reason = typeof payload.error === 'string' && payload.error
          ? `：${formatNativeVoiceInputError(payload.error)}`
          : ''
        setError(`语音输入失败${reason}`)
        setNativeVoicePartial('')
        setVoiceListening(false)
      }
    }).then(unlisten => {
      cleanup = unlisten
      if (disposed) cleanup()
    })

    return () => {
      disposed = true
      if (cleanup) cleanup()
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let cleanup = null

    listen('conversation-gateway-event', event => {
      if (disposed) return
      const payload = event?.payload || {}
      const runId = typeof payload.runId === 'string' ? payload.runId : ''
      const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : ''
      const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : ''
      const state = typeof payload.state === 'string' ? payload.state : ''
      const content = typeof payload.content === 'string' ? payload.content : ''
      const isReasoning = Boolean(payload.isReasoning) || state === 'thinking' || state === 'reasoning'
      const reasoningContent = typeof payload.reasoningContent === 'string' ? payload.reasoningContent : ''
      const errorMessage = typeof payload.errorMessage === 'string' ? payload.errorMessage : ''
      const gatewayError = payload.gatewayError && typeof payload.gatewayError === 'object'
        ? payload.gatewayError
        : null
      const sessionMessage = payload.sessionMessage && typeof payload.sessionMessage === 'object'
        ? payload.sessionMessage
        : null
      const approvalRequest = payload.approvalRequest && typeof payload.approvalRequest === 'object'
        ? payload.approvalRequest
        : null

      if (state === 'plugin_approval_requested' && approvalRequest?.id) {
        setPendingPluginApprovals(current => [
          ...current.filter(item => item?.id !== approvalRequest.id),
          approvalRequest,
        ])
        return
      }
      if (state === 'plugin_approval_resolved' && approvalRequest?.id) {
        setPendingPluginApprovals(current => current.filter(item => item?.id !== approvalRequest.id))
        return
      }
      if (state.startsWith('exec_approval_') && payload.profile && payload.profile !== execApprovalRefreshRef.current.profile) return
      if (state === 'exec_approval_requested' && approvalRequest?.id) {
        execApprovalRefreshRef.current.revision++
        setPendingExecApprovals(current => [
          ...current.filter(item => item?.id !== approvalRequest.id),
          approvalRequest,
        ])
        return
      }
      if (state === 'exec_approval_resolved' && approvalRequest?.id) {
        execApprovalRefreshRef.current.revision++
        setPendingExecApprovals(current => current.filter(item => item?.id !== approvalRequest.id))
        return
      }
      if (!runId && !sessionKey) return

      // Any frame counts as liveness for this session, including tool steps and
      // reasoning — a long tool call must not look like a lost run.
      if (sessionKey) gatewayActivityAtRef.current[sessionKey] = Date.now()

      if (state === 'subscribe_degraded') {
        // Chat text still streams; only the tool timeline is missing. Surface it
        // instead of letting the turn look like it is doing nothing.
        setError(sanitizeBrand(errorMessage) || '会话工具事件订阅失败，本轮不会显示工具步骤。')
        return
      }

      if (state === 'session_message' && sessionMessage?.role === 'user') {
        const canonicalUserMessage = {
          id: typeof sessionMessage.id === 'string' ? sessionMessage.id : '',
          role: 'user',
          content: typeof sessionMessage.content === 'string' ? sessionMessage.content : '',
          createdAt: Number.isFinite(sessionMessage.createdAt)
            ? sessionMessage.createdAt
            : Number.isFinite(payload.createdAt) ? payload.createdAt : Date.now(),
          ...(typeof sessionMessage.idempotencyKey === 'string' && sessionMessage.idempotencyKey
            ? { idempotencyKey: sessionMessage.idempotencyKey }
            : {}),
        }
        const outboxIdentity = outboxIdentityRef.current
        if (outboxIdentity?.ownerId) {
          try {
            setOutboxEntries(confirmConversationOutbox(outboxIdentity.ownerId, {
              profile: outboxIdentity.profile,
              sessionKey,
              messages: [canonicalUserMessage],
            }))
          } catch {
            // The transcript is canonical even if local storage is temporarily
            // unavailable; the next history load will attempt retirement again.
          }
        }
        setConversations(prev => prev.map(item => {
          const matchesConversation = conversationId
            ? item.id === conversationId
            : item.gatewaySessionKey === sessionKey
          if (!matchesConversation) return item
          const messages = reconcileConversationSessionMessage(item.messages, canonicalUserMessage)
          return {
            ...item,
            messages,
            updatedAt: latestConversationMessageTimestamp(messages, item.updatedAt),
            summary: deriveConversationSummary(messages) || item.summary,
          }
        }))
        return
      }

      if (state === 'seq_gap') {
        setConversations(prev => prev.map(item => {
          const matchesConversation = conversationId
            ? item.id === conversationId
            : item.gatewaySessionKey === sessionKey
          if (!matchesConversation) return item

          clearConversationStreamingAssistantText(item.id)
          finishConversationReasoningPanel(item.id)
          finishConversationToolTimeline(item.id, { failed: true })
          clearConversationPendingGatewayRun(item.id)
          setSendingConversationIds(current => {
            const next = new Set(current)
            next.delete(item.id)
            return next
          })
          setHistoryRefreshNonce(prev => prev + 1)

          return {
            ...item,
            updatedAt: Date.now(),
          }
        }))
        return
      }

      if (state === 'reconnecting') {
        // Socket dropped and is retrying with backoff. Non-destructive: keep the
        // current bubble; recovery happens when 'reconnected' arrives.
        return
      }

      if (state === 'reconnected') {
        // The stream re-established a previously-active session. Events during the
        // dead window were lost, so recover exactly like a seq gap: drop the stale
        // streaming bubble/pending run and refetch authoritative history. Idempotent
        // for an idle conversation (nothing to clear, one cheap refetch).
        setConversations(prev => prev.map(item => {
          const matchesConversation = conversationId
            ? item.id === conversationId
            : item.gatewaySessionKey === sessionKey
          if (!matchesConversation) return item

          clearConversationStreamingAssistantText(item.id)
          finishConversationReasoningPanel(item.id)
          finishConversationToolTimeline(item.id, { failed: true })
          clearConversationPendingGatewayRun(item.id)
          setSendingConversationIds(current => {
            const next = new Set(current)
            next.delete(item.id)
            return next
          })
          setHistoryRefreshNonce(prev => prev + 1)

          return {
            ...item,
            updatedAt: Date.now(),
          }
        }))
        return
      }

      const cancelledRun = userCancelledGatewayRunRef.current
      // React may replay state-updater callbacks in development. Decide whether
      // this terminal event was user-requested before entering the updater, so
      // that replay cannot consume the marker and turn Stop into an error.
      const isUserCancelledTerminal = (state === 'error' || state === 'aborted')
        && cancelledRun?.sessionKey === sessionKey
      if (isUserCancelledTerminal) userCancelledGatewayRunRef.current = null

      setConversations(prev => prev.map(item => {
        const matchesConversation = conversationId
          ? item.id === conversationId
          : item.gatewaySessionKey === sessionKey
        if (!matchesConversation) return item

        if (state === 'final' || state === 'error' || state === 'aborted') {
          if (state === 'final') {
            // The streaming bubble stays visible until the reloaded history
            // has replaced it — no blank gap between stream and answer.
            finalizedGatewayConversationsRef.current.add(item.id)
            // A received terminal frame means the engine has accepted the end
            // of this turn. Do not make the composer wait for the follow-up
            // history RPC: on Windows that RPC can lag long enough for an
            // ordinary next message to be incorrectly put in the outbox.
            clearConversationPendingGatewayRun(item.id)
          } else {
            clearConversationStreamingAssistantText(item.id)
            clearConversationPendingGatewayRun(item.id)
          }
          finishConversationReasoningPanel(item.id)
          finishConversationToolTimeline(item.id, { failed: state !== 'final' })
          setSendingConversationIds(current => {
            const next = new Set(current)
            next.delete(item.id)
            return next
          })
          setHistoryRefreshNonce(prev => prev + 1)
          if (!isUserCancelledTerminal && (state === 'error' || state === 'aborted')) {
            setError(gatewayStreamErrorMessage(gatewayError))
            // Revoked official-model key (relay 401): re-mint + rewrite the
            // provider in the background so the next send just works.
            recoverOfficialModelAuth({
              profile: activeProfile,
              gatewayError,
            }).catch(() => null)
          }
          return {
            ...item,
            updatedAt: Date.now(),
          }
        }

        if (state.startsWith('tool_')) {
          updateConversationToolTimeline(item.id, { runId, state, payload })
          recordGatewayToolArtifacts(item.id, payload)
          if (runId) {
            setPendingGatewayRunByConversation(prev => ({
              ...prev,
              [item.id]: runId,
            }))
          }
          return {
            ...item,
            updatedAt: Date.now(),
          }
        }

        if (isReasoning && (reasoningContent || content)) {
          updateConversationReasoningPanel(item.id, {
            runId,
            content: reasoningContent || content,
          })
        } else if (content) {
          setStreamingAssistantTextByConversation(prev => ({
            ...prev,
            [item.id]: content,
          }))
        }
        if (runId && (content || reasoningContent || ['started', 'in_flight', 'thinking', 'reasoning'].includes(state))) {
          setPendingGatewayRunByConversation(prev => ({
            ...prev,
            [item.id]: runId,
          }))
        }
        if (!content && !reasoningContent && !(runId && ['started', 'in_flight', 'thinking', 'reasoning'].includes(state))) return item

        return {
          ...item,
          updatedAt: Date.now(),
        }
      }))
    }).then(unlisten => {
      cleanup = unlisten
      if (disposed) cleanup()
    })

    return () => {
      disposed = true
      if (cleanup) cleanup()
    }
  }, [])

  useEffect(() => {
    if (!turnInFlight || !gatewayReady || !activeProfile) return
    let disposed = false
    const refresh = () => engineClient.sessions.listPluginApprovals({ profile: activeProfile })
      .then(rows => {
        if (disposed || !Array.isArray(rows)) return
        setPendingPluginApprovals(rows)
      })
      .catch(() => null)
    refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [activeProfile, gatewayReady, turnInFlight])

  useEffect(() => {
    if (!gatewayReady || !activeProfile) return
    let disposed = false
    setPendingExecApprovals([])
    setResolvingExecApprovalId('')
    const scope = execApprovalRefreshRef.current
    const refresh = () => {
      const revision = scope.revision
      const request = ++scope.request
      return engineClient.sessions.listExecApprovals({ profile: activeProfile })
      .then(result => {
        if (disposed || scope !== execApprovalRefreshRef.current || revision !== scope.revision || request < (scope.appliedRequest || 0)) return
        scope.appliedRequest = request
        const rows = Array.isArray(result) ? result : result?.requests || result?.pending || []
        if (Array.isArray(rows)) setPendingExecApprovals(rows)
      })
      .catch(() => null)
    }
    refresh()
    const timer = window.setInterval(refresh, 2500)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [activeProfile, gatewayReady])

  async function resolvePendingExecApproval(approval, decision) {
    const id = String(approval?.id || '').trim()
    if (!id || !activeProfile || resolvingExecApprovalId) return
    const scope = execApprovalRefreshRef.current
    setResolvingExecApprovalId(id)
    try {
      await engineClient.sessions.resolveExecApproval({
        req: { profile: activeProfile, id, decision },
      })
      if (scope !== execApprovalRefreshRef.current) return
      scope.revision++
      setPendingExecApprovals(current => current.filter(item => item?.id !== id))
      setError('')
    } catch (err) {
      if (scope === execApprovalRefreshRef.current) setError(String(err?.message || err || '命令审批失败'))
    } finally {
      if (scope === execApprovalRefreshRef.current) setResolvingExecApprovalId('')
    }
  }

  async function resolvePendingPluginApproval(approval, decision) {
    const id = String(approval?.id || '').trim()
    if (!id || !activeProfile || resolvingPluginApprovalId) return
    setResolvingPluginApprovalId(id)
    try {
      await engineClient.sessions.resolvePluginApproval({
        req: { profile: activeProfile, id, decision },
      })
      setPendingPluginApprovals(current => current.filter(item => item?.id !== id))
      setError('')
    } catch (err) {
      setError(String(err?.message || err || '插件写操作审批失败'))
    } finally {
      setResolvingPluginApprovalId('')
    }
  }

  useEffect(() => {
    if (!activeEmployee || activeSending) return
    if (!activeProfile || !gatewayReady) return

    const historyProfile = activeProfile
    let cancelled = false
    const shouldShowLoading = !Array.isArray(activeConversation?.messages) || activeConversation.messages.length === 0

    if (shouldShowLoading) {
      setLoadingMessages(true)
    }

    // A turn ending re-runs this effect on the same session. That is a transcript
    // refresh, not a session switch: the subscription is already live (and the
    // stream actor re-subscribes itself across reconnects), and neither the model
    // nor the thinking level can have changed. Both are skipped so a turn end
    // costs one gateway round trip instead of three.
    const subscribedKey = `${historyProfile}::${activeConversationSessionKey}`
    const isSessionSwitch = subscribedSessionRef.current !== subscribedKey
    if (isSessionSwitch) {
      // Mark only once the gateway accepted it. Marking up front would make a
      // failed subscribe permanent: the old code re-subscribed on every refresh
      // and so silently recovered, this path gets exactly one attempt per switch.
      subscribeConversationSession(activeConversationSessionKey, historyProfile)
        .then(() => {
          subscribedSessionRef.current = subscribedKey
        })
        .catch(() => {
          subscribedSessionRef.current = ''
        })
    }

    loadConversationHistory(activeConversationSessionKey, historyProfile, {
      includeSessionMeta: isSessionSwitch,
    })
      .then(history => {
        if (cancelled) return
        if (isSessionSwitch) {
          // Only trust meta we actually asked for — applying an empty snapshot
          // here would silently clear the user's model override.
          setSelectedModelOverride(sessionModelRefFromMeta(history.meta))
          ensureConversationReasoningStream(history.meta, activeConversationSessionKey, historyProfile)
        }
        // An ACK is only admission. Retire a durable queue row when the
        // authoritative transcript carries the same persisted idempotency key.
        setOutboxEntries(confirmConversationOutbox(storageOwnerId, {
          profile: historyProfile,
          sessionKey: activeConversationSessionKey,
          messages: history.messages,
        }))
        if (!Array.isArray(history.messages) || history.messages.length === 0) return

        updateConversation(activeConversationId, item => {
          const currentMessages = Array.isArray(item.messages) ? item.messages : []
          const pendingUserMessage = activeOptimisticUserMessage?.conversationId === activeConversationId
            ? activeOptimisticUserMessage
            : null
          const mergedMessages = mergeConversationHistoryMessages(
            pendingUserMessage ? [...currentMessages, pendingUserMessage] : currentMessages,
            history.messages,
            Date.now(),
            { historyTruncated: Boolean(history.meta?.truncated) },
          )

          return {
            ...item,
            messages: mergedMessages,
            updatedAt: latestConversationMessageTimestamp(mergedMessages, item.updatedAt),
            title: item.title || displayEmployeeName(activeEmployee),
            summary: deriveConversationSummary(mergedMessages) || activeEmployee.description,
            gatewaySessionKey: activeConversationSessionKey,
          }
        })
      })
      .catch(() => null)
      .finally(() => {
        if (cancelled) return
        setLoadingMessages(false)
        // The final answer is now part of history — retire the temporary
        // streaming bubble (kept alive through `final` to avoid a blank flash).
        if (finalizedGatewayConversationsRef.current.has(activeConversationId)) {
          finalizedGatewayConversationsRef.current.delete(activeConversationId)
          clearConversationStreamingAssistantText(activeConversationId)
          clearConversationPendingGatewayRun(activeConversationId)
        }
      })

    return () => {
      cancelled = true
    }
  }, [activeConversation?.gatewaySessionKey, activeConversationId, activeConversationSessionKey, activeEmployee, activeOptimisticUserMessage, activeProfile, activeSending, historyRefreshNonce, gatewayReady])

  function ensureConversationRecord(employeeId, currentEmployees = employees, sessionKey = '', sessionTitle = '') {
    const employee = currentEmployees.find(item => item.id === employeeId)
    if (!employee) return
    const gatewaySessionKey = sessionKey || buildSessionKey(employee.id)
    const recordId = buildConversationSessionRecordId(employee.id, gatewaySessionKey)

    setConversations(prev => {
      if (prev.some(item => item.id === recordId)) {
        return prev.map(item =>
          item.id === recordId
            ? {
                ...item,
                employeeId: employee.id,
                employeeName: displayEmployeeName(employee),
                employeeRole: employee.role,
                title: sessionTitle || item.title || displayEmployeeName(employee),
                gatewaySessionKey,
                meta: item.meta || null,
              }
            : item,
        )
      }

      return [buildEmployeeConversation(employee, gatewaySessionKey, sessionTitle), ...prev]
    })
  }

  function ensureConversationReasoningStream(sessionMeta, sessionKey, profile) {
    if (!sessionKey || !profile) return
    const currentLevel = normalizeConversationReasoningMode(
      sessionMeta?.reasoningLevel || 'off',
    )
    if (currentLevel === CONVERSATION_REASONING_STREAM_LEVEL) return
    // Fire-and-forget: reasoning display is always streamed; a failed patch just
    // means the panel stays empty until the next history load retries it.
    setConversationSessionReasoning({
      profile,
      sessionKey,
      reasoningLevel: CONVERSATION_REASONING_STREAM_LEVEL,
    }).catch(() => null)
  }

  async function chooseConversationModel(modelRef) {
    const nextModel = String(modelRef || '').trim()
    const previousModel = selectedModelOverride
    setSelectedModelOverride(nextModel)
    setModelMenuOpen(false)
    // Routine official-model changes reuse the provider/token prepared by the
    // app bootstrap. The helper only mints a token when this Profile does not
    // currently own the in-memory proxy token, and only config-patches when the
    // provider or selected catalog entry is genuinely missing.
    if (nextModel.startsWith(`${UNIOPC_OFFICIAL_PROVIDER}/`) && activeProfile) {
      try {
        const preparation = await prepareUniopcOfficialModelForSelection({
          profile: activeProfile,
          snapshot: modelSnapshot,
          modelRef: nextModel,
        })
        if (preparation.snapshotRefreshNeeded) {
          engineClient.models.snapshot({ profile: activeProfile })
            .then(snapshot => setModelSnapshot(snapshot))
            .catch(() => null)
        }
      } catch (err) {
        setSelectedModelOverride(previousModel)
        setError(String(err?.message || err || '连接 Uniopc 官方模型失败'))
        return
      }
    }
    if (!activeEmployee || !activeProfile || !activeConversationSessionKey) return
    try {
      const result = await setConversationSessionModel({
        profile: activeProfile,
        sessionKey: activeConversationSessionKey,
        model: nextModel || null,
      })
      setSelectedModelOverride(result.model || '')
      setError('')
      refreshConversationSessions({ silent: true }).catch(() => null)
    } catch (err) {
      setSelectedModelOverride(previousModel)
      setError(String(err?.message || err || '切换模型失败'))
    }
  }

  function selectGatewayConversationSession(session) {
    if (!activeEmployee) return
    const sessionKey = String(session?.sessionKey || session?.key || '').trim()
    if (!sessionKey) return
    const title = formatSessionTitle(session, displayEmployeeName(activeEmployee))
    ensureConversationRecord(activeEmployee.id, employees, sessionKey, title)
    setSelectedSessionByEmployee(prev => ({
      ...prev,
      [activeEmployee.id]: sessionKey,
    }))
    setSessionPickerOpen(false)
    setError('')
    setHistoryRefreshNonce(prev => prev + 1)
  }

  function startRenameConversationSession(session) {
    const sessionKey = String(session?.sessionKey || session?.key || '').trim()
    if (!sessionKey) return
    setEditingSessionKey(sessionKey)
    setEditingSessionLabel(formatSessionTitle(session, ''))
    setConversationSessionsError('')
  }

  async function onRenameSession(session) {
    if (!activeEmployee) return
    if (!activeProfile) {
      setConversationSessionsError('请先完成本机 Uniopc 引擎 Host 初始化，再重命名聊天。')
      return
    }
    const sessionKey = String(session?.sessionKey || session?.key || '').trim()
    const label = editingSessionLabel.trim()
    if (!sessionKey || !label) {
      setConversationSessionsError('聊天名称不能为空。')
      return
    }
    setRenamingSessionKey(sessionKey)
    setConversationSessionsError('')
    try {
      const result = await renameConversationSession({
        sessionKey,
        profile: activeProfile,
        label,
      })
      const nextLabel = result.label || label
      setConversationSessions(prev =>
        prev.map(item => {
          const itemKey = item.sessionKey || item.key
          return itemKey === sessionKey
            ? { ...item, label: nextLabel, title: nextLabel, updatedAt: Date.now() }
            : item
        }),
      )
      ensureConversationRecord(activeEmployee.id, employees, sessionKey, nextLabel)
      setEditingSessionKey('')
      setEditingSessionLabel('')
      setHistoryRefreshNonce(prev => prev + 1)
    } catch (err) {
      setConversationSessionsError(String(err?.message || err || '重命名 Gateway 聊天失败'))
    } finally {
      setRenamingSessionKey('')
    }
  }

  async function createGatewayConversationSession() {
    if (!activeEmployee) return
    if (!activeProfile) {
      setConversationSessionsError('请先完成本机 Uniopc 引擎 Host 初始化，再创建新聊天。')
      return
    }
    setCreatingConversationSession(true)
    setConversationSessionsError('')
    try {
      const result = await createConversationSession({
        agentId: activeEmployee.id,
        profile: activeProfile,
        title: '新聊天',
      })
      if (!result.sessionKey) throw new Error('Gateway 没有返回新聊天 session key。')
      const session = {
        ...result,
        key: result.sessionKey,
        sessionKey: result.sessionKey,
        agentId: activeEmployee.id,
        title: result.title || '新聊天',
        updatedAt: Date.now(),
      }
      setConversationSessions(prev => [
        session,
        ...prev.filter(item => (item.sessionKey || item.key) !== result.sessionKey),
      ])
      selectGatewayConversationSession(session)
    } catch (err) {
      setConversationSessionsError(String(err?.message || err || '创建 Gateway 聊天失败'))
    } finally {
      setCreatingConversationSession(false)
    }
  }

  async function chooseConversationPermission(nextPermissionMode) {
    setApprovalMenuOpen(false)
    if (!activeConversationSessionKey || !activeProfile) return
    const profile = activeProfile
    const sessionKey = activeConversationSessionKey
    const coordinator = permissionCoordinatorRef.current
    const isCurrent = () => permissionScopeRef.current?.profile === profile
      && permissionScopeRef.current?.sessionKey === sessionKey
    const saving = coordinator.save(profile, sessionKey, nextPermissionMode, coordinator.mode(profile, sessionKey), () =>
      setConversationSessionPermission({ sessionKey, profile, permissionMode: nextPermissionMode }))
    setPermissionSaveVersion(version => version + 1)
    try {
      await saving
      if (permissionScopeRef.current?.profile === profile) {
        setConversationSessions(prev => prev.map(session =>
          (session.sessionKey || session.key) === sessionKey
            ? { ...session, permissionMode: coordinator.mode(profile, sessionKey) === 'default' ? null : coordinator.mode(profile, sessionKey) }
            : session,
        ))
      }
      if (isCurrent() && !coordinator.blocked(profile, sessionKey)) {
        setApprovalMode(coordinator.mode(profile, sessionKey))
        setError('')
        setChatNotice(`已将此会话设为「${findConversationApprovalMode(nextPermissionMode).label}」。`)
      }
    } catch (err) {
      if (isCurrent()) setError(String(err?.message || err || '更新会话权限失败'))
    } finally {
      setPermissionSaveVersion(version => version + 1)
    }
  }

  async function runActiveSessionAction(action) {
    const session = conversationSessions.find(item => (item.sessionKey || item.key) === activeConversationSessionKey)
    if (!activeConversationSessionKey || !activeProfile) return
    setSessionActionLoading(true)
    try {
      await patchConversationSessionState({
        sessionKey: activeConversationSessionKey,
        sessionId: session?.sessionId || null,
        profile: activeProfile,
        action,
      })
      setSessionMenuOpen(false)
      await refreshConversationSessions({ silent: true })
      setChatNotice({
        archive: '会话已归档。',
        restore: '会话已恢复。',
        pin: '会话已置顶。',
        unpin: '已取消置顶。',
        mark_unread: '已标为未读。',
        mark_read: '已标为已读。',
      }[action] || '会话已更新。')
    } catch (err) {
      setError(String(err?.message || err || '更新会话失败'))
    } finally {
      setSessionActionLoading(false)
    }
  }

  function chooseAttachmentAction(action) {
    setAttachmentMenuOpen(false)
    if (action === 'file') {
      openConversationAttachmentPicker()
      return
    }
    if (action === 'skills') {
      loadMentionResources().catch(() => null)
      setInput(current => current || '/')
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
    if (action === 'connectors') {
      loadMentionResources().catch(() => null)
      setInput(current => current || '@')
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
    if (action === 'search') {
      loadMentionResources().catch(() => null)
      setInput(current => current || '请使用已配置的网页搜索能力：')
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  function selectEmployee(employeeId) {
    if (!employeeId) return
    setError('')
    setRightPaneMode('chat')
    ensureConversationRecord(employeeId, employees)
    if (employeeIdFromUrl !== employeeId) {
      setSearchParams({ agent: employeeId }, { replace: true })
    }
  }

  function openEmployeeSettings(employeeId) {
    if (!employeeId) return
    setError('')
    setRightPaneMode('settings')
    ensureConversationRecord(employeeId, employees)
    if (employeeIdFromUrl !== employeeId) {
      setSearchParams({ agent: employeeId }, { replace: true })
    }
  }

  function updateConversation(recordId, updater) {
    setConversations(prev => {
      const next = prev.map(item =>
        item.id === recordId ? updater(item) : item,
      )
      return next.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    })
  }

  function clearConversationStreamingAssistantText(conversationId) {
    if (!conversationId) return
    setStreamingAssistantTextByConversation(prev => {
      if (!Object.prototype.hasOwnProperty.call(prev, conversationId)) return prev
      const next = { ...prev }
      delete next[conversationId]
      return next
    })
  }

  function resetConversationReasoningPanel(conversationId) {
    if (!conversationId) return
    setReasoningPanelByConversation(prev => {
      if (!Object.prototype.hasOwnProperty.call(prev, conversationId)) return prev
      const next = { ...prev }
      delete next[conversationId]
      return next
    })
  }

  // Persisting history can fail (quota). Say so instead of letting the user find
  // out on the next reload that nothing was saved.
  useEffect(() => subscribeConversationStorageError(message => {
    setChatNotice(message)
  }), [])

  // Asks the engine whether the session still has a run in flight, and settles
  // the UI accordingly. This is the only authority — a missing `final` frame
  // says nothing, since a healthy socket produces no seq_gap and no reconnect.
  const reconcileGatewayRunState = useCallback(async (conversationId, sessionKey, profile) => {
    if (!conversationId || !sessionKey || !profile) return
    let history = null
    try {
      history = await loadConversationHistory(sessionKey, profile, { includeSessionMeta: false })
    } catch {
      // Gateway unreachable: leave the turn alone. The reconnect path owns that
      // case, and clearing state here would just lose an answer still coming.
      return
    }
    const meta = history?.meta || {}
    if (meta.hasActiveRun === true || meta.inFlightRunId) {
      // Still running. Adopt the engine's partial text so a UI that missed the
      // deltas (reload, dropped frames) catches up instead of showing nothing.
      if (meta.inFlightRunId) {
        setPendingGatewayRunByConversation(prev => ({ ...prev, [conversationId]: meta.inFlightRunId }))
      }
      if (meta.inFlightText) {
        setStreamingAssistantTextByConversation(prev => ({ ...prev, [conversationId]: meta.inFlightText }))
      }
      gatewayActivityAtRef.current[sessionKey] = Date.now()
      return
    }
    if (meta.hasActiveRun !== false && !Object.prototype.hasOwnProperty.call(meta, 'inFlightRunId')) {
      // Gateway did not report run state at all — don't guess.
      return
    }
    // The run is over and its `final` never reached us. Retire the spinner and
    // pull the authoritative transcript in.
    clearConversationStreamingAssistantText(conversationId)
    finishConversationReasoningPanel(conversationId)
    finishConversationToolTimeline(conversationId, { failed: true })
    clearConversationPendingGatewayRun(conversationId)
    setSendingConversationIds(current => {
      if (!current.has(conversationId)) return current
      const next = new Set(current)
      next.delete(conversationId)
      return next
    })
    gatewayActivityAtRef.current[sessionKey] = Date.now()
    setChatNotice('这一轮的结束通知没有收到，已重新拉取聊天记录。')
    setHistoryRefreshNonce(prev => prev + 1)
  }, [])

  useEffect(() => {
    if (!turnInFlight) return
    if (!activeConversationId || !activeConversationSessionKey || !activeProfile) return
    const timer = window.setInterval(() => {
      const lastAt = gatewayActivityAtRef.current[activeConversationSessionKey] || 0
      if (lastAt && Date.now() - lastAt < LOST_RUN_SILENCE_MS) return
      if (!lastAt) {
        // No frame has ever arrived for this session; start the clock now so the
        // probe fires one silence window after the send, not immediately.
        gatewayActivityAtRef.current[activeConversationSessionKey] = Date.now()
        return
      }
      reconcileGatewayRunState(activeConversationId, activeConversationSessionKey, activeProfile).catch(() => null)
    }, LOST_RUN_PROBE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [
    turnInFlight,
    null,
    activeConversationId,
    activeConversationSessionKey,
    activeProfile,
    reconcileGatewayRunState,
  ])

  function updateConversationReasoningPanel(conversationId, { runId = '', content = '' } = {}) {
    if (!conversationId) return
    const normalizedContent = String(content || '')
    if (!normalizedContent.trim()) return
    setReasoningPanelByConversation(prev => {
      const existing = prev[conversationId] || null
      const sameRun = !runId || !existing?.runId || existing.runId === runId
      const startedAt = sameRun && existing?.startedAt ? existing.startedAt : Date.now()
      return {
        ...prev,
        [conversationId]: {
          runId: runId || existing?.runId || '',
          content: normalizedContent,
          startedAt,
          finishedAt: null,
          streaming: true,
          expanded: true,
        },
      }
    })
  }

  function finishConversationReasoningPanel(conversationId) {
    if (!conversationId) return
    setReasoningPanelByConversation(prev => {
      const existing = prev[conversationId]
      if (!existing) return prev
      return {
        ...prev,
        [conversationId]: {
          ...existing,
          finishedAt: existing.finishedAt || Date.now(),
          streaming: false,
          expanded: false,
        },
      }
    })
  }

  function setConversationReasoningPanelExpanded(conversationId, expanded) {
    if (!conversationId) return
    setReasoningPanelByConversation(prev => {
      const existing = prev[conversationId]
      if (!existing) return prev
      return {
        ...prev,
        [conversationId]: {
          ...existing,
          expanded: Boolean(expanded),
        },
      }
    })
  }

  function clearConversationPendingGatewayRun(conversationId) {
    if (!conversationId) return
    setPendingGatewayRunByConversation(prev => {
      if (!Object.prototype.hasOwnProperty.call(prev, conversationId)) return prev
      const next = { ...prev }
      delete next[conversationId]
      return next
    })
  }

  async function copyConversationMessage(message) {
    const text = sanitizeBrand(String(message?.content || ''))
    const messageId = String(message?.id || '')
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopiedMessageId(messageId)
      window.setTimeout(() => {
        setCopiedMessageId(current => (current === messageId ? '' : current))
      }, 1500)
    } catch {
      setError('复制失败，请手动选择文本复制。')
    }
  }

  // Failed sends go back into the composer for a quick edit-and-resend
  // (Accio's editInComposer pattern) instead of a blind automatic retry.
  function editResendFailedMessage(message) {
    const text = String(message?.content || '')
    if (!text) return
    // The failed send also parked a durable copy keyed on the same turn id.
    // Taking the text back into the composer retires it, so the two paths can
    // never both deliver the message.
    const turnId = String(message?.id || '').replace(/^user-/, '')
    try {
      if (turnId) setOutboxEntries(removeConversationOutbox(storageOwnerId, `outbox-${turnId}`))
    } catch (error) {
      setError(String(error?.message || error))
      return
    }
    setInput(text)
    inputRef.current?.focus()
  }

  function resetConversationToolTimeline(conversationId) {
    if (!conversationId) return
    setToolTimelineByConversation(prev => {
      if (!Object.prototype.hasOwnProperty.call(prev, conversationId)) return prev
      const next = { ...prev }
      delete next[conversationId]
      return next
    })
  }

  // Files a tool just produced. Rust extracts the paths off the gateway tool
  // frame (`toolArtifacts`); here we only persist them so the global 产物 panel
  // can show them regardless of which conversation is open. Non-existent paths
  // are filtered later, at display time — a `tool_started` frame fires before
  // the file is on disk.
  function recordGatewayToolArtifacts(conversationId, payload) {
    const produced = Array.isArray(payload?.toolArtifacts) ? payload.toolArtifacts : []
    if (produced.length === 0) return
    const now = Date.now()
    recordToolArtifacts(user?.uid || null, produced.map(item => ({
      path: item?.path,
      operation: item?.operation,
      origin: item?.origin,
      title: item?.title,
      kind: item?.kind,
      toolName: payload?.toolName || '',
      conversationId,
      at: now,
    })))
  }

  function updateConversationToolTimeline(conversationId, { runId = '', state = '', payload = {} } = {}) {
    const toolName = typeof payload.toolName === 'string' ? payload.toolName.trim() : ''
    if (!conversationId || !toolName) return
    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : ''
    const toolArgs = typeof payload.toolArgs === 'string' ? payload.toolArgs : ''
    const resultPreview = typeof payload.toolResultPreview === 'string' ? payload.toolResultPreview : ''
    setToolTimelineByConversation(prev => {
      const existing = prev[conversationId] || null
      // A different runId means a new turn: start a fresh timeline.
      const sameRun = existing && (!runId || !existing.runId || existing.runId === runId)
      const base = sameRun
        ? existing
        : { runId: runId || '', startedAt: Date.now(), finishedAt: null, expanded: true, steps: [] }
      const steps = [...base.steps]
      const key = toolCallId || `${toolName}-${steps.length}`
      const index = steps.findIndex(step => step.key === key)
      const current = index >= 0 ? steps[index] : null
      const status = state === 'tool_error'
        ? 'error'
        : state === 'tool_result'
          ? 'ok'
          : current?.status === 'ok' || current?.status === 'error'
            ? current.status
            : 'running'
      const nextStep = {
        key,
        name: toolName,
        args: toolArgs || current?.args || '',
        status,
        resultPreview: resultPreview || current?.resultPreview || '',
        artifacts: Array.isArray(payload?.toolArtifacts) && payload.toolArtifacts.length > 0
          ? payload.toolArtifacts
          : current?.artifacts || [],
        startedAt: current?.startedAt || Date.now(),
        finishedAt: status === 'ok' || status === 'error' ? current?.finishedAt || Date.now() : null,
      }
      if (index >= 0) steps[index] = nextStep
      else steps.push(nextStep)
      return {
        ...prev,
        [conversationId]: {
          ...base,
          runId: base.runId || runId || '',
          finishedAt: null,
          steps,
        },
      }
    })
  }

  function finishConversationToolTimeline(conversationId, { failed = false } = {}) {
    if (!conversationId) return
    setToolTimelineByConversation(prev => {
      const existing = prev[conversationId]
      if (!existing) return prev
      return {
        ...prev,
        [conversationId]: {
          ...existing,
          finishedAt: existing.finishedAt || Date.now(),
          expanded: false,
          steps: existing.steps.map(step => step.status === 'running'
            ? { ...step, status: failed ? 'error' : 'ok', finishedAt: step.finishedAt || Date.now() }
            : step),
        },
      }
    })
  }

  function setConversationToolTimelineExpanded(conversationId, expanded) {
    if (!conversationId) return
    setToolTimelineByConversation(prev => {
      const existing = prev[conversationId]
      if (!existing) return prev
      return {
        ...prev,
        [conversationId]: {
          ...existing,
          expanded: Boolean(expanded),
        },
      }
    })
  }

  async function hydrateEmployees(profileArg = null) {
    const normalizedProfile = profileArg || null
    if (!normalizedProfile) {
      setEmployees([])
      setLoadingEmployees(false)
      setError('请先完成本机 Uniopc 引擎 Host 初始化，再开始对话。')
      return
    }
    // Instant paint: seed the roster from the last-known local agents on disk so
    // it shows immediately — before the gateway is even up — instead of flashing
    // empty ("正在同步员工列表"). Reconcile against the live runtime below; keep
    // the cached list (don't blank it) if the runtime fetch fails/lags.
    const cached = readPersistedLocalEmployees(normalizedProfile)
    if (cached.length > 0) {
      setEmployees(orderEmployeesForChat(cached))
    }
    setLoadingEmployees(cached.length === 0)
    setError('')
    try {
      const result = await loadEmployeeDirectory({
        profile: normalizedProfile,
        source: 'runtime',
        syncCloudEmployees: items => user?.uid
          ? syncMyCloudAiEmployees(supabase, user.uid, items)
          : Promise.resolve([]),
      })
      setEmployees(orderEmployeesForChat(result.employees))
    } catch (err) {
      // Only surface an error when we have nothing cached to show, so a
      // still-starting gateway never blanks the roster.
      if (cached.length === 0) {
        setError(String(err?.message || err || '读取当前 AI 员工失败'))
      }
    } finally {
      setLoadingEmployees(false)
    }
  }

  async function refreshEmployeesFromLocalSnapshot(profileArg = null) {
    const normalizedProfile = profileArg || null
    if (!normalizedProfile) {
      setEmployees([])
      setLoadingEmployees(false)
      setError('请先完成本机 Uniopc 引擎 Host 初始化，再刷新员工。')
      return
    }
    try {
      const localEmployees = await loadLocalEmployees(normalizedProfile)
      setEmployees(orderEmployeesForChat(localEmployees))
      setError('')
    } catch (err) {
      setError(String(err?.message || err || '读取当前 AI 员工失败'))
    } finally {
      setLoadingEmployees(false)
    }
  }

  async function sendMessage(event, draft = input, draftAttachments = imageAttachments, fromQueue = null) {
    event?.preventDefault()
    if (permissionCoordinatorRef.current.blocked(activeProfile, activeConversationSessionKey)) {
      const message = '会话权限尚未确认，请等待保存完成或重新选择权限后发送。'
      if (fromQueue) throw new Error(message)
      setError(message)
      return
    }
    const confirmedApprovalMode = permissionCoordinatorRef.current.mode(activeProfile, activeConversationSessionKey)
    const text = draft.trim()
    const attachments = Array.isArray(draftAttachments) ? draftAttachments : []
    if ((!text && attachments.length === 0) || !activeTarget) {
      if (fromQueue) throw new Error('会话尚未就绪，消息已保留。')
      return
    }
    if (activeEmployee && !activeConversationRouteReady) {
      if (fromQueue) throw new Error('会话正在切换，消息已保留。')
      setError('正在切换员工或会话，请稍候再发送。')
      return
    }
    if (fromQueue && !conversationModelReady) throw new Error('对话服务尚未就绪，消息已保留。')
    try {
      validateConversationImageAttachments(attachments)
    } catch (err) {
      if (fromQueue) throw err
      setError(String(err?.message || err || '图片附件无效'))
      return
    }
    // Keep startup and in-flight submissions durable. An idle, ready
    // conversation sends directly so ordinary messages never flash in outbox.
    if (shouldQueueConversationSubmission({
      hasEmployee: Boolean(activeEmployee),
      fromQueue,
      turnInFlight,
      conversationModelReady,
    })) {
      const { entries, entry, error: queueError } = enqueueConversationOutbox(storageOwnerId, {
        conversationId: activeConversationId,
        sessionKey: activeConversationSessionKey,
        employeeId: activeEmployee.id,
        profile: activeProfile,
        approvalMode: confirmedApprovalMode,
        text,
        attachments,
      })
      if (!entry) {
        setError(queueError || `待发送消息已满（最多 ${MAX_QUEUED_MESSAGES} 条）`)
        return
      }
      setOutboxEntries(entries)
      // A later sessions.list response must not move a just-queued first
      // message from :main to the engine's newest historical session.
      setSelectedSessionByEmployee(prev => ({ ...prev, [activeEmployee.id]: activeConversationSessionKey }))
      setInput('')
      setImageAttachments([])
      closeMentionMenu()
      setError('')
      return
    }
    const slashInvocations = extractConversationToolInvocations(text)
    const toolInvocations = slashInvocations
      .filter(invocation => invocation.kind === 'plugin')
      .map(invocation => ({
        pluginId: invocation.pluginId || invocation.name,
        toolName: invocation.toolName || null,
        trigger: 'slash',
      }))
    const explicitMentions = enrichConversationMentions(
      extractConversationMentions(text),
      authorizedMentionOptions,
    )
    const titleMentions = inferDocumentTitleMentions(
      text,
      authorizedMentionOptions,
      explicitMentions,
    )
    const mentions = [
      ...explicitMentions,
      ...titleMentions,
      ...slashInvocations.map(invocation => {
        if (invocation.kind === 'plugin') {
          const pluginId = invocation.pluginId || invocation.name
          return {
            kind: 'plugin',
            name: invocation.toolName
              ? `${pluginId}.${invocation.toolName}`
              : pluginId,
            trigger: 'slash',
          }
        }
        return {
          kind: invocation.kind,
          name: invocation.name,
          trigger: 'slash',
        }
      }),
    ]

    const turnId = fromQueue?.idempotencyKey || crypto.randomUUID()
    userCancelledGatewayRunRef.current = null
    const userMessage = {
      id: `user-${turnId}`,
      conversationId: activeConversationId,
      role: 'user',
      content: text,
      attachments,
      createdAt: Date.now(),
      status: 'sending',
      // Same value goes to chat.send as `idempotencyKey`; the gateway persists it
      // on the canonical user row, so history can be matched to this exact bubble
      // instead of guessing by text and timestamp.
      idempotencyKey: turnId,
    }
    ensureConversationRecord(activeEmployee.id, employees, activeConversationSessionKey, activeSessionTitle)
    setActiveOptimisticUserMessage(userMessage)

    if (!fromQueue) {
      // A queue drain must not clobber whatever the user is typing next.
      setInput('')
      setImageAttachments([])
    }
    closeMentionMenu()
    setApprovalMenuOpen(false)
    setModelMenuOpen(false)
    setError('')
    setChatNotice('')
    resetConversationReasoningPanel(activeConversationId)
    resetConversationToolTimeline(activeConversationId)
    finalizedGatewayConversationsRef.current.delete(activeConversationId)
    setSendingConversationIds(prev => new Set(prev).add(activeConversationId))
    setPendingGatewayRunByConversation(prev => ({
      ...prev,
      [activeConversationId]: turnId,
    }))

    try {
      if (!activeProfile) throw new Error('请先完成本机 Uniopc 引擎 Host 初始化，再发送消息。')
      const res = await sendConversationTurn({
        agentId: activeEmployee.id,
        input: text,
        attachments,
        conversationId: activeConversationId,
        sessionKey: activeConversationSessionKey,
        profile: activeProfile,
        idempotencyKey: turnId,
        mentions,
        toolInvocations,
        // Session permissions are saved by the picker. Do not resend a snapshot:
        // an older kickoff could otherwise undo a newer permission change.
      })

      // Gateway chat.send acknowledges only after its attachment parser has
      // accepted and resolved each managed local-media reference.
      setActiveOptimisticUserMessage(current => current?.id === userMessage.id
        ? {
            ...current,
            status: 'sent',
            deliveryStatus: 'delivered',
          }
        : current)

      const acceptedRunId = res.meta?.runId || turnId
      if (fromQueue) {
        // Keep this row until `session.message`/history confirms the Gateway
        // persisted it. A process crash between ACK and transcript write must
        // not turn into a duplicate replay after restart.
        setOutboxEntries(updateConversationOutbox(storageOwnerId, fromQueue.id, {
          status: OUTBOX_STATUS.confirming,
          lastError: '',
        }))
      }
      if (acceptedRunId !== turnId) {
        setPendingGatewayRunByConversation(prev => ({
          ...prev,
          [activeConversationId]: acceptedRunId,
        }))
      }
      updateConversation(activeConversationId, item => {
        return {
          ...item,
          employeeId: activeEmployee.id,
          employeeName: displayEmployeeName(activeEmployee),
          employeeRole: activeEmployee.role,
          updatedAt: Date.now(),
          title: displayEmployeeName(activeEmployee),
          summary: item.summary || userMessage.content || activeEmployee.description,
          gatewaySessionKey:
            res.meta?.gatewaySessionKey || item.gatewaySessionKey || activeConversationSessionKey,
          gatewaySessionId: res.meta?.gatewaySessionId || item.gatewaySessionId || null,
          meta: res.meta,
        }
      })
    } catch (err) {
      const reason = String(err?.message || err || '发送失败')
      const deliveryUnconfirmed = isConversationDeliveryUnconfirmedError(err)
      clearConversationStreamingAssistantText(activeConversationId)
      clearConversationPendingGatewayRun(activeConversationId)
      setActiveOptimisticUserMessage(current =>
        current?.id === userMessage.id ? { ...current, status: deliveryUnconfirmed ? 'confirming' : 'failed' } : current,
      )
      updateConversation(activeConversationId, item => {
        return {
          ...item,
          updatedAt: Date.now(),
          summary: item.summary || activeEmployee.description,
        }
      })
      // The failed bubble in the transcript is not durable — a failed user row is
      // filtered out on reload. Park the text in the outbox so the engine being
      // down costs the user nothing. Keyed by turnId so the transcript's
      // edit-and-resend can retire the same entry instead of double-sending.
      let failedOutboxId = fromQueue?.id || ''
      if (!fromQueue) {
        const { entries } = enqueueConversationOutbox(storageOwnerId, {
          id: `outbox-${turnId}`,
          conversationId: activeConversationId,
          sessionKey: activeConversationSessionKey,
          employeeId: activeEmployee.id,
          profile: activeProfile,
          text,
          attachments,
          status: deliveryUnconfirmed ? OUTBOX_STATUS.confirming : OUTBOX_STATUS.failed,
          lastError: deliveryUnconfirmed ? '' : reason,
        })
        setOutboxEntries(entries)
        failedOutboxId = `outbox-${turnId}`
      } else {
        try {
          setOutboxEntries(updateConversationOutbox(storageOwnerId, fromQueue.id, {
            status: deliveryUnconfirmed ? OUTBOX_STATUS.confirming : OUTBOX_STATUS.failed,
            lastError: deliveryUnconfirmed ? '' : reason,
          }))
        } catch {
          // The outer drain keeps the entry visible and failed if persistence
          // is temporarily unavailable.
        }
      }
      // A local loopback outage is sometimes collapsed by OpenClaw into an
      // "auth issue". Repair it before surfacing anything: the durable entry
      // keeps its original idempotency key, so the normal drain can continue
      // the user's exact turn once the provider is healthy.
      if (deliveryUnconfirmed) {
        setChatNotice('连接中断，正在从会话记录确认这条消息是否已发送。')
        return { deliveryUnconfirmed: true }
      }
      const recovered = await recoverOfficialModelAuth({
        profile: activeProfile,
        errorText: reason,
      }).catch(() => false)
      if (recovered && failedOutboxId) {
        try {
          setOutboxEntries(updateConversationOutbox(storageOwnerId, failedOutboxId, {
            status: OUTBOX_STATUS.queued,
            lastError: '',
            autoRecovery: true,
          }))
          setError('')
          return
        } catch {
          // Keep the original failure visible if the recovered turn cannot be
          // returned to durable storage.
        }
      }
      setError(reason)
      throw err
    } finally {
      setSendingConversationIds(prev => {
        const next = new Set(prev)
        next.delete(activeConversationId)
        return next
      })
    }
  }

  function removeQueuedConversationMessage(conversationId, queuedId) {
    if (!outboxEntriesFor(outboxEntries, conversationId, activeProfile).some(entry => entry.id === queuedId)) return false
    try {
      setOutboxEntries(removeConversationOutbox(storageOwnerId, queuedId))
      return true
    } catch (error) {
      setError(String(error?.message || error))
      return false
    }
  }

  function editQueuedConversationMessage(conversationId, queuedId) {
    const entry = outboxEntriesFor(outboxEntries, conversationId, activeProfile).find(item => item.id === queuedId)
    if (!entry) return
    if (!removeQueuedConversationMessage(conversationId, queuedId)) return
    setInput(prev => (prev.trim() ? `${prev} ${entry.text}` : entry.text))
    if (Array.isArray(entry.attachments) && entry.attachments.length > 0) {
      setImageAttachments(entry.attachments)
    }
    inputRef.current?.focus()
  }

  // A failed entry never retries on its own — a send that failed because the
  // engine is down would otherwise retry in a loop the user cannot see.
  function retryQueuedConversationMessage(conversationId, queuedId) {
    if (!outboxEntriesFor(outboxEntries, conversationId, activeProfile).some(entry => entry.id === queuedId)) return
    try {
      setOutboxEntries(updateConversationOutbox(storageOwnerId, queuedId, {
        status: OUTBOX_STATUS.queued,
        lastError: '',
      }))
    } catch (error) {
      setError(String(error?.message || error))
    }
  }

  // Drain one message at a time: whenever the active conversation goes idle
  // (turn finished — final/error/aborted cleared turnInFlight) and has a queued
  // entry, dispatch the oldest via a fromQueue send so it doesn't clobber the
  // composer. The entry is marked `sending` first, so a re-render mid-flight
  // cannot start it twice, and it is only removed once the send resolves —
  // a failure leaves it in the outbox as retryable instead of losing the text.
  useEffect(() => {
    if (
      !activeConversationId
      || permissionCoordinatorRef.current.blocked(activeProfile, activeConversationSessionKey)
      || turnInFlight
      || !conversationModelReady
      || !activeConversationRouteReady
      || conversationOwnerId !== storageOwnerId
    ) return
    let head
    try {
      head = claimQueuedConversationOutbox(storageOwnerId, {
        conversationId: activeConversationId,
        profile: activeProfile,
        employeeId: activeEmployee?.id,
        sessionKey: activeConversationSessionKey,
        ready: conversationModelReady,
        routeReady: activeConversationRouteReady,
      })
    } catch (error) {
      setError(String(error?.message || error))
      return
    }
    if (!head) return
    setSelectedSessionByEmployee(prev => ({ ...prev, [head.employeeId]: head.sessionKey }))
    setOutboxEntries(listConversationOutbox(storageOwnerId))
    sendMessage(null, head.text, head.attachments, head)
      .then(() => {
        // Gateway ACK moves the row to confirming in sendMessage. Canonical
        // `session.message` or history is the only code allowed to retire it.
      })
      .catch(error => {
        try {
          setOutboxEntries(updateConversationOutbox(storageOwnerId, head.id, {
            status: OUTBOX_STATUS.failed,
            lastError: String(error?.message || error || '发送失败'),
          }))
        } catch (storageError) {
          setError(String(storageError?.message || storageError))
        }
      })
  }, [permissionSaveVersion, turnInFlight, conversationModelReady, activeConversationRouteReady, activeEmployee?.id, activeConversationId, activeConversationSessionKey, activeProfile, outboxEntries, storageOwnerId, conversationOwnerId])

  // sendMessage rejects so the outbox drain can tell success from failure. The
  // composer already renders the error, so swallow it here rather than letting
  // it surface as an unhandled rejection.
  function handleComposerSubmit(event) {
    sendMessage(event).catch(() => null)
  }

  function useSuggestion(text) {
    setInput(text)
    closeMentionMenu()
  }

  function appendVoiceTranscript(transcript) {
    const text = String(transcript || '').trim()
    if (!text) return
    setInput(prev => `${prev}${prev.trim() ? ' ' : ''}${text}`)
    inputRef.current?.focus()
  }

  async function startVoiceInput() {
    if (!activeTarget || voiceListening || voiceProcessing) return
    setError('')
    setNativeVoicePartial('')
    if (!NATIVE_VOICE_INPUT_PLATFORM) {
      // 云端听写:先把麦克风拿到手再点亮状态,拒权时按钮不闪一下。
      try {
        cloudDictationRef.current = await startAudioRecording()
        setVoiceListening(true)
      } catch (event) {
        setError(`语音输入失败：${formatNativeVoiceInputError(event)}`)
      }
      return
    }
    setVoiceListening(true)
    try {
      await invoke('native_voice_input_start', { locale: 'zh-CN' })
    } catch (event) {
      setVoiceListening(false)
      setNativeVoicePartial('')
      setError(`语音输入失败：${formatNativeVoiceInputError(event)}`)
    }
  }

  async function stopVoiceInput() {
    if (!voiceListening) return
    if (!NATIVE_VOICE_INPUT_PLATFORM) {
      const controller = cloudDictationRef.current
      cloudDictationRef.current = null
      setVoiceListening(false)
      if (!controller) return
      setVoiceProcessing(true)
      try {
        const recorded = await controller.stop()
        const text = await transcribeDictationBlob(supabase, recorded, {
          shouldStop: () => voiceDisposedRef.current,
        })
        if (voiceDisposedRef.current) return
        if (text) appendVoiceTranscript(text)
      } catch (event) {
        if (!voiceDisposedRef.current) {
          setError(`语音输入失败：${formatNativeVoiceInputError(event)}`)
        }
      } finally {
        if (!voiceDisposedRef.current) setVoiceProcessing(false)
      }
      return
    }
    try {
      await invoke('native_voice_input_stop')
    } catch (event) {
      setError(`停止语音输入失败：${formatNativeVoiceInputError(event)}`)
    } finally {
      setNativeVoicePartial('')
      setVoiceListening(false)
    }
  }

  function toggleVoiceInput() {
    if (voiceProcessing) return
    if (voiceListening) {
      stopVoiceInput()
    } else {
      startVoiceInput()
    }
  }

  function updateInput(value, cursor = value.length) {
    setInput(value)
    const command = activeCommandQuery(value, cursor)
    const mention = activeMentionQuery(value, cursor)
    setMentionQuery(command ? { ...command, trigger: 'slash' } : mention ? { ...mention, trigger: 'mention' } : null)
    setMentionIndex(0)
  }

  async function addImageFiles(files) {
    const candidates = Array.from(files || []).filter(file => String(file?.type || '').startsWith('image/') || String(file?.type || '') === 'application/pdf')
    if (candidates.length === 0) return
    const openSlots = Math.max(0, CONVERSATION_IMAGE_MAX_COUNT - imageAttachments.length)
    if (openSlots === 0) {
      setError(`一次最多发送 ${CONVERSATION_IMAGE_MAX_COUNT} 张图片。`)
      return
    }
    try {
      if (!activeProfile) throw new Error('请先完成本机 Uniopc 引擎 Host 初始化，再添加附件。')
      const drafts = await Promise.all(candidates.slice(0, openSlots).map(file => readFileAsConversationImageAttachment(file)))
      const nextAttachments = await Promise.all(drafts.map(async draft => {
        const imported = await invoke('conversation_import_attachment_data_url', {
          profile: activeProfile,
          name: draft.name,
          dataUrl: draft.dataUrl,
        })
        return {
          id: imported.id,
          localMediaId: imported.id,
          name: imported.name,
          mimeType: imported.mimeType,
          size: imported.size,
          path: imported.path,
          dataUrl: convertFileSrc(imported.path),
        }
      }))
      validateConversationImageAttachments([...imageAttachments, ...nextAttachments])
      setImageAttachments(prev => [...prev, ...nextAttachments].slice(0, CONVERSATION_IMAGE_MAX_COUNT))
      setError(candidates.length > openSlots ? `一次最多发送 ${CONVERSATION_IMAGE_MAX_COUNT} 个附件。` : '')
    } catch (err) {
      setError(String(err?.message || err || '添加附件失败'))
    }
  }

  async function addNativeAttachmentPaths(paths) {
    const candidates = Array.from(paths || []).filter(path => typeof path === 'string' && path.trim())
    if (candidates.length === 0) return
    const openSlots = Math.max(0, CONVERSATION_IMAGE_MAX_COUNT - imageAttachments.length)
    if (openSlots === 0) {
      setError(`一次最多发送 ${CONVERSATION_IMAGE_MAX_COUNT} 个附件。`)
      return
    }
    try {
      if (!activeProfile) throw new Error('请先完成本机 Uniopc 引擎 Host 初始化，再添加附件。')
      const imported = await invoke('conversation_import_attachments', {
        profile: activeProfile,
        paths: candidates.slice(0, openSlots),
      })
      const nextAttachments = (Array.isArray(imported) ? imported : []).map(item => ({
        id: item.id,
        localMediaId: item.id,
        name: item.name,
        mimeType: item.mimeType,
        size: item.size,
        path: item.path,
        dataUrl: convertFileSrc(item.path),
      }))
      validateConversationImageAttachments([...imageAttachments, ...nextAttachments])
      setImageAttachments(prev => [...prev, ...nextAttachments].slice(0, CONVERSATION_IMAGE_MAX_COUNT))
      setError(candidates.length > openSlots ? `一次最多发送 ${CONVERSATION_IMAGE_MAX_COUNT} 个附件。` : '')
    } catch (err) {
      setError(String(err?.message || err || '添加附件失败'))
    }
  }

  async function openConversationAttachmentPicker() {
    try {
      const paths = await openFileDialog({
        multiple: true,
        filters: [{
          name: '支持的附件',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'avif', 'pdf', 'ppt', 'pptx', 'txt', 'mp4'],
        }],
      })
      if (!paths) return
      await addNativeAttachmentPaths(Array.isArray(paths) ? paths : [paths])
    } catch (err) {
      setError(String(err?.message || err || '打开附件选择器失败'))
    }
  }

  function removeImageAttachment(id) {
    setImageAttachments(prev => prev.filter(item => item.id !== id))
  }

  function closeMentionMenu() {
    setMentionQuery(null)
    setMentionIndex(0)
  }

  function chooseMention(option) {
    if (!option || option.disabled) return
    const cursor = inputRef.current?.selectionStart ?? input.length
    const selectedOption = mentionQuery?.trigger === 'slash' && option.kind === 'plugin'
      ? { ...option, toolName: option.toolName || null }
      : option
    const nextInput = mentionQuery?.trigger === 'slash'
      ? insertCommandToken(input, cursor, selectedOption)
      : insertMentionToken(input, cursor, selectedOption)
    setInput(nextInput)
    closeMentionMenu()
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      const nextCursor = nextInput.length
      inputRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  async function handleStopConversation() {
    if (!activeEmployee || !activeStreamingMessage?.runId) return
    if (!activeProfile) return
    userCancelledGatewayRunRef.current = {
      conversationId: activeConversationId,
      runId: activeStreamingMessage.runId,
      sessionKey: activeConversationSessionKey,
    }
    try {
      await abortConversationTurn({
        sessionKey: activeConversationSessionKey,
        runId: activeStreamingMessage.runId,
        profile: activeProfile,
      })
    } catch (err) {
      userCancelledGatewayRunRef.current = null
      setError(String(err?.message || err || '停止失败'))
    } finally {
      setSendingConversationIds(prev => {
        const next = new Set(prev)
        if (activeConversationId) next.delete(activeConversationId)
        return next
      })
    }
  }

  useEffect(() => {
    function handleConversationEscape(event) {
      if (event.key !== 'Escape') return
      if (event.defaultPrevented || document.querySelector('.ui-modal')) return
      if (imeCompositionRef.current || event.isComposing || event.keyCode === 229) return
      if (!turnInFlight) return
      event.preventDefault()
      handleStopConversation()
    }

    document.addEventListener('keydown', handleConversationEscape)
    return () => document.removeEventListener('keydown', handleConversationEscape)
  }, [turnInFlight, handleStopConversation])

  const rateLimitError = isModelRateLimitError(error)
  const modelCredentialsUnavailable = isGatewayModelCredentialsUnavailable(error)
  const modelAccountUnavailable = rateLimitError || modelCredentialsUnavailable
  const nativeVoiceError = isNativeVoiceInputError(error)
  // A benign tool/file step failure is not an engine problem — show it calmly and
  // drop the "去检查引擎" recovery CTA (engine classifiers take priority).
  const toolStepError = !rateLimitError && !nativeVoiceError && isNonFatalToolStepError(error)
  const calmError = modelAccountUnavailable || toolStepError
  // 「去本机权限」CTA 只在 macOS 有意义:那页管理的是 TCC 权限;Windows/Linux 的
  // 云端听写拒权发生在 webview 层,跳过去也没有开关可按。
  const voicePermissionCta = nativeVoiceError && NATIVE_VOICE_INPUT_PLATFORM
  const errorActionPath = voicePermissionCta
    ? profileWorkspacePath(profileWorkspace, 'host-permissions')
    : hostRecoveryPath(modelAccountUnavailable, profileWorkspace)
  const errorActionLabel = voicePermissionCta ? '去本机权限检查语音权限' : hostRecoveryLabel(modelAccountUnavailable)
  const errorTitle = nativeVoiceError
    ? '语音输入不可用'
    : modelAccountUnavailable
      ? '当前模型账号暂不可用'
      : toolStepError
        ? '有一个步骤没能完成'
        : '发送失败'

  return (
    <div className="h-full min-h-0 w-full overflow-hidden">
      <section className="relative grid h-full min-h-0 overflow-hidden bg-transparent lg:grid-cols-[240px_1px_minmax(0,1fr)]">
        <div className="pointer-events-none absolute inset-x-0 top-16 z-10 h-px bg-subtle" />

        <EmployeeListPane
          mode="chat"
          employees={employees}
          roster={conversationRoster}
          loading={loadingEmployees}
          activeEmployeeId={activeEmployeeId}
          busyEmployeeId={turnInFlight ? activeEmployeeId : ''}
          onAdd={() => navigate(profileWorkspace
            ? `${profileWorkspacePath(profileWorkspace, 'employees')}?create=1`
            : buildEmployeeCreatePath(), { state: profileWorkspaceState })}
          onOpenEmployeeChat={selectEmployee}
          onOpenEmployeeSettings={openEmployeeSettings}
        />

        <div className="hidden bg-subtle lg:block" />

        {rightPaneMode === 'settings' ? (
          <InlineEmployeeSettingsPanel
            employee={activeEmployee}
            activeProfile={activeProfile}
            canManageSkillAssignments={Boolean(activeOpenClaw.isAdmin || activeOpenClaw.isOwner)}
            onClose={() => setRightPaneMode('chat')}
            onSkillsChanged={() => loadMentionResources({ silent: true })}
          />
        ) : (
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <header className="relative flex h-16 shrink-0 items-center justify-between px-6">
            {/* 标题位原来写死「对话」—— 侧栏导航和窗口标题都已经这么说了，
                而真正该占标题位的「在跟谁说话」被挤到了副标题。
                现在标题是对方，副标题是对方负责什么。 */}
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="min-w-0 truncate text-lg font-semibold text-primary">
                  {activeTarget
                    ? displayEmployeeName(activeEmployee)
                    : '对话'}
                </h2>
                <SessionPicker
                  open={sessionPickerOpen}
                  pickerRef={sessionPickerRef}
                  activeEmployee={activeEmployee}
                  activeSessionKey={activeConversationSessionKey}
                  activeTitle={activeSessionTitle}
                  sessions={conversationSessions}
                  loading={conversationSessionsLoading}
                  error={conversationSessionsError}
                  search={sessionSearch}
                  creating={creatingConversationSession}
                  editingSessionKey={editingSessionKey}
                  editingSessionLabel={editingSessionLabel}
                  renamingSessionKey={renamingSessionKey}
                  onToggle={() => {
                    setSessionPickerOpen(open => !open)
                    setApprovalMenuOpen(false)
                    setModelMenuOpen(false)
                  }}
                  onSearch={setSessionSearch}
                  onSelect={selectGatewayConversationSession}
                  onCreate={createGatewayConversationSession}
                  onRefresh={() => refreshConversationSessions({ silent: false })}
                  onStartRename={startRenameConversationSession}
                  onRenameLabelChange={setEditingSessionLabel}
                  onCancelRename={() => {
                    setEditingSessionKey('')
                    setEditingSessionLabel('')
                  }}
                  onRenameSession={onRenameSession}
                />
              </div>
              <div className="mt-0.5 truncate text-xs text-tertiary">
                {activeTarget
                  ? plainSummary(activeEmployee?.description, 60)
                  : '选择一位员工开始对话'}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setConversationDock(current => current === 'browser' ? null : 'browser')}
                disabled={!activeProfile}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-base transition-colors disabled:opacity-40 ${conversationDock === 'browser' ? 'bg-state-selected text-accent-text' : 'text-secondary hover:bg-state-hover hover:text-primary'}`}
                title="切换浏览器面板"
                aria-label="切换浏览器面板"
              >
                ◎
              </button>
              <button
                type="button"
                onClick={() => setConversationDock(current => current === 'tasks' ? null : 'tasks')}
                disabled={!activeProfile}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-base transition-colors disabled:opacity-40 ${conversationDock === 'tasks' ? 'bg-state-selected text-accent-text' : 'text-secondary hover:bg-state-hover hover:text-primary'}`}
                title="显示后台任务"
                aria-label="显示后台任务"
              >
                ☷
              </button>
              <button
                type="button"
                onClick={() => setConversationDock(current => current === 'split' ? null : 'split')}
                disabled={!activeProfile || conversationSessions.length < 2}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-base transition-colors disabled:opacity-40 ${conversationDock === 'split' ? 'bg-state-selected text-accent-text' : 'text-secondary hover:bg-state-hover hover:text-primary'}`}
                title="打开拆分视图"
                aria-label="打开拆分视图"
              >
                ◫
              </button>
              <button
                type="button"
                onMouseDown={event => event.stopPropagation()}
                onClick={() => {
                  setSessionMenuOpen(open => !open)
                  setApprovalMenuOpen(false)
                  setModelMenuOpen(false)
                }}
                disabled={!activeConversationSessionKey}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-lg text-secondary transition-colors hover:bg-state-hover hover:text-primary disabled:opacity-40"
                title="更多会话操作"
                aria-label="更多会话操作"
              >
                ⋯
              </button>
            </div>
            {sessionMenuOpen && (
              <div ref={sessionActionMenuRef} className="absolute right-6 top-14 z-30 w-52 overflow-hidden rounded-lg border border-default bg-surface-raised py-1 shadow-xl">
                <button type="button" onClick={() => { startRenameConversationSession(activeGatewaySession || { sessionKey: activeConversationSessionKey, title: activeSessionTitle }); setSessionMenuOpen(false); setSessionPickerOpen(true) }} className="w-full px-3 py-2 text-left text-sm text-primary hover:bg-state-hover">重命名…</button>
                <button type="button" disabled={sessionActionLoading} onClick={() => runActiveSessionAction(activeGatewaySession?.pinned ? 'unpin' : 'pin')} className="w-full px-3 py-2 text-left text-sm text-primary hover:bg-state-hover disabled:opacity-50">{activeGatewaySession?.pinned ? '取消置顶' : '置顶会话'}</button>
                <button type="button" disabled={sessionActionLoading} onClick={() => runActiveSessionAction(activeGatewaySession?.unread ? 'mark_read' : 'mark_unread')} className="w-full px-3 py-2 text-left text-sm text-primary hover:bg-state-hover disabled:opacity-50">{activeGatewaySession?.unread ? '标为已读' : '标为未读'}</button>
                <div className="my-1 border-t border-subtle" />
                <button type="button" disabled={sessionActionLoading} onClick={() => runActiveSessionAction(activeGatewaySession?.archived ? 'restore' : 'archive')} className="w-full px-3 py-2 text-left text-sm text-primary hover:bg-state-hover disabled:opacity-50">{activeGatewaySession?.archived ? '恢复会话' : '归档会话'}</button>
              </div>
            )}
          </header>

          {conversationDock && <ConversationDock key={activeProfile} mode={conversationDock} activeProfile={activeProfile} activeSessionKey={activeConversationSessionKey} sessions={conversationSessions} selectedBrowserTargetId={browserTargetByProfile[activeProfile] || ''} onBrowserTargetChange={rememberBrowserTarget} onClose={() => setConversationDock(null)} />}

          <div
            ref={listRef}
            onScroll={event => {
              const pinned = isConversationScrollPinnedToBottom(event.currentTarget)
              conversationScrollPinnedRef.current = pinned
              setScrollFabVisible(!pinned)
            }}
            className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3"
          >
            <div className="flex min-h-full w-full min-w-0 flex-col">
              {!activeTarget ? (
                <div className="flex flex-1 items-center justify-center text-center">
                  <div>
                    <div className="text-2xl font-semibold tracking-[-0.02em] text-primary">选择一位员工</div>
                    <div className="mt-2 text-base text-tertiary">从左侧挑一位，开始交代工作</div>
                  </div>
                </div>
              ) : (
                <>
                  {loadingMessages && activeMessages.length === 0 && (
                    <div className="flex flex-1 items-center justify-center text-center text-base text-tertiary">
                      正在同步 {displayEmployeeName(activeEmployee)} 的历史对话...
                    </div>
                  )}

                  {!loadingMessages && !hasMessages && (
                    <div className="flex flex-1 items-center justify-center text-center">
                      <div className="w-full max-w-[640px]">
                        {/* 空状态是引导下一步的机会，不是放品牌语的地方。
                            原来这里写死英文 Welcome to Uniopc / How can this agent help?，
                            既是中英混排，也没告诉人接下来该做什么。 */}
                        <div className="text-2xl font-semibold tracking-[-0.03em] text-primary">
                          {displayEmployeeName(activeEmployee)} 在等你开口
                        </div>
                        <div className="mt-2 text-base text-tertiary">
                          {plainSummary(activeEmployee?.description, 48) || '交代一件事，或从下面挑一个开始'}
                        </div>
                        <div className="mt-10 space-y-3">
                          {PROMPT_SUGGESTIONS.map(item => (
                            <button
                              key={item}
                              type="button"
                              onClick={() => useSuggestion(item)}
                              className="flex h-12 w-full items-center rounded-lg border border-default bg-surface-raised px-4 text-left text-base text-primary transition-colors hover:bg-state-hover hover:text-primary"
                            >
                              <span className="mr-3 text-sm text-tertiary">→</span>
                              {item}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {hasMessages && (
                    <div className="flex min-w-0 flex-col gap-5 pb-4">
                      {activeMessages.map((message, index) => (
                        <div
                          key={`${message.id || 'message'}-${index}`}
                          className={`flex min-w-0 gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        >
                          {message.role !== 'user' && (
                            <div className="mt-1">
                              <EmployeeAvatar
                                name={displayEmployeeName(activeEmployee)}
                                emoji={activeEmployee.emoji}
                                size="md"
                                kind="ai"
                              />
                            </div>
                          )}
                          <div
                            onMouseEnter={() => setHoveredMessageId(String(message.id || ''))}
                            onMouseLeave={() => setHoveredMessageId(current => (current === String(message.id || '') ? '' : current))}
                            className={`group min-w-0 max-w-[calc(100%-88px)] ${message.role === 'user' ? 'items-end' : 'items-start'} flex flex-col`}
                          >
                            <div className="mb-1 text-2xs text-tertiary">
                              {message.role === 'user' ? '你' : displayEmployeeName(activeEmployee)}
                              {messageTime(message.createdAt) ? ` · ${messageTime(message.createdAt)}` : ''}
                            </div>
                            {Array.isArray(message.attachments) && message.attachments.length > 0 && (
                              <div className={`mb-2 flex max-w-full flex-wrap gap-2 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                {message.attachments.map(attachment => (
                                  <div key={attachment.id || attachment.path || attachment.dataUrl} title={attachment.name}>
                                    {String(attachment.mimeType || '').startsWith('image/') ? (
                                      <img
                                        src={attachment.dataUrl}
                                        alt={attachment.name || '图片附件'}
                                        className="max-h-48 max-w-64 rounded-lg border border-subtle object-contain"
                                      />
                                    ) : attachment.mimeType === 'video/mp4' ? (
                                      <div className="flex flex-col gap-1">
                                        <video controls preload="metadata" className="max-h-48 max-w-64 rounded-lg border border-subtle">
                                          <source src={attachment.dataUrl} type="video/mp4" />
                                        </video>
                                        <a href={attachment.dataUrl} download={attachment.name || '附件.mp4'} className="text-2xs text-accent-text hover:underline">
                                          下载 {attachment.name || '视频附件'}
                                        </a>
                                      </div>
                                    ) : (
                                      <a
                                        href={attachment.dataUrl}
                                        download={attachment.name || '附件'}
                                        className="flex max-w-64 items-center gap-2 rounded-lg border border-subtle bg-surface-raised px-3 py-2 text-xs text-secondary hover:bg-state-hover"
                                        title={`下载 ${attachment.name || '附件'}`}
                                      >
                                        <span className="shrink-0 font-semibold text-accent">{conversationAttachmentTypeLabel(attachment.mimeType)}</span>
                                        <span className="truncate">{attachment.name || '附件'}</span>
                                        <span className="shrink-0 text-accent-text">下载</span>
                                      </a>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                            {message.role !== 'user' && message.id != null && toolTimelineByMessageId[String(message.id)] && (
                              <div className="mb-2 w-full">
                                <ConversationProcessTimeline
                                  reasoning={null}
                                  timeline={toolTimelineByMessageId[String(message.id)]}
                                  expanded={expandedProcessMsgIds.has(String(message.id))}
                                  onToggle={() => setExpandedProcessMsgIds(prev => {
                                    const next = new Set(prev)
                                    const id = String(message.id)
                                    if (next.has(id)) next.delete(id)
                                    else next.add(id)
                                    return next
                                  })}
                                />
                              </div>
                            )}
                            {message.role !== 'user' && message.id != null && (
                              <ConversationToolOutputMedia timeline={toolTimelineByMessageId[String(message.id)]} messageContent={message.content} />
                            )}
                            {(message.content || message.role !== 'user' || !Array.isArray(message.attachments) || message.attachments.length === 0) && (
                              <div
                                data-selectable="true"
                                className={`max-w-full overflow-hidden break-words text-base leading-6 whitespace-pre-wrap [overflow-wrap:anywhere] [word-break:break-word] ${
                                  message.role === 'user'
                                    ? message.status === 'failed'
                                      ? 'rounded-lg px-4 py-3 border border-subtle bg-danger-surface text-primary'
                                      : 'rounded-lg px-4 py-3 border border-brand/25 bg-state-selected text-primary'
                                    : message.status === 'failed'
                                      ? 'rounded-lg px-4 py-3 border border-subtle bg-danger-surface text-danger-text'
                                    : 'px-0.5 py-1 text-primary'
                                }`}
                              >
                                <ConversationMessageContent
                                  content={message.content}
                                  role={message.role}
                                  streaming={message.status === 'streaming'}
                                  documentLabels={documentMentionLabels}
                                />
                              </div>
                            )}
                            <div className={`mt-1 flex items-center gap-2 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                              {message.role === 'user'
                                && Array.isArray(message.attachments)
                                && message.attachments.length > 0
                                && message.status !== 'failed'
                                && message.status !== 'sending'
                                && message.status !== 'confirming'
                                && (
                                <span className="text-2xs text-tertiary">
                                  已送达 · 附件解析状态未知
                                </span>
                              )}
                              {message.role === 'user' && message.status === 'failed' && (
                                <>
                                  <span className="text-2xs text-danger-text">未送达</span>
                                  <button
                                    type="button"
                                    onClick={() => editResendFailedMessage(message)}
                                    className="text-2xs text-accent-text transition-colors hover:text-accent-text"
                                  >
                                    编辑重发
                                  </button>
                                </>
                              )}
                              {message.content && message.status !== 'streaming' && (
                                <button
                                  type="button"
                                  onClick={() => copyConversationMessage(message)}
                                  className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition-all ${
                                    copiedMessageId === String(message.id || '')
                                      ? 'text-success-text opacity-100'
                                      : hoveredMessageId === String(message.id || '')
                                        ? 'text-tertiary opacity-100 hover:bg-state-hover hover:text-secondary'
                                        : 'text-tertiary opacity-0'
                                  }`}
                                  title="复制消息"
                                  aria-label={copiedMessageId === String(message.id || '') ? '已复制' : '复制消息'}
                                >
                                  {copiedMessageId === String(message.id || '') ? (
                                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                    </svg>
                                  ) : (
                                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
                                      <rect x="9" y="9" width="11" height="11" rx="2" />
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                    </svg>
                                  )}
                                </button>
                              )}
                            </div>
                          </div>
                          {message.role === 'user' && (
                            <div className="mt-1">
                              <EmployeeAvatar name={currentUserDisplayName} avatarUrl={currentUserAvatarUrl} size="md" kind="human" />
                            </div>
                          )}
                        </div>
		                      ))}
                      {activePendingGatewayRunId && (
                        <div
                          key={`streaming-${activePendingGatewayRunId}`}
                          className="flex min-w-0 justify-start gap-3"
                        >
                          <div className="mt-1">
                            <EmployeeAvatar
                              name={displayEmployeeName(activeEmployee)}
                              emoji={activeEmployee.emoji}
                              size="md"
                              kind="ai"
                            />
                          </div>
                          <div className="flex min-w-0 max-w-[calc(100%-88px)] flex-col items-stretch">
                            <div className="mb-1 text-2xs text-tertiary">
                              {displayEmployeeName(activeEmployee)}
                            </div>
                            {/* Live turn: process strip on top, streaming answer below — one block. */}
                            {activeProcessStripVisible && (
                              <div className="mb-2 w-full">
                                <ConversationProcessTimeline
                                  reasoning={activeReasoningPanel}
                                  timeline={activeToolTimeline}
                                  expanded={activeProcessExpanded}
                                  onToggle={() => setProcessExpandedByConversation(prev => ({ ...prev, [activeConversationId]: !activeProcessExpanded }))}
                                />
                              </div>
                            )}
                            {!activeToolTimeline?.finishedAt && <ConversationToolOutputMedia timeline={activeToolTimeline} messageContent={activeStreamingAssistantText} />}
                            {(activeStreamingAssistantText || !activeProcessStripVisible) && (
                              <div data-selectable="true" className="max-w-full self-start overflow-hidden break-words px-0.5 py-1 text-base leading-6 whitespace-pre-wrap text-primary [overflow-wrap:anywhere] [word-break:break-word]">
                                <ConversationStreamingAssistantBubble content={activeStreamingAssistantText} />
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            {scrollFabVisible && hasMessages && (
              <div className="pointer-events-none sticky bottom-1 z-10 flex justify-center">
                <button
                  type="button"
                  onClick={() => {
                    smoothScrollConversationToBottom(listRef.current)
                    setScrollFabVisible(false)
                    conversationScrollPinnedRef.current = true
                  }}
                  className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-default bg-surface-raised px-3.5 text-xs font-medium text-primary shadow-lg transition-colors hover:bg-state-hover hover:text-primary"
                  title="回到底部"
                >
                  <span aria-hidden="true">↓</span>
                  回到底部
                </button>
              </div>
            )}
          </div>

          <ConversationStatusBanner
            notice={chatNotice ? {
              message: chatNotice,
              onDismiss: () => setChatNotice(''),
            } : null}
            error={error ? {
              message: sanitizeBrand(error),
              title: errorTitle,
              calm: calmError,
              description: modelCredentialsUnavailable
                ? 'Uniopc 官方模型的凭据因认证或计费异常被暂时停用。请切换模型，或等待服务恢复后重试。'
                : rateLimitError
                ? '模型账号冷却、鉴权失败或额度异常。可以等待恢复，或去当前 Profile 模型页重新绑定可用账号。'
                : toolStepError
                  ? '某个工具步骤失败了（通常是读取了一个不存在的文件），不影响 Uniopc 引擎运行，可以忽略或重试。'
                  : sanitizeBrand(error),
              rawMessage: calmError ? sanitizeBrand(error) : '',
              showRecovery: !toolStepError,
              recoveryLabel: errorActionLabel,
            } : null}
            onNavigateRecovery={() => navigate(errorActionPath, { state: profileWorkspaceState })}
          />

          <ConversationArtifactsSlot
            ownerId={user?.uid || null}
            conversationId={activeConversationId}
            sessionKey={activeConversationSessionKey}
            profile={activeProfile || null}
            gatewayReady={gatewayReady}
          />

          <form
            ref={composerRef}
            onSubmit={handleComposerSubmit}
            onDragEnter={event => {
              if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return
              event.preventDefault()
              imageDragDepthRef.current += 1
              setIsDraggingFiles(true)
            }}
            onDragOver={event => {
              if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
            }}
            onDragLeave={event => {
              if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return
              event.preventDefault()
              imageDragDepthRef.current = Math.max(0, imageDragDepthRef.current - 1)
              if (imageDragDepthRef.current === 0) setIsDraggingFiles(false)
            }}
            onDrop={event => {
              if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return
              event.preventDefault()
              imageDragDepthRef.current = 0
              setIsDraggingFiles(false)
              addImageFiles(event.dataTransfer.files)
            }}
            className={`shrink-0 px-3 pb-3 ${isDraggingFiles ? 'rounded-lg outline outline-2 outline-offset-2 outline-accent' : ''}`}
          >
            {pendingExecApprovals
              .filter(approval => approval?.request?.sessionKey === activeConversationSessionKey)
              .map(approval => {
                const request = approval.request
                const busy = resolvingExecApprovalId === approval.id
                return (
                  <div key={approval.id} className="mb-2 w-full rounded-lg border border-amber-400/30 bg-amber-400/10 p-3" data-testid="exec-approval-request">
                    <div className="text-sm font-medium text-primary">命令请求人工批准</div>
                    <code className="mt-1 block max-h-24 overflow-auto whitespace-pre-wrap break-all text-xs text-secondary">{request.command || request.rawCommand || '未提供命令'}</code>
                    <div className="mt-1 text-xs text-tertiary">{request.host || 'gateway'} · {request.cwd || '默认目录'}</div>
                    <div className="mt-3 flex justify-end gap-2">
                      <button type="button" disabled={busy} onClick={() => resolvePendingExecApproval(approval, 'deny')} className="rounded-md border border-default px-3 py-1.5 text-xs text-secondary disabled:opacity-50">拒绝</button>
                      <button type="button" disabled={busy} onClick={() => resolvePendingExecApproval(approval, 'allow-once')} className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">{busy ? '处理中…' : '允许一次'}</button>
                    </div>
                  </div>
                )
              })}
            {pendingPluginApprovals
              .filter(approval => {
                const request = approval?.request || {}
                return !request.sessionKey || request.sessionKey === activeConversationSessionKey
              })
              .map(approval => {
                const request = approval?.request || {}
                const busy = resolvingPluginApprovalId === approval.id
                return (
                  <div key={approval.id} className="mb-2 w-full rounded-lg border border-amber-400/30 bg-amber-400/10 p-3">
                    <div className="text-sm font-medium text-primary">{request.title || '插件请求写入本地工作区'}</div>
                    {request.description && <div className="mt-1 text-xs text-secondary">{request.description}</div>}
                    <div className="mt-3 flex justify-end gap-2">
                      <button type="button" disabled={busy} onClick={() => resolvePendingPluginApproval(approval, 'deny')} className="rounded-md border border-default px-3 py-1.5 text-xs text-secondary disabled:opacity-50">拒绝</button>
                      <button type="button" disabled={busy} onClick={() => resolvePendingPluginApproval(approval, 'allow-once')} className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">{busy ? '处理中…' : '允许一次'}</button>
                    </div>
                  </div>
                )
              })}
            {activeQueuedMessages.length > 0 && (
              <div className="mb-2 w-full space-y-1.5">
                <div className="px-1 text-2xs font-medium text-tertiary">
                  待发送消息（{activeQueuedMessages.length}/{MAX_QUEUED_MESSAGES}）
                </div>
                {activeQueuedMessages.map((queued, index) => (
                  <div
                    key={queued.id}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${
                      queued.status === OUTBOX_STATUS.failed
                        ? 'border-rose-400/25 bg-rose-400/10'
                        : queued.status === OUTBOX_STATUS.confirming
                          ? 'border-amber-400/25 bg-amber-400/10'
                        : 'border-subtle bg-surface-raised'
                    }`}
                  >
                    <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-state-hover px-1.5 text-2xs font-medium text-secondary">
                      {queued.status === OUTBOX_STATUS.failed ? '!' : queued.status === OUTBOX_STATUS.confirming ? '…' : index + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-primary">
                      <span className="block truncate">{queued.text || `（${queued.attachments?.length || 0} 个附件）`}</span>
                      <span className="block truncate text-2xs text-tertiary">
                        {conversationOutboxStatusLabel(queued, { gatewayReady, conversationModelReady, turnInFlight })}
                      </span>
                      {queued.attachmentsDropped && (
                        <span className="ml-1 text-2xs text-warning-text">图片过大未保存，需重新选择</span>
                      )}
                      {queued.status === OUTBOX_STATUS.failed && queued.lastError && (
                        <span className="ml-1 text-2xs text-danger-text">{sanitizeBrand(queued.lastError)}</span>
                      )}
                    </span>
                    {[OUTBOX_STATUS.failed, OUTBOX_STATUS.confirming].includes(queued.status) && (
                      <ConversationStatusBanner
                        queuedMessageId={queued.id}
                        retryDisabled={queued.attachmentsDropped}
                        onRetryQueuedMessage={queuedMessageId => {
                          if (queuedMessageId !== queued.id) return
                          retryQueuedConversationMessage(activeConversationId, queued.id)
                        }}
                      />
                    )}
                    <button
                      type="button"
                      disabled={queued.status === OUTBOX_STATUS.sending}
                      onClick={() => editQueuedConversationMessage(activeConversationId, queued.id)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs text-secondary transition-colors hover:bg-state-hover hover:text-primary"
                      title="取回编辑"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      disabled={queued.status === OUTBOX_STATUS.sending}
                      onClick={() => removeQueuedConversationMessage(activeConversationId, queued.id)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs text-secondary transition-colors hover:bg-rose-500/15 hover:text-danger-text"
                      title="移除"
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="relative w-full rounded-lg border border-default bg-surface-raised shadow-sm">
              {mentionQuery && (mentionOptions.length > 0 || mentionResourcesLoading || mentionResourcesError || mentionQuery.trigger === 'slash') && (
                <div className="absolute bottom-[calc(100%+8px)] left-0 z-20 w-full max-w-[520px] overflow-hidden rounded-lg border border-default bg-surface-raised shadow-xl">
                  <div className="border-b border-subtle px-3 py-2 text-2xs font-medium uppercase tracking-[0.08em] text-tertiary">
                    {mentionQuery.trigger === 'slash' ? '/ 调用已就绪能力' : '@ 引用上下文'}
                  </div>
                  <div ref={mentionListRef} onScroll={handleMentionListScroll} className="max-h-72 overflow-y-auto py-1">
                    {mentionResourcesLoading && mentionOptions.length === 0 && (
                      <div className="px-3 py-3 text-sm text-tertiary">
                        正在读取当前员工 / profile 的 Skill、Plugin、MCP、项目和文档...
                      </div>
                    )}
                    {!mentionResourcesLoading && mentionOptions.length === 0 && mentionResourcesError && (
                      <button
                        type="button"
                        onMouseDown={event => {
                          event.preventDefault()
                          loadMentionResources().catch(() => null)
                        }}
                        className="block w-full px-3 py-3 text-left text-sm text-rose-500 hover:bg-rose-50"
                      >
                        {mentionResourcesError} 点击重试。
                      </button>
                    )}
                    {!mentionResourcesLoading && !mentionResourcesError && mentionOptions.length === 0 && mentionQuery.trigger === 'slash' && (
                      <div className="px-3 py-3 text-sm text-tertiary">
                        当前员工 / profile 没有可调用的能力。请到「插件」页确认插件已安装、启用并就绪(缺环境变量 / 未授权的插件不会出现在这里)。
                      </div>
                    )}
                    {mentionOptions.map((option, index) => {
                      const disabled = option.disabled === true
                      return (
                        <button
                          key={`${option.kind}:${option.name}`}
                          type="button"
                          data-mention-index={index}
                          disabled={disabled}
                          onMouseDown={event => {
                            event.preventDefault()
                            if (disabled) return
                            chooseMention(option)
                          }}
                          className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                            disabled
                              ? 'cursor-not-allowed text-secondary opacity-60'
                              : index === mentionIndex
                                ? 'bg-state-selected text-accent-text'
                                : 'text-primary hover:bg-state-hover'
                          }`}
                        >
                          <span className={`inline-flex h-6 min-w-12 items-center justify-center rounded-md border px-2 text-2xs font-medium ${mentionBadgeClass(option.kind)}`}>
                            {MENTION_KINDS[option.kind] || option.kind}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{option.label || option.name}</span>
                            <span className={`mt-0.5 block truncate text-xs ${disabled ? 'text-amber-500' : 'text-tertiary'}`}>
                              {disabled
                                ? option.description
                                : (option.summary || option.description || (mentionQuery.trigger === 'slash' ? '可在本轮对话中调用' : '可在本轮对话中引用'))}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {attachmentMenuOpen && (
                <div className="absolute bottom-12 left-4 z-20 w-[250px] overflow-hidden rounded-lg border border-default bg-surface-raised py-1 shadow-xl">
                  <div className="border-b border-subtle px-3 py-2 text-2xs font-medium text-tertiary">添加到本轮对话</div>
                  <button type="button" onMouseDown={event => { event.preventDefault(); chooseAttachmentAction('file') }} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-primary hover:bg-state-hover"><span>▧</span><span>文件附件</span></button>
                  <button type="button" onMouseDown={event => { event.preventDefault(); chooseAttachmentAction('skills') }} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-primary hover:bg-state-hover"><span>⌘</span><span>Skills 与工具</span></button>
                  <button type="button" onMouseDown={event => { event.preventDefault(); chooseAttachmentAction('connectors') }} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-primary hover:bg-state-hover"><span>⌁</span><span>连接器</span></button>
                  <button type="button" onMouseDown={event => { event.preventDefault(); chooseAttachmentAction('search') }} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-primary hover:bg-state-hover"><span>◎</span><span>网页搜索</span></button>
                </div>
              )}
              {approvalMenuOpen && (
                <div className="absolute bottom-12 left-4 z-20 w-[260px] overflow-hidden rounded-lg border border-default bg-surface-raised shadow-xl">
                  <div className="border-b border-subtle px-3 py-2 text-2xs font-medium text-tertiary">
                    Uniopc 引擎 执行策略
                  </div>
                  <div className="py-1">
                    {CONVERSATION_APPROVAL_MODES.map(mode => (
                      <button
                        key={mode.id}
                        type="button"
                        onMouseDown={event => {
                          event.preventDefault()
                          chooseConversationPermission(mode.id)
                        }}
                        className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors ${
                          approvalMode === mode.id
                            ? 'bg-state-selected text-accent-text'
                            : 'text-primary hover:bg-state-hover'
                        }`}
                      >
                        <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current text-xs">
                          {approvalMode === mode.id ? '✓' : ''}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">{mode.label}</span>
                          <span className="mt-0.5 block text-xs leading-4 text-tertiary">{mode.summary}</span>
                          <span className="mt-0.5 block truncate text-2xs text-tertiary">{mode.openClaw}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {modelMenuOpen && (
                <div className="absolute bottom-12 right-14 z-20 flex max-h-[calc(80vh-144px)] w-[320px] flex-col overflow-hidden rounded-lg border border-default bg-surface-raised shadow-xl">
                  <div className="flex shrink-0 items-center justify-between gap-2 border-b border-subtle px-3 py-2 text-2xs font-medium text-tertiary">
                    <span>
                      本轮模型
                      <span className="ml-2 normal-case text-tertiary">模型来源：当前 Uniopc 引擎 profile</span>
                    </span>
                    {llmBalance != null && (
                      <span className="shrink-0 normal-case text-secondary">
                        剩余 {Math.round(llmBalance * 100) / 100} credits
                      </span>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
                    {conversationModelChoices.map(choice => {
                      const selected = selectedModelOverride
                        ? selectedModelOverride === choice.modelRef
                        : choice.isOfficialDefault
                          // The default entry also claims legacy official refs
                          // that predate the catalog (e.g. a profile default of
                          // uniopc-official/<old-id> not in today's catalog).
                          ? String(activeProfileDefaultModelRef || '').startsWith(`${UNIOPC_OFFICIAL_PROVIDER}/`)
                            && !conversationModelChoices.some(other => !other.isOfficialDefault && other.modelRef === activeProfileDefaultModelRef)
                          : choice.modelRef === activeProfileDefaultModelRef
                      const detail = choice.detail || formatOpenClawModelLabel(choice.modelRef)
                      return (
                        <button
                          key={choice.id}
                          type="button"
                          onMouseDown={event => {
                            event.preventDefault()
                            if (!choice.selectable) return
                            chooseConversationModel(choice.modelRef)
                          }}
                          disabled={!choice.selectable}
                          className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors ${
                            selected
                              ? 'bg-state-selected text-accent-text'
                              : choice.selectable
                                ? 'text-primary hover:bg-state-hover'
                                : 'text-tertiary opacity-60'
                          }`}
                        >
                          <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current text-xs">
                            {selected ? '✓' : ''}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {choice.label}
                              {choice.officialBadge && (
                                <span className="ml-1.5 inline-block rounded bg-violet-500/20 px-1.5 py-px align-middle text-2xs font-medium text-accent-text">
                                  {choice.officialBadge}
                                </span>
                              )}
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-tertiary">{detail}</span>
                            {!choice.providerReady && choice.providerStatus && (
                              <span className="mt-0.5 block truncate text-2xs text-warning-text">provider {choice.providerStatus}</span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              <textarea
                ref={inputRef}
                value={input}
                onChange={event => updateInput(event.target.value, event.target.selectionStart)}
                onPaste={event => {
                  const files = Array.from(event.clipboardData?.files || []).filter(file => String(file?.type || '').startsWith('image/'))
                  if (files.length > 0) {
                    addImageFiles(files)
                  }
                }}
                placeholder={!activeTarget ? '先写下你想做的事…' : '交代一件事…　@ 引用上下文，/ 调用工具'}
                rows={2}
                onCompositionStart={() => { imeCompositionRef.current = true }}
                onCompositionEnd={() => {
                  // WKWebView fires compositionend before the committing keydown, so clear on the next tick.
                  setTimeout(() => { imeCompositionRef.current = false }, 0)
                }}
                onKeyDown={event => {
                  if (imeCompositionRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
                  if (mentionQuery && mentionOptions.length > 0) {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      setMentionIndex(index => (index + 1) % mentionOptions.length)
                      return
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      setMentionIndex(index => (index - 1 + mentionOptions.length) % mentionOptions.length)
                      return
                    }
                    if (event.key === 'Enter' || event.key === 'Tab') {
                      event.preventDefault()
                      chooseMention(mentionOptions[mentionIndex] || mentionOptions[0])
                      return
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      closeMentionMenu()
                      return
                    }
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    handleComposerSubmit(event)
                  }
                }}
                className="block min-h-[56px] w-full resize-none rounded-t-lg border-0 bg-transparent px-5 py-3 text-base leading-6 text-primary outline-none placeholder:text-tertiary disabled:opacity-60"
              />
              {nativeVoicePartial && (
                <div className="border-t border-subtle px-5 py-2 text-xs leading-5 text-accent-text">
                  {nativeVoicePartial}
                </div>
              )}
              {imageAttachments.length > 0 && (
                <div className="flex flex-wrap gap-2 border-t border-subtle px-4 py-3">
                  {imageAttachments.map(attachment => (
                    <div
                      key={attachment.id}
                      className="group relative h-16 w-16 overflow-hidden rounded-lg border border-subtle bg-surface-raised"
                      title={attachment.name}
                    >
                      {String(attachment.mimeType || '').startsWith('image/')
                        ? <img src={attachment.dataUrl} alt={attachment.name || '图片附件'} className="h-full w-full object-cover" />
                        : <span className="flex h-full items-center justify-center text-xs font-semibold text-accent">{conversationAttachmentTypeLabel(attachment.mimeType)}</span>}
                      <button
                        type="button"
                        onClick={() => removeImageAttachment(attachment.id)}
                        className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-md bg-scrim-strong text-xs leading-none text-white opacity-0 transition-opacity group-hover:opacity-100"
                        title="移除图片"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex h-11 items-center justify-between gap-3 border-t border-subtle px-4">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setAttachmentMenuOpen(open => !open)
                      setApprovalMenuOpen(false)
                      setModelMenuOpen(false)
                    }}
                    disabled={!activeTarget}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-2xl text-secondary transition-colors hover:bg-state-hover hover:text-primary disabled:opacity-40"
                    title="添加文件、Skills、连接器或网页搜索"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setApprovalMenuOpen(open => !open)
                      setModelMenuOpen(false)
                    }}
                    disabled={!activeEmployee}
                    className="inline-flex h-8 max-w-[170px] items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-accent-text transition-colors hover:bg-state-selected disabled:opacity-40"
                    title={activeApprovalMode.summary}
                  >
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-brand/50 text-2xs">✓</span>
                    <span className="truncate">{activeApprovalMode.label}</span>
                    <span className="text-xs text-accent-text">⌄</span>
                  </button>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setModelMenuOpen(open => !open)
                      setApprovalMenuOpen(false)
                    }}
                    disabled={!activeEmployee || !gatewayReady}
                    className="inline-flex h-8 max-w-[180px] items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-secondary transition-colors hover:bg-state-hover hover:text-primary disabled:opacity-40"
                    title={selectedModelOverride ? formatOpenClawModelLabel(selectedModelOverride) : '默认模型'}
                  >
                    <span className="shrink-0 text-base text-tertiary">⚡</span>
                    <span className="truncate">{modelChipLabel}</span>
                    <span className="shrink-0 text-xs text-tertiary">⌄</span>
                  </button>
                  <button
                    type="button"
                    onClick={toggleVoiceInput}
                    disabled={!activeTarget || turnInFlight || voiceProcessing}
                    className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${
                      voiceProcessing
                        ? 'animate-pulse bg-state-selected text-accent-text'
                        : voiceListening
                          ? 'bg-state-selected text-accent-text ring-1 ring-brand/40'
                          : 'bg-surface-overlay text-tertiary hover:bg-state-hover hover:text-primary'
                    }`}
                    title={voiceProcessing ? '正在识别语音…' : voiceListening ? '停止听写' : '语音输入'}
                    aria-label={voiceProcessing ? '正在识别语音…' : voiceListening ? '停止听写' : '语音输入'}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="h-[18px] w-[18px]"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <path d="M12 19v3" />
                      <path d="M8 22h8" />
                    </svg>
                  </button>
                  {turnInFlight ? (
                    <>
                      {activeEmployee && (input.trim() || imageAttachments.length > 0) && (
                        <button
                          type="submit"
                          disabled={activeQueuedMessages.length >= MAX_QUEUED_MESSAGES}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-default bg-surface-raised text-base font-medium text-primary transition-colors hover:bg-state-hover disabled:opacity-40"
                          title="加入队列（当前任务结束后发送）"
                        >
                          ⤵
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={handleStopConversation}
                        disabled={!activeStreamingMessage?.runId}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-default bg-state-hover text-sm font-medium text-primary transition-colors hover:bg-surface-raised disabled:opacity-40"
                        title="停止"
                      >
                        ■
                      </button>
                    </>
                  ) : (
                    <button
                      type="submit"
                      disabled={!activeTarget || !activeConversationRouteReady || activeQueuedMessages.length >= MAX_QUEUED_MESSAGES || (!input.trim() && imageAttachments.length === 0)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white text-xl font-medium text-[#171717] transition-colors hover:bg-stone-200 disabled:opacity-40"
                      title="发送"
                    >
                      ↑
                    </button>
                  )}
                </div>
              </div>
            </div>
          </form>
        </main>
        )}
      </section>

    </div>
  )
}
