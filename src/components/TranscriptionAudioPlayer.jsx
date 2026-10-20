import { useEffect, useRef, useState } from 'react'
import { SURFACE, TEXT } from '../lib/theme'
import { supabase } from '../lib/supabase'
import { formatRecordingClock } from '../lib/audioRecorder'
import { loadTranscriptionAudioUrl } from '../lib/voiceTranscription'

// 由录音转写生成的文档,顶部给一个原声回放。
//
// 懒加载:进文档不自动下音频(一小时的会议几十上百 MB),点了才拉。
// 拉下来转 blob: 播放 —— CSP 的 media-src 不含存储域名,签名 URL 不能直接进
// <audio src>,详见 loadTranscriptionAudioUrl 的注释。

export default function TranscriptionAudioPlayer({ jobId, className = '' }) {
  const [state, setState] = useState('idle') // idle | loading | ready | error
  const [audioUrl, setAudioUrl] = useState('')
  const [durationMs, setDurationMs] = useState(0)
  const [error, setError] = useState('')
  const objectUrlRef = useRef('')

  // 换文档或卸载时释放 blob,否则整段音频会一直留在内存里。
  useEffect(() => {
    return () => {
      if (objectUrlRef.current && typeof URL !== 'undefined' && URL.revokeObjectURL) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = ''
      }
    }
  }, [jobId])

  useEffect(() => {
    setState('idle')
    setAudioUrl('')
    setError('')
    setDurationMs(0)
  }, [jobId])

  async function load() {
    if (state === 'loading' || !jobId) return
    setState('loading')
    setError('')
    try {
      const result = await loadTranscriptionAudioUrl(supabase, jobId)
      objectUrlRef.current = result.objectUrl
      setAudioUrl(result.objectUrl)
      setDurationMs(result.durationMs)
      setState('ready')
    } catch (err) {
      setError(String(err?.message || err || '原录音加载失败'))
      setState('error')
    }
  }

  if (!jobId) return null

  if (state === 'ready') {
    return (
      <audio
        controls
        autoPlay
        src={audioUrl}
        className={`h-9 max-w-[280px] ${className}`}
        aria-label="原录音"
      />
    )
  }

  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      <button
        type="button"
        onClick={load}
        disabled={state === 'loading'}
        title={error || '播放原录音'}
        className={`${SURFACE.chip} inline-flex h-8 items-center gap-1.5 px-3 text-xs transition-colors hover:bg-state-hover disabled:opacity-50`}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
          <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.72-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14Z" />
        </svg>
        <span>{state === 'loading' ? '加载中…' : '原录音'}</span>
        {durationMs > 0 && <span className={TEXT.muted}>{formatRecordingClock(durationMs)}</span>}
      </button>
      {state === 'error' && (
        <span className="text-xs text-danger-text" title={error}>加载失败</span>
      )}
    </div>
  )
}
