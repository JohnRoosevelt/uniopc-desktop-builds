/**
 * 应用（创作广场）—— 对齐小程序 pages/admin 的「应用」tab。
 *
 * 小程序上这里是：行业热门选题跑马灯 + 应用卡（超级IP / 字幕提取 / 公域获客 /
 * 同行监听 / 私域转化）。桌面端在同一入口增加智能混剪，并把跑马灯换成
 * 可点复制的横向滚动条 —— PC 上鼠标能停住，不需要靠动画轮播来露出更多内容。
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { HEADING, LAYOUT, TEXT } from '../lib/theme'
import { PLAZA_TOPIC_ROWS } from '../lib/appsBackend'
import { MessageBar } from '../components/AppsUI'
import { AsyncActionState } from '../components/AsyncActionState'

function PlayIcon() {
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 9.5l4.5 2.5-4.5 2.5v-5z" />
    </svg>
  )
}

function SubtitleIcon() {
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path strokeLinecap="round" d="M6.5 14h4M12.5 14h5" />
      <path strokeLinecap="round" d="M6.5 10.5h11" />
    </svg>
  )
}

function GalleryIcon() {
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <circle cx="8.75" cy="9.75" r="1.25" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16.5l4.5-4 3.5 3 3-2.5 4 3.5" />
    </svg>
  )
}

function RadarIcon() {
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <path strokeLinecap="round" d="M12 12l5.5-4.5" />
    </svg>
  )
}

function StoreIcon() {
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 9.5V19a1 1 0 001 1h14a1 1 0 001-1V9.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 9.5l1.4-4.2A1 1 0 015.85 4.6h12.3a1 1 0 01.95.7l1.4 4.2a3 3 0 01-5.5 1.6 3 3 0 01-5 0 3 3 0 01-5.5-1.6z" />
    </svg>
  )
}

function MontageIcon() {
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 4.5v15M17 4.5v15M4 8h16M4 16h16" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m10 10 4 2-4 2v-4z" />
    </svg>
  )
}

// 原有应用入口与新增的智能混剪入口共用同一张应用广场。
const APPS = [
  {
    id: 'montage',
    title: '智能混剪',
    subtitle: '品牌文案 · 智能选片 · 异步出片',
    to: '/apps/montage',
    icon: <MontageIcon />,
  },
  {
    id: 'superIp',
    title: '超级IP',
    subtitle: '数字人 · 声音克隆 · 口播视频',
    to: '/apps/super-ip',
    icon: <PlayIcon />,
    featured: true,
  },
  {
    id: 'transcript',
    title: '字幕提取',
    subtitle: '视频链接一键提取可复用文案',
    to: '/apps/public-traffic/transcript',
    icon: <SubtitleIcon />,
  },
  {
    id: 'leads',
    title: '公域获客',
    subtitle: '从内容互动发现潜在客户',
    to: '/apps/public-traffic/leads',
    icon: <GalleryIcon />,
  },
  {
    id: 'tracker',
    title: '同行监听',
    subtitle: '持续关注同行账号动态',
    to: '/apps/public-traffic/tracker',
    icon: <RadarIcon />,
  },
  {
    id: 'privateConversion',
    title: '私域转化',
    subtitle: '短视频 · 文章 · 直播 · 微信小店',
    to: '/apps/private-conversion',
    icon: <StoreIcon />,
  },
]

export default function Apps() {
  const navigate = useNavigate()
  const [message, setMessage] = useState('')
  const [copyFailure, setCopyFailure] = useState(null)

  function copyTopic(topic) {
    navigator.clipboard.writeText(topic)
      .then(() => {
        setCopyFailure(null)
        setMessage(`已复制选题：${topic}`)
      })
      .catch(() => {
        setMessage('')
        setCopyFailure({ topic, detail: '复制失败，请手动选择文本' })
      })
  }

  return (
    <div className={`${LAYOUT.standard} min-h-full`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className={HEADING.page}>应用</h2>
          <p className={`mt-1 text-sm ${TEXT.secondary}`}>
            把内容生产、公域获客和私域转化拆成几件能独立开工的事，选一个进去就能干活。
          </p>
        </div>
      </div>

      <AsyncActionState
        state={copyFailure ? 'error' : null}
        title="复制选题失败"
        detail={copyFailure?.detail}
        onRetry={() => copyTopic(copyFailure.topic)}
        retryLabel="重试复制"
      >
        <MessageBar message={message} tone="success" onDismiss={() => setMessage('')} />

        <section className="ui-panel p-4">
          <div className="flex items-center gap-2">
            <span className="text-base">🔥</span>
            <h3 className={HEADING.subsection}>行业热门选题</h3>
            <span className="text-xs text-tertiary">点一下复制</span>
          </div>
          <div className="mt-3 space-y-2">
            {PLAZA_TOPIC_ROWS.map(row => (
              <div key={row.id} className="flex gap-2 overflow-x-auto pb-1">
                {row.topics.map(topic => (
                  <button
                    key={topic}
                    type="button"
                    onClick={() => copyTopic(topic)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-subtle bg-surface-overlay px-3 py-1.5 text-xs text-secondary transition-colors duration-[120ms] ease-out hover:border-strong hover:bg-state-hover hover:text-primary"
                  >
                    <span className="text-accent-text">✦</span>
                    {topic}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {APPS.map(app => (
            <button
              key={app.id}
              type="button"
              onClick={() => navigate(app.to)}
              className={`group flex items-center gap-3 rounded-xl border p-4 text-left transition-[background-color,border-color,box-shadow] duration-200 ease-out hover:border-strong hover:bg-state-hover hover:shadow-md ${
                app.featured
                  ? 'border-brand/30 bg-state-selected'
                  : 'border-subtle bg-surface-raised'
              }`}
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-subtle bg-surface-overlay text-accent-text">
                {app.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-primary">{app.title}</span>
                <span className="mt-0.5 block truncate text-xs text-tertiary">{app.subtitle}</span>
              </span>
              <svg className="h-4 w-4 shrink-0 text-tertiary transition-colors duration-[120ms] ease-out group-hover:text-primary" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="m9 5 7 7-7 7" />
              </svg>
            </button>
          ))}
        </section>
      </AsyncActionState>
    </div>
  )
}
