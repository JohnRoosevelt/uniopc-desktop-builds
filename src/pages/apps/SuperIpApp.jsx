/**
 * 超级IP —— 对齐小程序「应用 → 超级IP」。
 *
 * 三个 tab（头像 / 声音 / 作品）、两个账号 chip（HeyGen 头像 / MiniMax 声音）、
 * 创建与删除动作全部走 super-ip Edge Function 的同名 action。
 * 与小程序的唯一实现差别是选文件：这里用 <input type="file">，读成 base64 后
 * 走同一个 create_super_ip_avatar / create_voice 参数。
 */
import { useEffect, useRef, useState } from 'react'
import Modal from '../../components/Modal'
import { AppPageHeader, EmptyState, MessageBar, TabBar, InlineButton } from '../../components/AppsUI'
import { ACTION, LAYOUT, TEXT } from '../../lib/theme'
import {
  SUPER_IP_TABS,
  bytesToBase64,
  callSuperIp,
  decorateSuperIpAccount,
  hexToBytes,
  mapSuperIpAvatar,
  mapSuperIpSystemVoice,
  mapSuperIpVoice,
  mapSuperIpWork,
  safeArray,
  superIpFriendly,
  text,
} from '../../lib/appsBackend'

const MAX_VOICE_BYTES = 8 * 1024 * 1024

function AvatarIcon() {
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 9.5l4.5 2.5-4.5 2.5v-5z" />
    </svg>
  )
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return bytesToBase64(bytes)
}

function AccountChip({ label, account }) {
  return (
    <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${
      account.configured
        ? 'border-brand/30 bg-state-selected text-accent-text'
        : 'border-subtle bg-surface-overlay text-tertiary'
    }`}>
      <span className="font-medium">{label}</span>
      <span className="opacity-80">{account.providerLabel}</span>
    </div>
  )
}

export default function SuperIpApp() {
  const [tab, setTab] = useState('avatars')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState('info')
  const [account, setAccount] = useState(decorateSuperIpAccount(null))
  const [voiceAccount, setVoiceAccount] = useState(decorateSuperIpAccount(null))
  const [avatars, setAvatars] = useState([])
  const [voices, setVoices] = useState([])
  const [works, setWorks] = useState([])
  const [voiceConsent, setVoiceConsent] = useState(false)
  const [confirmState, setConfirmState] = useState(null)
  // 官方系统音色:上游列表,不落库。首次进「声音」tab 时按需拉,失败不影响本地音色。
  const [systemVoices, setSystemVoices] = useState([])
  const [systemLoading, setSystemLoading] = useState(false)
  const [systemLoaded, setSystemLoaded] = useState(false)
  // 复刻增强:校验文本(ASR 复核)+ 风格示例音频(<8 秒)
  const [cloneValidation, setCloneValidation] = useState('')
  const [stylePrompt, setStylePrompt] = useState(null)
  const [stylePromptText, setStylePromptText] = useState('')
  // 音色设计:一句话描述 + 试听文本
  const [designPrompt, setDesignPrompt] = useState('')
  const [designPreviewText, setDesignPreviewText] = useState('')

  const avatarInputRef = useRef(null)
  const voiceInputRef = useRef(null)
  const styleInputRef = useRef(null)
  const audioRef = useRef(null)
  const previewUrlRef = useRef('')

  function notify(value, tone = 'info') {
    setMessage(value)
    setMessageTone(tone)
  }

  useEffect(() => {
    loadWorkspace()
    return () => stopAudio()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (tab === 'voices' && voiceAccount.configured) loadSystemVoices(false, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, voiceAccount.configured])

  function stopAudio() {
    if (audioRef.current) {
      try {
        audioRef.current.pause()
      } catch { /* 播放器已被回收 */ }
      audioRef.current = null
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = ''
    }
  }

  // ownedUrl:本次播放自己 createObjectURL 出来的地址,由 stopAudio 负责回收。
  // 必须在 stopAudio 之后再记,否则会被同一次调用里的 revoke 抹掉 —— 那正是
  // hex 试听(官方音色、设计音色)一直放不出声的原因。
  function playAudio(src, ownedUrl = '') {
    stopAudio()
    previewUrlRef.current = ownedUrl
    const audio = new Audio(src)
    audioRef.current = audio
    audio.play().catch(() => notify('试听播放失败', 'error'))
  }

  function playHexAudio(hex) {
    const url = URL.createObjectURL(new Blob([hexToBytes(hex)], { type: 'audio/mpeg' }))
    playAudio(url, url)
  }

  async function loadWorkspace() {
    setLoading(true)
    try {
      const [accountResult, voiceResult] = await Promise.all([
        callSuperIp('get_account').catch(() => ({})),
        callSuperIp('get_voice_account').catch(() => ({})),
      ])
      setAccount(decorateSuperIpAccount(accountResult.account))
      setVoiceAccount(decorateSuperIpAccount(voiceResult.account))
      await Promise.all([loadAvatars(), loadVoices(), loadWorks()])
    } finally {
      setLoading(false)
    }
  }

  async function loadAvatars() {
    try {
      const result = await callSuperIp('list_super_ip_avatars')
      setAvatars(safeArray(result.avatars).map(mapSuperIpAvatar))
    } catch (error) {
      // 未开通 HeyGen 不是错误，只是还没有可列的头像
      if (error?.code === 'heygen_account_not_configured') setAvatars([])
      else notify(superIpFriendly(error, '加载头像失败'), 'error')
    }
  }

  async function loadVoices() {
    try {
      const result = await callSuperIp('list_voices')
      setVoices(safeArray(result.voices).map(mapSuperIpVoice))
    } catch (error) {
      if (error?.code === 'voice_account_not_configured') setVoices([])
      else notify(superIpFriendly(error, '加载声音失败'), 'error')
    }
  }

  async function loadWorks() {
    try {
      const result = await callSuperIp('list_works')
      setWorks(safeArray(result.works).map(mapSuperIpWork))
    } catch (error) {
      notify(superIpFriendly(error, '加载作品失败'), 'error')
    }
  }

  async function onAvatarPicked(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true)
    notify('')
    try {
      const contentType = file.type || (file.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg')
      const result = await callSuperIp('create_super_ip_avatar', {
        imageBase64: await fileToBase64(file),
        contentType,
      })
      setAvatars(prev => [mapSuperIpAvatar(result.avatar), ...prev])
      notify('头像已创建', 'success')
    } catch (error) {
      notify(superIpFriendly(error, '创建头像失败'), 'error')
    } finally {
      setBusy(false)
    }
  }

  // silent:进入 tab 时的自动加载。没开通声音服务的组织本来就拉不到,
  // 不该因为切了个 tab 就弹一条红字;手点「刷新」才需要看到失败原因。
  async function loadSystemVoices(force = false, silent = false) {
    if (systemLoading || (systemLoaded && !force)) return
    setSystemLoading(true)
    try {
      const result = await callSuperIp('list_system_voices')
      setSystemVoices(safeArray(result.voices).map(mapSuperIpSystemVoice))
      setSystemLoaded(true)
    } catch (error) {
      // 官方音色拉不到不影响自有音色
      if (!silent) notify(superIpFriendly(error, '加载官方音色失败'), 'error')
    } finally {
      setSystemLoading(false)
    }
  }

  function audioContentType(filename) {
    const lower = String(filename || '').toLowerCase()
    if (lower.endsWith('.wav')) return 'audio/wav'
    if (lower.endsWith('.m4a')) return 'audio/mp4'
    return 'audio/mpeg'
  }

  function onStylePicked(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_VOICE_BYTES) {
      notify('示例音频请控制在 8MB 以内', 'error')
      return
    }
    setStylePrompt(file)
  }

  async function onVoicePicked(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_VOICE_BYTES) {
      notify('音频请控制在 8MB 以内', 'error')
      return
    }
    setBusy(true)
    notify('')
    try {
      const filename = text(file.name) || 'sample.mp3'
      const payload = {
        audioBase64: await fileToBase64(file),
        filename,
        contentType: audioContentType(filename),
      }
      // 校验文本:上游会用 ASR 核对录音内容,对不上直接拒绝复刻,避免建出废音色
      if (text(cloneValidation)) payload.textValidation = text(cloneValidation)
      // 风格示例:必须音频和逐字文本成对给,少一个上游报错
      if (stylePrompt && text(stylePromptText)) {
        const styleName = text(stylePrompt.name) || 'prompt.mp3'
        payload.promptAudioBase64 = await fileToBase64(stylePrompt)
        payload.promptFilename = styleName
        payload.promptContentType = audioContentType(styleName)
        payload.promptText = text(stylePromptText)
      }
      const result = await callSuperIp('create_voice', payload)
      setVoices(prev => [mapSuperIpVoice(result.voice), ...prev])
      setVoiceConsent(false)
      setCloneValidation('')
      setStylePrompt(null)
      setStylePromptText('')
      notify('声音已克隆', 'success')
    } catch (error) {
      notify(superIpFriendly(error, '克隆声音失败'), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function submitVoiceDesign() {
    if (busy) return
    if (!text(designPrompt)) {
      notify('请先描述你想要的声音', 'error')
      return
    }
    setBusy(true)
    notify('')
    try {
      const result = await callSuperIp('design_voice', {
        prompt: text(designPrompt),
        previewText: text(designPreviewText),
      })
      setVoices(prev => [mapSuperIpVoice(result.voice), ...prev])
      setDesignPrompt('')
      setDesignPreviewText('')
      notify('音色已生成', 'success')
      // trial_audio 只在这次响应里回,不落库 —— 拿到就直接放,之后再听走 voice_preview
      if (result.trialAudioHex) playHexAudio(result.trialAudioHex)
    } catch (error) {
      notify(superIpFriendly(error, '生成音色失败'), 'error')
    } finally {
      setBusy(false)
    }
  }

  function requestVoiceUpload() {
    if (busy) return
    if (!voiceConsent) {
      notify('请先勾选：本人或已获授权的声音', 'error')
      return
    }
    voiceInputRef.current?.click()
  }

  async function previewVoice(voice) {
    if (voice.demoAudioUrl) {
      playAudio(voice.demoAudioUrl)
      return
    }
    notify('')
    try {
      const result = await callSuperIp('voice_preview', { voiceId: voice.voiceId })
      playHexAudio(result.audioHex)
    } catch (error) {
      notify(superIpFriendly(error, '试听失败'), 'error')
    }
  }

  function confirmThen(content, run) {
    setConfirmState({ content, run })
  }

  async function runConfirmed() {
    const action = confirmState
    setConfirmState(null)
    if (!action) return
    await action.run()
  }

  async function deleteAvatar(avatarId) {
    try {
      await callSuperIp('delete_super_ip_avatar', { avatarId })
      setAvatars(prev => prev.filter(item => item.avatarId !== avatarId))
    } catch (error) {
      notify(superIpFriendly(error, '删除头像失败'), 'error')
    }
  }

  async function deleteVoice(voiceId) {
    try {
      await callSuperIp('delete_voice', { voiceId })
      setVoices(prev => prev.filter(item => item.voiceId !== voiceId))
    } catch (error) {
      notify(superIpFriendly(error, '删除声音失败'), 'error')
    }
  }

  async function deleteWork(workId) {
    try {
      await callSuperIp('delete_work', { workId })
      setWorks(prev => prev.filter(item => item.id !== workId))
    } catch (error) {
      notify(superIpFriendly(error, '删除作品失败'), 'error')
    }
  }

  return (
    <div className={`${LAYOUT.standard} min-h-full`}>
      <AppPageHeader
        title="超级IP"
        subtitle="官方统一 HeyGen / MiniMax 服务，管理数字人、声音与视频作品"
        icon={<AvatarIcon />}
        actions={
          <button type="button" onClick={loadWorkspace} disabled={loading} className={ACTION.secondary}>
            {loading ? '刷新中' : '刷新'}
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <AccountChip label="HeyGen 头像" account={account} />
        <AccountChip label="MiniMax 声音" account={voiceAccount} />
      </div>

      <MessageBar message={message} tone={messageTone} onDismiss={() => notify('')} />

      <TabBar tabs={SUPER_IP_TABS.map(item => ({ key: item.key, label: item.label }))} active={tab} onChange={setTab} />

      <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={onAvatarPicked} />
      <input ref={voiceInputRef} type="file" accept=".mp3,.m4a,.wav,audio/*" className="hidden" onChange={onVoicePicked} />
      <input ref={styleInputRef} type="file" accept=".mp3,.m4a,.wav,audio/*" className="hidden" onChange={onStylePicked} />

      {tab === 'avatars' && (
        <section className="space-y-3">
          <button
            type="button"
            className={ACTION.primary}
            disabled={busy}
            onClick={() => !busy && avatarInputRef.current?.click()}
          >
            {busy ? '处理中…' : '上传照片，创建数字人'}
          </button>
          {avatars.length === 0 ? (
            <EmptyState>还没有数字人，上传一张正脸照片即可创建。</EmptyState>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {avatars.map(item => (
                <div key={item.id} className="ui-panel overflow-hidden">
                  {item.previewImageUrl ? (
                    <img src={item.previewImageUrl} alt={item.name} className="h-40 w-full object-cover" />
                  ) : (
                    <div className="flex h-40 w-full items-center justify-center bg-surface-sunken text-sm text-tertiary">
                      {item.name}
                    </div>
                  )}
                  <div className="flex items-start justify-between gap-2 p-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-primary">{item.name}</div>
                      <div className="mt-0.5 text-xs text-tertiary">{item.statusText} · {item.sourceText}</div>
                    </div>
                    <InlineButton
                      tone="danger"
                      onClick={() => confirmThen('确定删除该头像？', () => deleteAvatar(item.avatarId))}
                    >
                      删除
                    </InlineButton>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'voices' && (
        <section className="space-y-5">
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-primary">我的声音</h3>
            {voices.length === 0 ? (
              <EmptyState>还没有声音，可以克隆本人的声音，也可以用下面的「声音设计」凭描述生成。</EmptyState>
            ) : (
              <div className="ui-panel divide-y divide-subtle">
                {voices.map(item => (
                  <div key={item.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-primary">{item.name}</div>
                      <div className="mt-0.5 text-xs text-tertiary">
                        {item.statusText} · {item.sourceText}{item.language ? ` · ${item.language}` : ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {item.canPreview ? <InlineButton onClick={() => previewVoice(item)}>试听</InlineButton> : null}
                      <InlineButton
                        tone="danger"
                        onClick={() => confirmThen('确定删除该声音？', () => deleteVoice(item.voiceId))}
                      >
                        删除
                      </InlineButton>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-primary">官方音色</h3>
              <InlineButton onClick={() => loadSystemVoices(true)}>
                {systemLoading ? '加载中…' : systemLoaded ? '刷新' : '加载'}
              </InlineButton>
            </div>
            <p className={`text-xs ${TEXT.muted}`}>官方预置音色，可直接用于出片，不产生克隆费用。</p>
            {systemVoices.length === 0 ? (
              <EmptyState>{systemLoading ? '正在获取官方音色…' : '点右上角「加载」获取官方音色列表。'}</EmptyState>
            ) : (
              <div className="ui-panel divide-y divide-subtle">
                {systemVoices.map(item => (
                  <div key={item.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-primary">{item.name}</div>
                      <div className="mt-0.5 truncate text-xs text-tertiary">
                        {item.description || item.voiceId}
                      </div>
                    </div>
                    <InlineButton onClick={() => previewVoice(item)}>试听</InlineButton>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="ui-panel space-y-3 p-3">
            <h3 className="text-sm font-medium text-primary">克隆我的声音</h3>
            <p className={`text-xs ${TEXT.muted}`}>一段 10 秒 ~ 5 分钟的清晰人声即可，mp3 / m4a / wav。</p>
            <label className="flex items-center gap-2 text-sm text-secondary">
              <input
                type="checkbox"
                checked={voiceConsent}
                onChange={event => setVoiceConsent(event.target.checked)}
                className="h-4 w-4 rounded border-default accent-[var(--ui-brand)]"
              />
              本人或已获授权的声音
            </label>
            <div className="space-y-1">
              <label className="text-xs text-tertiary">校验文本（选填）</label>
              <input
                type="text"
                value={cloneValidation}
                onChange={event => setCloneValidation(event.target.value)}
                placeholder="录音里说的原话，填了会先核对内容再复刻，对不上直接拒绝"
                className="w-full rounded-lg border border-default bg-surface-overlay px-3 py-2 text-sm text-primary placeholder:text-tertiary"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-tertiary">风格示例音频（选填，8 秒以内）</label>
              <div className="flex items-center gap-2">
                <InlineButton onClick={() => styleInputRef.current?.click()}>
                  {stylePrompt ? '重新选择' : '选择示例音频'}
                </InlineButton>
                <span className="min-w-0 truncate text-xs text-tertiary">
                  {stylePrompt ? text(stylePrompt.name) : '决定"用什么语气说"，与复刻谁的音色分开'}
                </span>
              </div>
              <input
                type="text"
                value={stylePromptText}
                onChange={event => setStylePromptText(event.target.value)}
                placeholder="示例音频里逐字说的内容（与示例音频必须成对填写）"
                className="w-full rounded-lg border border-default bg-surface-overlay px-3 py-2 text-sm text-primary placeholder:text-tertiary"
              />
            </div>
            <button type="button" className={ACTION.primary} disabled={busy} onClick={requestVoiceUpload}>
              {busy ? '处理中…' : '选择音频，克隆声音'}
            </button>
          </div>

          <div className="ui-panel space-y-3 p-3">
            <h3 className="text-sm font-medium text-primary">声音设计</h3>
            <p className={`text-xs ${TEXT.muted}`}>不用录音，用一句话描述想要的声音直接生成，不收克隆费用。</p>
            <textarea
              rows={2}
              value={designPrompt}
              onChange={event => setDesignPrompt(event.target.value)}
              placeholder="例如：三十岁左右的女性播音腔，语速偏慢，声音温柔干净，适合知识分享口播"
              className="w-full rounded-lg border border-default bg-surface-overlay px-3 py-2 text-sm text-primary placeholder:text-tertiary"
            />
            <input
              type="text"
              value={designPreviewText}
              onChange={event => setDesignPreviewText(event.target.value)}
              placeholder="试听文本（选填，默认一句问候）"
              className="w-full rounded-lg border border-default bg-surface-overlay px-3 py-2 text-sm text-primary placeholder:text-tertiary"
            />
            <button type="button" className={ACTION.primary} disabled={busy} onClick={submitVoiceDesign}>
              {busy ? '处理中…' : '生成音色'}
            </button>
          </div>
        </section>
      )}

      {tab === 'works' && (
        <section className="space-y-3">
          <p className={`text-sm ${TEXT.muted}`}>AI 员工用超级IP生成的短视频会自动同步到这里。</p>
          {works.length === 0 ? (
            <EmptyState>还没有作品。</EmptyState>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {works.map(item => (
                <div key={item.id} className="ui-panel overflow-hidden">
                  {item.videoUrl ? (
                    <video src={item.videoUrl} controls className="h-48 w-full bg-surface-sunken object-cover" />
                  ) : (
                    <div className="flex h-48 w-full items-center justify-center bg-surface-sunken text-sm text-tertiary">
                      {item.statusText || '暂无视频'}
                    </div>
                  )}
                  <div className="flex items-start justify-between gap-2 p-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-primary">{item.title}</div>
                      <div className="mt-0.5 text-xs text-tertiary">
                        {item.durationText}{item.statusText ? ` · ${item.statusText}` : ''}
                      </div>
                    </div>
                    <InlineButton
                      tone="danger"
                      onClick={() => confirmThen('确定删除该作品？', () => deleteWork(item.id))}
                    >
                      删除
                    </InlineButton>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <Modal
        open={Boolean(confirmState)}
        onClose={() => setConfirmState(null)}
        title="提示"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className={ACTION.secondary} onClick={() => setConfirmState(null)}>取消</button>
            <button type="button" className={ACTION.danger} onClick={runConfirmed}>确定</button>
          </div>
        }
      >
        <p className="text-sm text-secondary">{confirmState?.content}</p>
      </Modal>
    </div>
  )
}
