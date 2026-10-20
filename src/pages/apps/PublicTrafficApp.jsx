/**
 * 公域流量三应用（字幕提取 / 公域获客 / 同行监听）—— 对齐小程序「应用 → 公域三卡」。
 *
 * 三个入口共用 socials 工作台和同一份平台选择，各自独立路由（/apps/public-traffic/:mode），
 * 与小程序「公域三应用拆分后详情页不再有模式切换 tab，模式由入口卡片决定」保持一致。
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Modal from '../../components/Modal'
import { AppPageHeader, EmptyState, Field, MessageBar, Toggle } from '../../components/AppsUI'
import { ACTION, FORM, LAYOUT, TEXT } from '../../lib/theme'
import {
  EMPTY_PUBLIC_TRAFFIC_FORM,
  PUBLIC_TRAFFIC_APPS,
  callSocials,
  decoratePublicTrafficTranscript,
  mapPublicTrafficAuthor,
  mapPublicTrafficLead,
  platformOptionsForMode,
  safeArray,
  splitLines,
  text,
} from '../../lib/appsBackend'

function ModeIcon() {
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.5" />
      <path strokeLinecap="round" d="M12 12l5.5-4.5" />
    </svg>
  )
}

export default function PublicTrafficApp() {
  const { mode: routeMode } = useParams()
  const navigate = useNavigate()
  const app = PUBLIC_TRAFFIC_APPS.find(item => item.mode === routeMode) || PUBLIC_TRAFFIC_APPS[0]
  const mode = app.mode

  const [form, setForm] = useState({ ...EMPTY_PUBLIC_TRAFFIC_FORM })
  const [settings, setSettings] = useState({})
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState('info')

  const [transcript, setTranscript] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [history, setHistory] = useState([])
  const [detail, setDetail] = useState(null)

  const [leadResult, setLeadResult] = useState(null)
  const [leads, setLeads] = useState([])

  const [authors, setAuthors] = useState([])
  const [addLog, setAddLog] = useState([])

  const modeRef = useRef(mode)
  modeRef.current = mode

  function notify(value, tone = 'info') {
    setMessage(value)
    setMessageTone(tone)
  }

  function setField(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  useEffect(() => {
    // 平台可选项按应用不同：从字幕提取（有 B 站）切到获客/监听时，选中的平台
    // 可能已经不在新列表里，必须复位，否则会带着一个非法值发请求
    if (!platformOptionsForMode(mode).some(item => item.value === form.platform)) {
      setField('platform', platformOptionsForMode(mode)[0].value)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  useEffect(() => {
    // 切换应用入口时把上一个应用的结果清干净，避免串台
    setMessage('')
    setTranscript(null)
    setAnalysis(null)
    setLeadResult(null)
    setLeads([])
    setAuthors([])
    setAddLog([])
    setHistoryOpen(false)
    setDetail(null)
    loadWorkspace()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, form.platform])

  async function loadWorkspace() {
    try {
      const result = await callSocials('socials_get_settings')
      setSettings(result || {})
      if (modeRef.current === 'leads') await loadLeads({ silent: true })
      if (modeRef.current === 'tracker') await loadAuthors({ silent: true })
    } catch {
      // 静默：进入页面时的预取失败不该先摆一条红字
    }
  }

  // ── 字幕提取 ──────────────────────────────

  async function extractTranscript() {
    const url = text(form.transcriptUrl)
    if (!url) {
      notify('请粘贴视频链接或分享文本', 'error')
      return
    }
    setLoading(true)
    notify('')
    setTranscript(null)
    setAnalysis(null)
    try {
      const result = await callSocials('socials_extract_xhs_transcript', {
        platform: form.platform,
        url,
        force_refresh: form.forceRefresh === true,
      })
      let analyzed = null
      try {
        analyzed = await callSocials('socials_analyze_transcript', { platform: form.platform, transcript: result })
      } catch { /* 摘要是锦上添花，失败不影响字幕本身 */ }
      setTranscript(result)
      setAnalysis(analyzed && analyzed.result ? analyzed.result : null)
      notify(result.cache_hit ? '已读取云端字幕缓存' : '字幕已提取并保存', 'success')
    } catch (error) {
      notify(error?.message || '字幕提取失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  async function loadHistory() {
    setHistoryLoading(true)
    try {
      const result = await callSocials('socials_list_transcript_history', { limit: 50 })
      const rows = Array.isArray(result) ? result : safeArray(result && result.transcripts)
      setHistory(rows.map(decoratePublicTrafficTranscript))
    } catch (error) {
      setHistory([])
      notify(error?.message || '读取提取历史失败', 'error')
    } finally {
      setHistoryLoading(false)
    }
  }

  function openHistory() {
    setHistoryOpen(true)
    setDetail(null)
    loadHistory()
  }

  // 提取完只在页面上留一张摘要卡，点它进同一个抽屉看全文
  function openTranscriptDetail() {
    if (!transcript) return
    const next = decoratePublicTrafficTranscript(transcript)
    if (analysis && analysis.summary) next.summary = text(analysis.summary)
    setHistoryOpen(true)
    setDetail(next)
  }

  function copyDetail() {
    const content = text(detail && detail.transcript)
    if (!content) return
    navigator.clipboard.writeText(content)
      .then(() => notify('已复制全文', 'success'))
      .catch(() => notify('复制失败', 'error'))
  }

  // ── 公域获客 ──────────────────────────────

  async function discoverLeads() {
    const keyword = text(form.leadKeyword)
    if (!keyword) {
      notify('请输入获客关键词', 'error')
      return
    }
    setLoading(true)
    notify('')
    setLeadResult(null)
    try {
      const result = await callSocials('socials_discover_leads', {
        platform: form.platform,
        keyword,
        note_limit: Number(form.noteLimit || 20),
        include_commenters: form.includeCommenters !== false,
      })
      await loadLeads({ silent: true, keyword })
      setLeadResult(result)
      notify(`已发现 ${result.new_leads || 0} 条线索`, 'success')
    } catch (error) {
      notify(error?.message || '获客发现失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  async function loadLeads(options = {}) {
    try {
      const keyword = options.keyword || text(form.leadKeyword)
      const result = await callSocials('socials_list_leads', {
        platform: form.platform,
        keyword: keyword || undefined,
        limit: 50,
      })
      setLeads(safeArray(result).map(mapPublicTrafficLead))
    } catch (error) {
      if (!options.silent) notify(error?.message || '线索列表加载失败', 'error')
    }
  }

  // ── 同行监听 ──────────────────────────────

  async function trackAuthors() {
    const urls = splitLines(form.trackerUrls)
    if (urls.length === 0) {
      notify('请至少粘贴一个主页或内容链接', 'error')
      return
    }
    setLoading(true)
    notify('')
    const log = []
    setAddLog([])
    for (const url of urls) {
      try {
        const author = await callSocials('socials_add_tracked_author', { platform: form.platform, url })
        log.push({ ok: true, title: author.nickname || author.external_user_id || '已添加', subtitle: url })
      } catch (error) {
        log.push({ ok: false, title: error?.message || '添加失败', subtitle: url })
      }
      setAddLog([...log])
    }
    await loadAuthors({ silent: true })
    setLoading(false)
    notify(`已添加 ${log.filter(item => item.ok).length}/${log.length} 个观察账号`, 'success')
    if (log.some(item => item.ok)) setField('trackerUrls', '')
  }

  async function loadAuthors(options = {}) {
    try {
      const result = await callSocials('socials_list_tracked_authors', { platform: form.platform })
      setAuthors(safeArray(result).map(mapPublicTrafficAuthor))
    } catch (error) {
      if (!options.silent) notify(error?.message || '监听列表加载失败', 'error')
    }
  }

  // ── 渲染 ──────────────────────────────

  return (
    <div className={`${LAYOUT.standard} min-h-full`}>
      <AppPageHeader
        title={app.title}
        subtitle={`${settings.provider_label || '云端 Socials'} · ${app.subtitle}`}
        icon={<ModeIcon />}
        actions={
          <>
            <select
              value={mode}
              onChange={event => navigate(`/apps/public-traffic/${event.target.value}`)}
              className={`${FORM.select} w-auto`}
            >
              {PUBLIC_TRAFFIC_APPS.map(item => (
                <option key={item.mode} value={item.mode}>{item.title}</option>
              ))}
            </select>
            {mode === 'transcript' ? (
              <button type="button" className={ACTION.secondary} onClick={openHistory}>提取历史</button>
            ) : null}
          </>
        }
      />

      <MessageBar message={message} tone={messageTone} onDismiss={() => notify('')} />

      <section className="ui-panel space-y-3 p-4">
        <Field label="平台">
          <select
            value={form.platform}
            onChange={event => setField('platform', event.target.value)}
            className={FORM.select}
          >
            {platformOptionsForMode(mode).map(item => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </Field>

        {mode === 'transcript' && (
          <>
            <Field label="视频链接">
              <textarea
                rows={3}
                value={form.transcriptUrl}
                onChange={event => setField('transcriptUrl', event.target.value)}
                placeholder="粘贴视频分享文本或完整 URL"
                className={FORM.textarea}
              />
            </Field>
            <Toggle
              label="强制重新提取"
              checked={form.forceRefresh}
              onChange={value => setField('forceRefresh', value)}
            />
            <button type="button" className={`${ACTION.primary} w-full`} disabled={loading} onClick={extractTranscript}>
              {loading ? '提取中…' : '提取字幕'}
            </button>
          </>
        )}

        {mode === 'leads' && (
          <>
            <Field label="关键词">
              <input
                value={form.leadKeyword}
                onChange={event => setField('leadKeyword', event.target.value)}
                placeholder="关键词，例如：一人公司 / AI 创业"
                className={FORM.input}
              />
            </Field>
            <Field label="扫描内容条数">
              <input
                type="number"
                value={form.noteLimit}
                onChange={event => setField('noteLimit', event.target.value)}
                className={FORM.input}
              />
            </Field>
            <Toggle
              label="包含互动用户"
              checked={form.includeCommenters}
              onChange={value => setField('includeCommenters', value)}
            />
            <button type="button" className={`${ACTION.primary} w-full`} disabled={loading} onClick={discoverLeads}>
              {loading ? '发现中…' : '开始发现'}
            </button>
          </>
        )}

        {mode === 'tracker' && (
          <>
            <Field label="账号 / 内容链接" hint="每行一个作者主页、作品链接或分享文本">
              <textarea
                rows={4}
                value={form.trackerUrls}
                onChange={event => setField('trackerUrls', event.target.value)}
                placeholder="每行一个作者主页、作品链接或分享文本"
                className={FORM.textarea}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={ACTION.primary} disabled={loading} onClick={trackAuthors}>
                {loading ? '添加中…' : '添加监听'}
              </button>
              <button type="button" className={ACTION.secondary} onClick={() => loadAuthors()}>刷新列表</button>
            </div>
          </>
        )}
      </section>

      {mode === 'transcript' && transcript ? (
        <button
          type="button"
          onClick={openTranscriptDetail}
          className="ui-panel w-full p-4 text-left transition-[background-color,border-color,box-shadow] duration-200 ease-out hover:border-strong hover:bg-state-hover"
        >
          <div className="text-sm font-medium text-primary">{transcript.title || '已提取字幕'}</div>
          <div className="mt-1 text-xs text-tertiary">
            {transcript.author || '未知作者'} · {transcript.char_count || 0} 字
          </div>
          <div className="mt-2 text-xs text-accent-text">查看全文 ›</div>
        </button>
      ) : null}

      {mode === 'leads' && (
        <>
          {leadResult ? (
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: '扫描', value: leadResult.notes_scanned || 0 },
                { label: '新增', value: leadResult.new_leads || 0 },
                { label: '总线索', value: leadResult.total_leads_after || 0 },
              ].map(stat => (
                <div key={stat.label} className="ui-panel p-4 text-center">
                  <div className="text-xl font-semibold text-primary">{stat.value}</div>
                  <div className="mt-1 text-xs text-tertiary">{stat.label}</div>
                </div>
              ))}
            </div>
          ) : null}
          {leads.length === 0 ? (
            <EmptyState>还没有线索，先输入关键词开始发现。</EmptyState>
          ) : (
            <div className="ui-panel divide-y divide-subtle">
              {leads.map(item => (
                <div key={item.id} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-primary">{item.title}</div>
                    <div className="mt-0.5 truncate text-xs text-tertiary">
                      {item.subtitle}{item.keyword ? ` · ${item.keyword}` : ''}
                    </div>
                  </div>
                  <div className="shrink-0 text-xs text-tertiary">{item.followerText}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {mode === 'tracker' && (
        <>
          {addLog.length > 0 ? (
            <div className="ui-panel divide-y divide-subtle">
              {addLog.map(item => (
                <div key={`${item.subtitle}-${item.title}`} className="p-3">
                  <div className={`text-sm font-medium ${item.ok ? 'text-success-text' : 'text-danger-text'}`}>
                    {item.ok ? '已添加' : '添加失败'}
                  </div>
                  <div className="mt-0.5 break-all text-xs text-tertiary">{item.title} · {item.subtitle}</div>
                </div>
              ))}
            </div>
          ) : null}
          {authors.length === 0 ? (
            <EmptyState>还没有监听的账号。</EmptyState>
          ) : (
            <div className="ui-panel divide-y divide-subtle">
              {authors.map(item => (
                <div key={item.id} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-primary">{item.title}</div>
                    <div className="mt-0.5 truncate text-xs text-tertiary">{item.subtitle}</div>
                  </div>
                  <div className="shrink-0 text-xs text-tertiary">{item.followerText}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <Modal
        open={historyOpen}
        onClose={() => { setHistoryOpen(false); setDetail(null) }}
        title={detail ? '字幕全文' : '提取历史'}
        size="2xl"
        footer={
          <div className="flex justify-end gap-2">
            {detail ? (
              <>
                <button type="button" className={ACTION.secondary} onClick={() => { setDetail(null); if (history.length === 0) loadHistory() }}>
                  返回列表
                </button>
                <button type="button" className={ACTION.primary} onClick={copyDetail}>复制全文</button>
              </>
            ) : (
              <button type="button" className={ACTION.secondary} onClick={() => setHistoryOpen(false)}>关闭</button>
            )}
          </div>
        }
      >
        {detail ? (
          <div className="space-y-3">
            <div className="text-base font-semibold text-primary">{detail.title || '未命名笔记'}</div>
            <div className="text-xs text-tertiary">
              {detail.author || '未知作者'} · {detail.char_count || 0} 字
              {detail.platformLabel ? ` · ${detail.platformLabel}` : ''}
            </div>
            {detail.summary ? (
              <div className="rounded-lg border border-subtle bg-surface-overlay p-3 text-sm text-secondary">
                {detail.summary}
              </div>
            ) : null}
            <pre className={`max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-subtle bg-surface-sunken p-3 text-sm ${TEXT.body}`}>
              {detail.transcript}
            </pre>
          </div>
        ) : historyLoading ? (
          <div className="py-8 text-center text-sm text-tertiary">正在读取历史…</div>
        ) : history.length === 0 ? (
          <EmptyState>还没有提取记录，提取过的字幕会存在这里。</EmptyState>
        ) : (
          <div className="divide-y divide-subtle">
            {history.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => setDetail(item)}
                className="flex w-full items-center justify-between gap-3 px-1 py-3 text-left transition-colors duration-[120ms] ease-out hover:bg-state-hover"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-primary">{item.title || '未命名笔记'}</div>
                  <div className="mt-0.5 truncate text-xs text-tertiary">
                    {item.author || '未知作者'} · {item.char_count || 0} 字 · {item.platformLabel}
                  </div>
                </div>
                <span className="shrink-0 text-tertiary">›</span>
              </button>
            ))}
          </div>
        )}
      </Modal>
    </div>
  )
}
