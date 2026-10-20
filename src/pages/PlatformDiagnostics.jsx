import { useEffect, useMemo, useState } from 'react'
import { ACTION, HEADING, LAYOUT, SURFACE, TEXT } from '../lib/theme'
import { callSupabaseFunction } from '../lib/supabase'

function dateLabel(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false })
}

export default function PlatformDiagnostics() {
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  async function loadReports() {
    setLoading(true)
    setError('')
    try {
      const rows = await callSupabaseFunction('admin', { action: 'admin_list_desktop_diagnostics' })
      setReports(Array.isArray(rows) ? rows : [])
    } catch (err) {
      setReports([])
      setError(String(err?.message || err || '读取桌面诊断记录失败；此页面仅平台管理员可访问。'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadReports() }, [])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return reports
    return reports.filter(report => [
      report.client_report_id,
      report.app_version,
      report.operating_system,
      report.failure_stage,
      report.failure_category,
    ].some(value => String(value || '').toLowerCase().includes(query)))
  }, [reports, search])

  return (
    <div className={LAYOUT.wide}>
      <section className={`${SURFACE.panel} p-5`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className={HEADING.page}>桌面端故障诊断</h1>
            <p className={`mt-2 max-w-3xl text-sm leading-6 ${TEXT.secondary}`}>
              仅平台管理员可读。这里展示用户确认发送的脱敏启动失败摘要；完整 Gateway 日志和错误原文不会上传。记录在 90 天后过期，并在打开此页面时清理。
            </p>
          </div>
          <button type="button" className={ACTION.secondary} onClick={loadReports} disabled={loading}>
            {loading ? '读取中...' : '刷新记录'}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            className="min-w-[240px] flex-1 rounded-lg border border-default bg-surface-overlay px-3 py-2 text-sm text-primary outline-none focus:border-accent"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="按报告 ID、版本、系统、阶段或类别筛选"
          />
          <span className={`text-xs ${TEXT.secondary}`}>{filtered.length} 条 / 最多显示最近 200 条</span>
        </div>
        {error && <div className="mt-4 rounded-xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-danger-text">{error}</div>}
        {loading ? (
          <div className={`mt-5 ${SURFACE.panelSoft} p-4 text-sm ${TEXT.secondary}`}>正在读取诊断记录...</div>
        ) : filtered.length === 0 ? (
          <div className={`mt-5 ${SURFACE.panelSoft} p-4 text-sm ${TEXT.secondary}`}>{error ? '无法读取记录。' : '暂无用户发送的诊断记录。'}</div>
        ) : (
          <div className={`mt-5 overflow-x-auto ${SURFACE.panelSoft}`}>
            <table className="w-full min-w-[900px] text-left text-xs">
              <thead className={`border-b border-subtle ${TEXT.secondary}`}>
                <tr>
                  <th className="px-3 py-3 font-medium">收到时间</th>
                  <th className="px-3 py-3 font-medium">上报方式</th>
                  <th className="px-3 py-3 font-medium">版本 / 系统</th>
                  <th className="px-3 py-3 font-medium">失败阶段</th>
                  <th className="px-3 py-3 font-medium">类别</th>
                  <th className="px-3 py-3 font-medium">耗时</th>
                  <th className="px-3 py-3 font-medium">报告 ID</th>
                  <th className="px-3 py-3 font-medium">阶段摘要</th>
                </tr>
              </thead>
              <tbody className={TEXT.secondary}>
                {filtered.map(report => (
                  <tr key={report.id} className="border-b border-subtle align-top last:border-0">
                    <td className="whitespace-nowrap px-3 py-3">{dateLabel(report.created_at)}</td>
                    <td className="px-3 py-3">{report.submission_mode === 'anonymous' ? '匿名' : '登录用户'}</td>
                    <td className="px-3 py-3">{report.app_version} · {report.operating_system}</td>
                    <td className="px-3 py-3">{report.failure_stage}</td>
                    <td className="px-3 py-3 font-medium text-primary">{report.failure_category}</td>
                    <td className="whitespace-nowrap px-3 py-3">{Number(report.duration_ms || 0).toLocaleString()} ms</td>
                    <td className="max-w-[220px] break-all px-3 py-3 font-mono">{report.client_report_id}</td>
                    <td className="px-3 py-3">
                      <details>
                        <summary className="cursor-pointer text-accent-text">{Array.isArray(report.event_summary) ? report.event_summary.length : 0} 个事件</summary>
                        <pre className="mt-2 max-h-48 max-w-[420px] overflow-auto whitespace-pre-wrap">{JSON.stringify(report.event_summary, null, 2)}</pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
