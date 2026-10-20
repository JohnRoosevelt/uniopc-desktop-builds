/**
 * 私域转化 —— 对齐小程序「应用 → 私域转化」。
 *
 * 结构与小程序一致：渠道列表 → 渠道详情（主页信息 / 短视频 / 微信小店 / 直播）
 * ＋ 发布视频、视频数据分析、视频解析、生成直播四个弹窗。
 * 互动数据（评论、直播弹幕、点赞收藏转发）不在这里造 —— 那是 AI 员工带私域插件的活，
 * 客户端只做内容发布和排播。
 * 所有写操作用的都是 private-conversion 的同名 operator_* action，所以两端行为等价。
 *
 * 桌面端的两处必要差异（能力边界，不是功能裁剪）：
 *   1. 上传走 Tauri HTTP，拿不到逐字节进度，改为「上传中」忙碌态 + 可取消；
 *   2. 「预览 / 分享」在小程序里是跳转观众端页面，桌面端没有观众端，改为复制主页短链。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import Modal from '../../components/Modal'
import { AppPageHeader, EmptyState, Field, MessageBar, TabBar, Toggle, InlineButton } from '../../components/AppsUI'
import { AsyncActionState } from '../../components/AsyncActionState'
import { ACTION, FORM, LAYOUT, TEXT } from '../../lib/theme'
import {
  CONTENT_MODES,
  EMPTY_ARTICLE_FORM,
  EMPTY_GENERATION_FORM,
  EMPTY_LIVE_FORM,
  EMPTY_PROFILE_FORM,
  EMPTY_VIDEO_FORM,
  UPLOAD_CANCELLED_MESSAGE,
  callMedia,
  callPrivateConversion,
  captureVideoThumbnail,
  channelSavePayload,
  dateTimeFromLiveForm,
  liveEndTimeFromForm,
  loadPostAnalytics,
  mapAnalyticsComment,
  mapAnalyticsInteraction,
  mapChannel,
  mapLiveSession,
  mapMediaAsset,
  mapPost,
  profileFormFromChannel,
  readVideoDuration,
  safeArray,
  splitTags,
  text,
  uploadOperatorAsset,
  countValue,
} from '../../lib/appsBackend'
import { getLatestParseByPost, parseVideo } from '../../lib/appsVideoParse'

const CONTENT_TABS = [
  { key: 'profileInfo', label: '主页信息' },
  { key: 'shortVideo', label: '短视频' },
  { key: 'article', label: '文章' },
  { key: 'wechatStore', label: '微信小店' },
  { key: 'liveVideo', label: '直播' },
]

const ANALYTICS_TABS = ['comments', 'likes', 'favorites', 'shares']

function StoreIcon() {
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 9.5V19a1 1 0 001 1h14a1 1 0 001-1V9.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 9.5l1.4-4.2A1 1 0 015.85 4.6h12.3a1 1 0 01.95.7l1.4 4.2a3 3 0 01-5.5 1.6 3 3 0 01-5 0 3 3 0 01-5.5-1.6z" />
    </svg>
  )
}

function VideoTile({ post, active, actions, onSelect }) {
  return (
    <div
      className={`group overflow-hidden rounded-xl border transition-[background-color,border-color,box-shadow] duration-200 ease-out ${
        active ? 'border-brand/40 bg-state-selected' : 'border-subtle bg-surface-raised hover:border-strong'
      }`}
    >
      <button type="button" onClick={onSelect} className="block w-full text-left">
        <div className="relative h-40 w-full bg-surface-sunken">
          {post.coverUrl ? (
            <img src={post.coverUrl} alt={post.title} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-tertiary">无封面</div>
          )}
          <span className="absolute left-2 top-2 rounded-full border border-subtle bg-surface-float/90 px-2 py-0.5 text-[11px] text-secondary">
            {post.kindLabel}
          </span>
        </div>
        <div className="p-3">
          <div className="truncate text-sm font-medium text-primary">{post.title}</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-tertiary">
            <span className="rounded-full bg-surface-overlay px-2 py-0.5">赞 {post.likes}</span>
            <span className="rounded-full bg-surface-overlay px-2 py-0.5">评 {post.comments}</span>
            <span className="rounded-full bg-surface-overlay px-2 py-0.5">藏 {post.favorites}</span>
            <span className="rounded-full bg-surface-overlay px-2 py-0.5">转 {post.shares}</span>
          </div>
        </div>
      </button>
      <div className="flex flex-wrap gap-1.5 border-t border-subtle px-3 py-2">{actions}</div>
    </div>
  )
}

function QrCodeButton({ target, loading, onOpen }) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className={ACTION.secondary}
        disabled={loading}
        onClick={() => onOpen(target)}
      >
        {loading ? '生成中…' : '生成二维码'}
      </button>
    </div>
  )
}

function WechatBindingQrModal({ open, onClose, qrCodeDataUrl, expiresAt }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="微信绑定二维码"
      description="正式版 · 使用 Uniopc 小程序扫码后，将该微信身份绑定到当前组织。二维码仅可使用一次，5 分钟后失效。"
      size="sm"
      footer={
        <div className="flex justify-end">
          <button type="button" className={ACTION.secondary} onClick={onClose}>关闭</button>
        </div>
      }
    >
      <div className="space-y-3 text-center">
        {qrCodeDataUrl ? (
          <img src={qrCodeDataUrl} alt="微信组织绑定二维码" className="mx-auto h-64 w-64 rounded-lg border border-subtle bg-white p-2" />
        ) : null}
        {expiresAt ? <p className="text-xs text-tertiary">失效时间：{new Date(expiresAt).toLocaleString('zh-CN', { hour12: false })}</p> : null}
      </div>
    </Modal>
  )
}

export default function PrivateConversionApp() {
  const { channelId = '' } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  const contentMode = CONTENT_MODES.includes(searchParams.get('tab')) ? searchParams.get('tab') : 'profileInfo'

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [errorRetry, setErrorRetry] = useState(null)
  // 发布弹窗在 Modal（z-50）内；不能复用页面级错误条，否则错误会被遮罩盖住。
  const [publishError, setPublishError] = useState('')
  const [publishErrorRetry, setPublishErrorRetry] = useState(null)
  const [notice, setNotice] = useState('')

  const clearError = useCallback(() => {
    setError('')
    setErrorRetry(null)
  }, [])

  const showError = useCallback((detail, retry = null) => {
    setError(detail)
    setErrorRetry(() => retry)
  }, [])

  const clearPublishError = useCallback(() => {
    setPublishError('')
    setPublishErrorRetry(null)
  }, [])

  const showPublishError = useCallback((detail, retry = null) => {
    setPublishError(detail)
    setPublishErrorRetry(() => retry)
  }, [])

  const [channels, setChannels] = useState([])
  const [liveSessions, setLiveSessions] = useState([])
  const [posts, setPosts] = useState([])
  const [mediaAssets, setMediaAssets] = useState([])

  const [editorMode, setEditorMode] = useState('') // '' | 'create' | 'edit'
  const [profileForm, setProfileForm] = useState({ ...EMPTY_PROFILE_FORM })

  const [publishOpen, setPublishOpen] = useState(false)
  const [publishChannelId, setPublishChannelId] = useState('')
  const [videoForm, setVideoForm] = useState({ ...EMPTY_VIDEO_FORM })
  const [articleOpen, setArticleOpen] = useState(false)
  const [articleForm, setArticleForm] = useState({ ...EMPTY_ARTICLE_FORM })
  const [uploadTarget, setUploadTarget] = useState('')
  const uploadAbortRef = useRef(null)
  const profileImageInputRef = useRef(null)
  const profileImageTargetRef = useRef('')
  const videoFileInputRef = useRef(null)
  const videoCoverInputRef = useRef(null)

  // 只剩「当前正在运营的那条短视频」：卡片高亮和默认选中读它。互动数据（评论、弹幕、
  // 点赞收藏转发）一律由 AI 员工带私域插件生成，应用页不再提供入口。
  const [generationForm, setGenerationForm] = useState({ ...EMPTY_GENERATION_FORM })

  const [liveForm, setLiveForm] = useState({ ...EMPTY_LIVE_FORM })
  const [liveOpen, setLiveOpen] = useState(false)

  const [moreActionsPost, setMoreActionsPost] = useState(null)
  const [previewPost, setPreviewPost] = useState(null)
  const [qrTarget, setQrTarget] = useState(null)
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('')
  const [qrOpen, setQrOpen] = useState(false)
  const [qrLoading, setQrLoading] = useState(false)
  const [qrError, setQrError] = useState('')
  const qrRequestRef = useRef(false)
  const [wechatBindingQrOpen, setWechatBindingQrOpen] = useState(false)
  const [qrBindingCodeDataUrl, setQrBindingCodeDataUrl] = useState('')
  const [wechatBindingExpiresAt, setWechatBindingExpiresAt] = useState('')
  const [wechatBindingLoading, setWechatBindingLoading] = useState(false)

  const [analytics, setAnalytics] = useState(null)
  const [analyticsOpen, setAnalyticsOpen] = useState(false)
  const [analyticsTab, setAnalyticsTab] = useState('comments')
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsError, setAnalyticsError] = useState('')

  const [parseOpen, setParseOpen] = useState(false)
  const [parseLoading, setParseLoading] = useState(false)
  const [parsePost, setParsePost] = useState(null)
  const [parseStatusText, setParseStatusText] = useState('')
  const [parseError, setParseError] = useState('')
  const [parseRetry, setParseRetry] = useState(null)
  const [parseRetryLabel, setParseRetryLabel] = useState('重试')
  const [parseTranscript, setParseTranscript] = useState('')
  const [parseFragments, setParseFragments] = useState([])
  const parseSeqRef = useRef(0)

  const selectedChannel = useMemo(
    () => channels.find(item => item.id === channelId) || null,
    [channels, channelId],
  )
  const shortVideoPosts = useMemo(() => posts.filter(post => post.videoKind === 'shortVideo'), [posts])
  const liveVideoPosts = useMemo(() => posts.filter(post => post.videoKind === 'liveVideo'), [posts])
  const articlePosts = useMemo(() => posts.filter(post => post.postType === 'article'), [posts])
  const channelLiveSessions = useMemo(
    () => liveSessions.filter(item => item.channelId === channelId),
    [liveSessions, channelId],
  )

  // ── 数据加载 ──────────────────────────────

  const loadWorkspace = useCallback(async () => {
    setLoading(true)
    clearError()
    try {
      const [channelResult, liveResult] = await Promise.all([
        callPrivateConversion('operator_list_org_channels', { channelType: 'video' }),
        callPrivateConversion('operator_list_live_sessions'),
      ])
      const mapped = safeArray(channelResult?.channels).map(mapChannel).filter(item => item.type === 'video')
      setChannels(mapped)
      setLiveSessions(safeArray(liveResult.liveSessions || liveResult.live_sessions).map(session => ({
        ...mapLiveSession(session),
        channelId: session.channelId || session.channel_id || '',
      })))
      return mapped
    } catch (loadError) {
      showError(loadError?.message || '加载工作台失败', loadWorkspace)
      return []
    } finally {
      setLoading(false)
    }
  }, [clearError, showError])

  const loadChannelData = useCallback(async id => {
    if (!id) return
    clearError()
    try {
      const [postResult, assetResult] = await Promise.all([
        callPrivateConversion('operator_list_posts', { channelId: id }),
        // 素材列表走 media：OSS 行会在这里顺带续签 public_url，走单体则拿到的是过期地址。
        callMedia('operator_list_media_assets', { assetType: 'video' }),
      ])
      setPosts(safeArray(postResult.posts).map(mapPost))
      setMediaAssets(safeArray(assetResult.mediaAssets || assetResult.media_assets).map(mapMediaAsset))
    } catch (loadError) {
      showError(loadError?.message || '加载运营数据失败', () => loadChannelData(id))
    }
  }, [clearError, showError])

  useEffect(() => {
    loadWorkspace()
  }, [loadWorkspace])

  useEffect(() => {
    setEditorMode('')
    setPosts([])
    setMediaAssets([])
    setGenerationForm({ ...EMPTY_GENERATION_FORM })
    setLiveForm({ ...EMPTY_LIVE_FORM })
    clearError()
    if (channelId) loadChannelData(channelId)
  }, [channelId, clearError, loadChannelData])

  useEffect(() => {
    if (selectedChannel) setProfileForm(profileFormFromChannel(selectedChannel))
  }, [selectedChannel])

  // 直播素材必须跟着来源视频走：默认选中该渠道的第一条直播视频，
  // 而不是「全组织最近上传的任意素材」——后端 media 优先于 post，选错就会播成另一条片子。
  useEffect(() => {
    if (liveVideoPosts.length === 0) return
    setLiveForm(prev => {
      if (prev.sourcePostId) return prev
      const post = liveVideoPosts[0]
      const asset = mediaAssets.find(item => item.id === post.mediaAssetId) || {}
      return {
        ...prev,
        sourcePostId: post.id,
        mediaAssetId: post.mediaAssetId || '',
        openingVideoUrl: post.videoUrl || '',
        durationSeconds: asset.durationSeconds || 0,
      }
    })
  }, [liveVideoPosts, mediaAssets])

  useEffect(() => {
    if (!generationForm.postId && shortVideoPosts[0]) {
      setGenerationForm(prev => ({ ...prev, postId: shortVideoPosts[0].id }))
    }
  }, [shortVideoPosts, generationForm.postId])

  function setContentMode(mode) {
    setSearchParams({ tab: mode }, { replace: true })
    clearError()
  }

  function setProfileField(field, value) {
    setProfileForm(prev => ({ ...prev, [field]: value }))
  }

  function setVideoField(field, value) {
    setVideoForm(prev => ({ ...prev, [field]: value }))
  }

  function setLiveField(field, value) {
    setLiveForm(prev => ({ ...prev, [field]: value }))
  }

  function setGenerationField(field, value) {
    setGenerationForm(prev => ({ ...prev, [field]: value }))
  }

  function findPost(postId) {
    return posts.find(item => item.id === postId) || null
  }

  // ── 渠道 CRUD ──────────────────────────────

  function openCreateChannel() {
    setProfileForm({
      ...EMPTY_PROFILE_FORM,
      slug: `video-${Date.now().toString(36)}`,
    })
    setEditorMode('create')
    clearError()
  }

  function openEditChannel() {
    if (!selectedChannel) return
    setProfileForm(profileFormFromChannel(selectedChannel))
    setEditorMode('edit')
    clearError()
  }

  async function saveProfileForm() {
    if (saving) return
    if (!text(profileForm.displayName)) {
      showError('请填写账号主页名称')
      return
    }
    const isCreate = editorMode === 'create' || !channelId
    setSaving(true)
    clearError()
    try {
      const payload = channelSavePayload(profileForm)
      let nextChannelId = channelId
      if (!isCreate) {
        await callPrivateConversion('operator_update_org_channel', { ...payload, id: channelId })
      } else {
        const result = await callPrivateConversion('operator_create_org_channel', payload)
        const created = result.channel || result.Channel || {}
        if (created.id) nextChannelId = created.id
      }
      setNotice(isCreate ? '渠道已创建' : '主页已保存')
      const nextChannels = await loadWorkspace()
      setEditorMode('')
      const channel = nextChannels.find(item => item.id === nextChannelId)
      if (!channel) {
        navigate('/apps/private-conversion')
        return
      }
      // 新建和编辑都落到这个渠道的详情页，接着就能发视频、配小店
      navigate(`/apps/private-conversion/${channel.id}?tab=${isCreate ? 'profileInfo' : contentMode}`)
    } catch (saveError) {
      showError(
        saveError?.message || (isCreate ? '创建渠道失败' : '保存主页失败'),
        saveProfileForm,
      )
    } finally {
      setSaving(false)
    }
  }

  async function saveWechatStoreBinding() {
    if (!channelId) {
      showError('请先创建或选择一个私域视频号频道')
      return
    }
    if (profileForm.showWechatStoreWindow && !text(profileForm.wechatStoreAppId)) {
      showError('开启商品橱窗前，请填写本组织微信小店 appid')
      return
    }
    setSaving(true)
    clearError()
    try {
      await callPrivateConversion('operator_update_channel', {
        ...channelSavePayload(profileForm),
        id: channelId,
      })
      setNotice('小店绑定已保存')
      await loadWorkspace()
    } catch (saveError) {
      const message = saveError?.message || '保存微信小店绑定失败'
      if (/duplicate|unique|wechat_store_already/i.test(message)) {
        showError('这个微信小店已绑定到其他私域频道')
      } else {
        showError(message, saveWechatStoreBinding)
      }
    } finally {
      setSaving(false)
    }
  }

  // ── 素材上传 ──────────────────────────────

  async function uploadAsset(file, target) {
    const assetKind = target === 'videoFile' ? 'video' : target === 'avatarUrl' ? 'avatar' : 'cover'
    const controller = new AbortController()
    uploadAbortRef.current = controller
    setUploadTarget(target)
    if (publishOpen && (target === 'videoFile' || target === 'videoCover')) clearPublishError()
    else clearError()
    try {
      // 直播排播要用素材时长算结束时间，视频必须带上；封面/头像没有时长。
      let durationSeconds = 0
      if (target === 'videoFile') {
        durationSeconds = await readVideoDuration(file)
        setVideoField('durationSeconds', durationSeconds)
      }
      const result = await uploadOperatorAsset({ file, assetKind, signal: controller.signal, durationSeconds })
      if (target === 'avatarUrl') setProfileField('avatarUrl', result.publicUrl)
      if (target === 'coverUrl') setProfileField('coverUrl', result.publicUrl)
      if (target === 'videoCover') setVideoField('coverUrl', result.publicUrl)
      if (target === 'videoFile') {
        setVideoForm(prev => ({ ...prev, videoUrl: result.publicUrl, mediaAssetId: result.mediaAssetId }))
        await autoFillCoverFromVideo(file, controller)
      }
      return result.publicUrl
    } catch (uploadError) {
      if (uploadError?.message === UPLOAD_CANCELLED_MESSAGE) {
        if (publishOpen && (target === 'videoFile' || target === 'videoCover')) clearPublishError()
        else clearError()
        return ''
      }
      const detail = `上传失败：${uploadError?.message || '未知错误'}`
      const retry = () => uploadAsset(file, target)
      if (publishOpen && (target === 'videoFile' || target === 'videoCover')) showPublishError(detail, retry)
      else showError(detail, retry)
      return ''
    } finally {
      uploadAbortRef.current = null
      setUploadTarget('')
    }
  }

  /**
   * 视频传完后自动截首帧当封面。
   *
   * 不设封面时，后端会兜底把视频地址当封面发给前端，卡片再把 mp4 塞进 <img> ——
   * 显示得出来，但要为一张缩略图下载整个视频（实测 157MB）。所以这里在发布前就把
   * 封面补上。用户已经自己选了封面就不动，自动的只是兜底不是覆盖。
   *
   * 整段包在 try 里且不改 error 状态：截帧失败最多是没有封面，不能让视频白传一次。
   */
  async function autoFillCoverFromVideo(file, controller) {
    if (videoForm.coverUrl) return
    try {
      const cover = await captureVideoThumbnail(file)
      if (!cover || controller.signal.aborted) return
      const result = await uploadOperatorAsset({
        file: cover,
        assetKind: 'cover',
        signal: controller.signal,
      })
      // 截帧+上传期间用户可能自己选了封面，用函数式更新再判一次，别把人家选的盖掉。
      if (result.publicUrl) {
        setVideoForm(prev => (prev.coverUrl ? prev : { ...prev, coverUrl: result.publicUrl }))
      }
    } catch {
      // 没有封面照样能发布，不打断也不报错。
    }
  }

  function pickProfileImage(target) {
    profileImageTargetRef.current = target
    const input = profileImageInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }

  function onProfileImagePicked(event) {
    const file = event.target.files?.[0]
    const target = profileImageTargetRef.current
    event.target.value = ''
    if (file && (target === 'avatarUrl' || target === 'coverUrl')) {
      uploadAsset(file, target)
    }
  }

  function pickVideoFile() {
    const input = videoFileInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }

  function onVideoFilePicked(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setVideoForm(prev => ({ ...prev, localVideoUrl: URL.createObjectURL(file), videoUrl: '', mediaAssetId: '' }))
    uploadAsset(file, 'videoFile')
  }

  function pickVideoCover() {
    const input = videoCoverInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }

  function onVideoCoverPicked(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) uploadAsset(file, 'videoCover')
  }

  function cancelActiveUpload() {
    const controller = uploadAbortRef.current
    if (!controller) return
    uploadAbortRef.current = null
    controller.abort()
  }

  // ── 发布视频 ──────────────────────────────

  function openPublish() {
    setPublishChannelId(channelId || channels[0]?.id || '')
    setVideoForm(prev => ({
      ...EMPTY_VIDEO_FORM,
      videoKind: contentMode === 'liveVideo' ? 'liveVideo' : 'shortVideo',
      // 上一次没发出去的本地预览留着，和小程序一样可以接着发
      localVideoUrl: prev.videoUrl ? '' : prev.localVideoUrl,
      videoUrl: prev.videoUrl,
      mediaAssetId: prev.mediaAssetId,
      coverUrl: prev.coverUrl,
    }))
    clearError()
    clearPublishError()
    setPublishOpen(true)
  }

  function closePublish() {
    // 关掉弹窗还让上传在后台跑没有意义：用户已经放弃这条视频了
    cancelActiveUpload()
    clearPublishError()
    setPublishOpen(false)
  }

  async function publishVideo() {
    if (saving || uploadTarget === 'videoFile') return
    const targetChannelId = text(publishChannelId) || text(channelId)
    if (!targetChannelId) {
      showPublishError('请先选择发布渠道')
      return
    }
    if (!text(videoForm.title)) {
      showPublishError('请填写视频标题')
      return
    }
    if (!text(videoForm.videoUrl)) {
      showPublishError('请先选择视频')
      return
    }
    setSaving(true)
    clearPublishError()
    try {
      const videoKind = videoForm.videoKind || 'shortVideo'
      const tags = splitTags(videoForm.tagsText)
      await callPrivateConversion('operator_create_post', {
        channelId: targetChannelId,
        postType: 'video',
        title: videoForm.title,
        description: videoForm.description,
        coverUrl: videoForm.coverUrl,
        mediaAssetId: videoForm.mediaAssetId,
        videoKind,
        tags,
        status: 'published',
        contentPayload: {
          video: videoForm.videoUrl,
          cover: videoForm.coverUrl,
          videoKind,
          video_kind: videoKind,
          tags,
        },
      })
      setNotice('视频已发布')
      setVideoForm({ ...EMPTY_VIDEO_FORM, videoKind })
      setPublishOpen(false)
      if (targetChannelId === channelId) setContentMode(videoKind)
      await loadChannelData(targetChannelId)
      await loadWorkspace()
    } catch (publishError) {
      showPublishError(publishError?.message || '发布视频失败', publishVideo)
    } finally {
      setSaving(false)
    }
  }

  // ── 发布文章 ──────────────────────────────

  function openPublishArticle(article = null) {
    setArticleForm(article ? {
      id: article.id,
      title: article.title,
      description: article.description,
      coverUrl: article.coverUrl,
      tagsText: safeArray(article.tags).join(' '),
      articleBlocks: safeArray(article.articleBlocks).length ? article.articleBlocks : [{ type: 'paragraph', text: '' }],
    } : { ...EMPTY_ARTICLE_FORM, articleBlocks: [{ type: 'paragraph', text: '' }] })
    clearError()
    setArticleOpen(true)
  }

  function setArticleField(field, value) {
    setArticleForm(prev => ({ ...prev, [field]: value }))
  }

  function setArticleBlock(index, field, value) {
    setArticleForm(prev => ({
      ...prev,
      articleBlocks: prev.articleBlocks.map((block, blockIndex) => blockIndex === index ? { ...block, [field]: value } : block),
    }))
  }

  function addArticleBlock() {
    setArticleForm(prev => ({ ...prev, articleBlocks: [...prev.articleBlocks, { type: 'paragraph', text: '' }] }))
  }

  function removeArticleBlock(index) {
    setArticleForm(prev => ({ ...prev, articleBlocks: prev.articleBlocks.filter((_, blockIndex) => blockIndex !== index) }))
  }

  function normalizedArticleBlocks() {
    return articleForm.articleBlocks.map(block => ({
      type: text(block.type) || 'paragraph',
      ...(block.type === 'image' ? { url: text(block.url) } : { text: text(block.text) }),
      ...(text(block.caption) ? { caption: text(block.caption) } : {}),
    })).filter(block => block.type === 'image' ? Boolean(block.url) : Boolean(block.text))
  }

  async function publishArticle() {
    if (saving) return
    if (!channelId) {
      showError('请先选择视频号频道')
      return
    }
    if (!text(articleForm.title)) {
      showError('请填写文章标题')
      return
    }
    const articleBlocks = normalizedArticleBlocks()
    if (articleBlocks.length === 0) {
      showError('请至少填写一个正文块')
      return
    }
    setSaving(true)
    clearError()
    try {
      const result = await callPrivateConversion('operator_publish_article', {
        ...(articleForm.id ? { id: articleForm.id } : {}),
        channelId,
        title: text(articleForm.title),
        description: text(articleForm.description),
        coverUrl: text(articleForm.coverUrl),
        tags: splitTags(articleForm.tagsText),
        contentPayload: { articleBlocks },
      })
      const saved = result.post || result.article || {}
      if ((saved.post_type || saved.postType) !== 'article') throw new Error('article_publish_verification_failed')
      await loadChannelData(channelId)
      setNotice('文章已发布')
      setArticleOpen(false)
      setContentMode('article')
    } catch (publishError) {
      showError(
        publishError?.message === 'article_publish_verification_failed'
          ? '发布结果不是文章，已停止提示成功'
          : publishError?.message || '发布文章失败',
        publishArticle,
      )
    } finally {
      setSaving(false)
    }
  }

  // ── 生成直播 ──────────────────────────────

  // 直播播的就是这条来源视频，素材/时长/暖场片全部从它派生，不给第二个可以选错的入口。
  function selectPostForLive(post) {
    if (!post) return
    const asset = mediaAssets.find(item => item.id === post.mediaAssetId) || {}
    setLiveForm(prev => ({
      ...prev,
      sourcePostId: post.id,
      title: prev.title || `${post.title} 直播`,
      mediaAssetId: post.mediaAssetId || '',
      openingVideoUrl: post.videoUrl || '',
      durationSeconds: asset.durationSeconds || 0,
    }))
  }

  function openLive(post) {
    if (!post) return
    selectPostForLive(post)
    setMoreActionsPost(null)
    setLiveOpen(true)
  }

  async function scheduleLive() {
    if (!channelId) return
    if (!text(liveForm.title)) {
      showError('请填写直播标题')
      return
    }
    if (!text(liveForm.sourcePostId)) {
      showError('请选择直播视频')
      return
    }
    // 素材不再单独选，只校验所选来源视频本身能播——它就是直播要放的那条片子
    const livePost = liveVideoPosts.find(item => item.id === text(liveForm.sourcePostId)) || {}
    if (!text(livePost.mediaAssetId) && !text(livePost.videoUrl)) {
      showError('所选直播视频还没有可播放的文件，请重新发布这条视频')
      return
    }
    const scheduledStartAt = dateTimeFromLiveForm(liveForm)
    if (!scheduledStartAt) {
      showError('请选择开播日期和时间')
      return
    }
    setSaving(true)
    clearError()
    try {
      await callPrivateConversion('operator_schedule_live_session', {
        channelId,
        title: liveForm.title,
        slug: liveForm.slug,
        sourcePostId: liveForm.sourcePostId,
        // 后端会按 sourcePostId 重新派生素材，这里传的是同一条，只为让请求自解释
        mediaAssetId: livePost.mediaAssetId || '',
        scheduledStartAt,
        scheduledEndAt: liveEndTimeFromForm(liveForm, scheduledStartAt),
        passwordEnabled: liveForm.passwordEnabled,
        password: liveForm.password,
        roomPayload: {
          openingVideo: livePost.videoUrl || '',
          passwordEnabled: liveForm.passwordEnabled,
          durationSeconds: Number(liveForm.durationSeconds || 0),
        },
      })
      setNotice('直播已生成')
      setLiveForm({ ...EMPTY_LIVE_FORM })
      setLiveOpen(false)
      await loadWorkspace()
    } catch (liveError) {
      showError(liveError?.message || '生成直播失败', scheduleLive)
    } finally {
      setSaving(false)
    }
  }

  // ── 数据分析 ──────────────────────────────

  async function loadAnalytics(post) {
    if (!post) return
    setAnalyticsLoading(true)
    setAnalyticsError('')
    try {
      const result = await loadPostAnalytics(post.id, posts)
      const mappedPost = mapPost(result.post || post)
      const summary = result.summary || {}
      setAnalytics({
        post: {
          ...mappedPost,
          description: (result.post && result.post.description) || post.description || '',
          statusText: result.post?.status === 'draft' ? '草稿' : (mappedPost.statusText || '已发布'),
        },
        summary: {
          likes: countValue(summary.likes != null ? summary.likes : mappedPost.likes),
          comments: countValue(summary.comments != null ? summary.comments : mappedPost.comments),
          favorites: countValue(summary.favorites != null ? summary.favorites : mappedPost.favorites),
          shares: countValue(summary.shares != null ? summary.shares : mappedPost.shares),
        },
        comments: safeArray(result.comments).map(mapAnalyticsComment),
        likes: safeArray(result.likes).map(mapAnalyticsInteraction),
        favorites: safeArray(result.favorites).map(mapAnalyticsInteraction),
        shares: safeArray(result.shares).map(mapAnalyticsInteraction),
      })
    } catch (analyticsLoadError) {
      setAnalyticsError(analyticsLoadError?.message || '加载数据分析失败')
    } finally {
      setAnalyticsLoading(false)
    }
  }

  function openAnalytics(post) {
    if (!post) return
    setMoreActionsPost(null)
    setAnalyticsOpen(true)
    setAnalyticsTab('comments')
    setAnalytics({
      post,
      summary: { likes: post.likes, comments: post.comments, favorites: post.favorites, shares: post.shares },
      comments: [], likes: [], favorites: [], shares: [],
    })
    loadAnalytics(post)
  }

  // ── 视频解析 ──────────────────────────────

  async function runParse(post) {
    if (!post) return
    if (!text(post.videoUrl) && !text(post.storagePath) && !text(post.mediaAssetId)) {
      showError('视频地址缺失，无法解析')
      return
    }
    setMoreActionsPost(null)
    setParseOpen(true)
    setParseLoading(true)
    setParsePost(post)
    setParseStatusText('准备解析…')
    setParseError('')
    setParseRetry(null)
    setParseRetryLabel('重试')
    setParseTranscript('')
    setParseFragments([])

    parseSeqRef.current += 1
    const seq = parseSeqRef.current
    try {
      const result = await parseVideo(
        { ...post, ownerId: post.ownerId || selectedChannel?.ownerId || '' },
        {
          fileName: `${String(post.title || 'video').slice(0, 40)}.mp4`,
          ownerId: post.ownerId || selectedChannel?.ownerId || '',
          onProgress: progress => {
            if (seq !== parseSeqRef.current) return
            setParseStatusText(progress?.message || '解析中…')
          },
        },
      )
      if (seq !== parseSeqRef.current) return
      setParseLoading(false)
      setParseStatusText('解析完成')
      setParseTranscript(result.transcript || '')
      setParseFragments(result.fragments || [])
    } catch (runError) {
      if (seq !== parseSeqRef.current) return
      setParseLoading(false)
      setParseStatusText('')
      setParseError(runError?.message || '视频解析失败')
      setParseRetry(() => () => runParse(post))
      setParseRetryLabel('重新解析')
    }
  }

  async function openParseResult(post) {
    if (!post) return
    setMoreActionsPost(null)
    setParseOpen(true)
    setParseLoading(true)
    setParsePost(post)
    setParseStatusText('正在加载解析结果…')
    setParseError('')
    setParseRetry(null)
    setParseRetryLabel('重试')
    setParseTranscript('')
    setParseFragments([])
    try {
      const latest = await getLatestParseByPost(post.id)
      setParseLoading(false)
      if (!latest.found) {
        setParseStatusText('')
        setParseError('该视频暂无解析记录，可先点击「解析」')
        setParseRetry(() => () => runParse(post))
        setParseRetryLabel('开始解析')
        return
      }
      const status = String(latest.status || '').toLowerCase()
      setParseTranscript(latest.transcript || '')
      setParseFragments(latest.fragments || [])
      if (status === 'failed') {
        setParseStatusText('最近一次解析失败')
        setParseError(latest.error?.message || latest.error?.code || '最近一次解析失败')
        setParseRetry(() => () => runParse(post))
        setParseRetryLabel('重新解析')
        return
      }
      if (status !== 'succeeded') {
        setParseStatusText(status === 'processing' || status === 'queued' ? '最近一次解析仍在进行中' : '最近一次解析未完成')
        return
      }
      setParseStatusText('历史解析结果')
    } catch (resultError) {
      setParseLoading(false)
      setParseStatusText('')
      setParseError(resultError?.message || '加载解析结果失败')
      setParseRetry(() => () => openParseResult(post))
      setParseRetryLabel('重新加载')
    }
  }

  function copyChannelLink(channel) {
    const slug = channel?.ownerId
    if (!slug) {
      showError('该渠道还没有主页短链')
      return
    }
    clearError()
    navigator.clipboard.writeText(slug)
      .then(() => setNotice(`已复制主页短链 ${slug}，在小程序里可直接打开`))
      .catch(() => showError('复制失败', () => copyChannelLink(channel)))
  }

  function copyPostLink(post) {
    const url = post?.videoUrl
    if (!url) {
      showError('这条视频还没有可分享的地址')
      return
    }
    clearError()
    navigator.clipboard.writeText(url)
      .then(() => setNotice('已复制视频地址'))
      .catch(() => showError('复制失败', () => copyPostLink(post)))
    setMoreActionsPost(null)
  }

  async function openQrCode(target) {
    if (qrRequestRef.current || !target?.contentType) return
    qrRequestRef.current = true
    setMoreActionsPost(null)
    setQrLoading(true)
    setQrError('')
    setQrTarget(target)
    setQrCodeDataUrl('')
    try {
      const result = await callPrivateConversion('operator_generate_content_qrcode', {
        contentType: target.contentType,
        channelId: target.channelId || '',
        postId: target.postId || '',
        liveSessionId: target.liveSessionId || '',
        envVersion: 'release',
      })
      const dataUrl = result?.qrCodeDataUrl || ''
      if (!/^data:image\/(?:png|jpeg);base64,/i.test(dataUrl)) throw new Error('二维码生成结果无效')
      setQrTarget({ ...target, contentType: result.contentType || target.contentType })
      setQrCodeDataUrl(dataUrl)
      setQrOpen(true)
    } catch (qrLoadError) {
      setQrError(qrLoadError?.message || '生成二维码失败')
    } finally {
      qrRequestRef.current = false
      setQrLoading(false)
    }
  }

  async function openWechatBindingQrcode() {
    if (wechatBindingLoading) return
    setWechatBindingLoading(true)
    clearError()
    setQrBindingCodeDataUrl('')
    setWechatBindingExpiresAt('')
    try {
      const result = await callPrivateConversion('operator_generate_wechat_binding_qrcode', {
        envVersion: 'release',
      })
      const dataUrl = result?.qrCodeDataUrl || ''
      if (!/^data:image\/(?:png|jpeg);base64,/i.test(dataUrl)) throw new Error('微信绑定二维码生成结果无效')
      setQrBindingCodeDataUrl(dataUrl)
      setWechatBindingExpiresAt(result?.expiresAt || result?.expires_at || '')
      setWechatBindingQrOpen(true)
    } catch (bindingError) {
      showError(bindingError?.message || '生成微信绑定二维码失败', openWechatBindingQrcode)
    } finally {
      setWechatBindingLoading(false)
    }
  }

  function downloadQrCode() {
    if (!qrCodeDataUrl || !qrTarget) return
    const shortId = String(qrTarget.postId || qrTarget.liveSessionId || qrTarget.channelId || 'qrcode').slice(0, 8)
    const extension = /^data:image\/jpeg;base64,/i.test(qrCodeDataUrl) ? 'jpg' : 'png'
    const anchor = document.createElement('a')
    anchor.href = qrCodeDataUrl
    anchor.download = `uniopc-${qrTarget.contentType}-${shortId}.${extension}`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  // ── 渲染 ──────────────────────────────

  const feedback = <>
    <AsyncActionState
      state={error && errorRetry ? 'error' : null}
      title="操作失败"
      detail={error}
      onRetry={errorRetry || undefined}
    />
    <MessageBar
      message={error && !errorRetry ? error : ''}
      tone="error"
      onDismiss={clearError}
    />
    <AsyncActionState
      state={qrError ? 'error' : null}
      title="二维码生成失败"
      detail={qrError}
      onRetry={qrTarget ? () => openQrCode(qrTarget) : undefined}
    />
    <MessageBar message={notice} tone="success" onDismiss={() => setNotice('')} />
  </>

  if (editorMode) {
    return (
      <div className={`${LAYOUT.narrow} min-h-full`}>
        <input ref={profileImageInputRef} type="file" accept="image/*" className="hidden" onChange={onProfileImagePicked} />
        <AppPageHeader
          title={editorMode === 'create' ? '新增渠道' : '编辑主页'}
          subtitle="主页信息会直接展示给观众端的访客"
          icon={<StoreIcon />}
          actions={
            <button type="button" className={ACTION.secondary} onClick={() => setEditorMode('')}>返回</button>
          }
        />
        {feedback}
        <section className="ui-panel space-y-3 p-4">
          <div className="flex items-start gap-4">
            <button
              type="button"
              onClick={() => pickProfileImage('coverUrl')}
              className="relative h-28 flex-1 overflow-hidden rounded-xl border border-dashed border-default bg-surface-sunken text-xs text-tertiary transition-colors duration-[120ms] ease-out hover:border-strong"
            >
              {profileForm.coverUrl
                ? <img src={profileForm.coverUrl} alt="封面" className="h-full w-full object-cover" />
                : <span>{uploadTarget === 'coverUrl' ? '上传中…' : '点击设置封面'}</span>}
            </button>
            <button
              type="button"
              onClick={() => pickProfileImage('avatarUrl')}
              className="h-28 w-28 shrink-0 overflow-hidden rounded-xl border border-dashed border-default bg-surface-sunken text-xs text-tertiary transition-colors duration-[120ms] ease-out hover:border-strong"
            >
              {profileForm.avatarUrl
                ? <img src={profileForm.avatarUrl} alt="头像" className="h-full w-full object-cover" />
                : <span>{uploadTarget === 'avatarUrl' ? '上传中…' : '点击设置头像'}</span>}
            </button>
          </div>

          <Field label="主页名称">
            <input value={profileForm.displayName} onChange={e => setProfileField('displayName', e.target.value)} className={FORM.input} placeholder="主页名称" />
          </Field>
          <Field label="短链接">
            <input value={profileForm.slug} onChange={e => setProfileField('slug', e.target.value)} className={FORM.input} placeholder="短链接" />
          </Field>
          <Field label="主页简介">
            <textarea rows={3} value={profileForm.bio} onChange={e => setProfileField('bio', e.target.value)} className={FORM.textarea} placeholder="主页简介" />
          </Field>
          <Field label="地区">
            <input value={profileForm.location} onChange={e => setProfileField('location', e.target.value)} className={FORM.input} placeholder="地区" />
          </Field>
          <Field label="联系方式">
            <input value={profileForm.contactText} onChange={e => setProfileField('contactText', e.target.value)} className={FORM.input} placeholder="例如微信号、手机号或邮箱" />
          </Field>
          <Field label="朋友关注文案">
            <input value={profileForm.friendFollowText} onChange={e => setProfileField('friendFollowText', e.target.value)} className={FORM.input} placeholder="例如 13 个朋友关注" />
          </Field>
          <Field label="主页标签" hint="空格或逗号分隔">
            <input value={profileForm.profileTagsText} onChange={e => setProfileField('profileTagsText', e.target.value)} className={FORM.input} placeholder="主页标签" />
          </Field>

          <button type="button" className={`${ACTION.primary} w-full`} disabled={saving} onClick={saveProfileForm}>
            {saving
              ? (editorMode === 'create' ? '创建中' : '保存中')
              : (editorMode === 'create' ? '创建渠道' : '保存主页')}
          </button>
        </section>
      </div>
    )
  }

  if (!channelId) {
    return (
      <div className={`${LAYOUT.standard} min-h-full`}>
        <AppPageHeader
          title="私域转化"
          subtitle="短视频 · 直播 · 微信小店"
          icon={<StoreIcon />}
          actions={
            <>
              <button type="button" className={ACTION.secondary} onClick={loadWorkspace} disabled={loading}>
                {loading ? '刷新中' : '刷新'}
              </button>
              <button type="button" className={ACTION.secondary} onClick={openWechatBindingQrcode} disabled={wechatBindingLoading}>
                {wechatBindingLoading ? '生成中…' : '绑定微信'}
              </button>
              <button type="button" className={ACTION.primary} onClick={openCreateChannel}>+ 新增渠道</button>
            </>
          }
        />
        {feedback}
        {channels.length === 0 ? (
          <EmptyState>暂无渠道，点右上角「新增渠道」创建第一个私域视频号。</EmptyState>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {channels.map(channel => (
              <button
                key={channel.id}
                type="button"
                onClick={() => navigate(`/apps/private-conversion/${channel.id}?tab=profileInfo`)}
                className="group flex items-center gap-3 rounded-xl border border-subtle bg-surface-raised p-4 text-left transition-[background-color,border-color,box-shadow] duration-200 ease-out hover:border-strong hover:bg-state-hover hover:shadow-md"
              >
                <span className="h-12 w-12 shrink-0 overflow-hidden rounded-full border border-subtle bg-surface-sunken">
                  {channel.avatar ? <img src={channel.avatar} alt="" className="h-full w-full object-cover" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="truncate text-sm font-semibold text-primary">{channel.nickname}</span>
                  <span className="mt-0.5 block truncate text-xs text-tertiary">
                    {channel.organizationName} · {channel.location || '未设置地区'}
                  </span>
                  <span className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-tertiary">
                    <span className="rounded-full bg-surface-overlay px-2 py-0.5">视频 {channel.postCount}</span>
                    <span className="rounded-full bg-surface-overlay px-2 py-0.5">直播 {channel.liveSessionCount}</span>
                    {channel.showWechatStoreWindow ? (
                      <span className="rounded-full bg-state-selected px-2 py-0.5 text-accent-text">小店已开</span>
                    ) : null}
                  </span>
                </span>
                <span className="shrink-0 text-tertiary transition-colors duration-[120ms] ease-out group-hover:text-primary">›</span>
              </button>
            ))}
          </div>
        )}
        <WechatBindingQrModal
          open={wechatBindingQrOpen}
          onClose={() => setWechatBindingQrOpen(false)}
          qrCodeDataUrl={qrBindingCodeDataUrl}
          expiresAt={wechatBindingExpiresAt}
        />
      </div>
    )
  }

  const channel = selectedChannel || {}
  const videoActions = post => (
    <>
      <InlineButton onClick={() => openAnalytics(post)}>数据</InlineButton>
      {contentMode === 'liveVideo' && <InlineButton onClick={() => openLive(post)}>直播</InlineButton>}
      <InlineButton onClick={() => runParse(post)}>解析</InlineButton>
      <InlineButton onClick={() => setMoreActionsPost(post)}>更多</InlineButton>
    </>
  )
  return (
    <div className={`${LAYOUT.standard} min-h-full`}>
      <AppPageHeader
        title={channel.nickname || '私域转化'}
        subtitle={channel.location || '未设置地区'}
        icon={<StoreIcon />}
        actions={
          <>
            <button type="button" className={ACTION.secondary} onClick={() => navigate('/apps/private-conversion')}>
              返回渠道列表
            </button>
            <button type="button" className={ACTION.secondary} onClick={openWechatBindingQrcode} disabled={wechatBindingLoading}>
              {wechatBindingLoading ? '生成中…' : '绑定微信'}
            </button>
            <button type="button" className={ACTION.primary} onClick={() => contentMode === 'article' ? openPublishArticle() : openPublish()}>
              {contentMode === 'article' ? '+ 发布文章' : '+ 发布视频'}
            </button>
          </>
        }
      />
      {feedback}

      <TabBar tabs={CONTENT_TABS} active={contentMode} onChange={setContentMode} />

      {contentMode === 'profileInfo' && (
        <section className="ui-panel overflow-hidden">
          <div className="relative h-36 w-full bg-surface-sunken">
            {channel.coverUrl
              ? <img src={channel.coverUrl} alt="" className="h-full w-full object-cover" />
              : <div className="flex h-full w-full items-center justify-center text-xs text-tertiary">未设置封面</div>}
          </div>
          <div className="p-4">
            <div className="flex items-start gap-3">
              <span className="-mt-10 h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-default bg-surface-sunken ui-elevation-raised">
                {channel.avatar ? <img src={channel.avatar} alt="" className="h-full w-full object-cover" /> : null}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-base font-semibold text-primary">{channel.nickname || '主页名称'}</div>
                <div className="mt-0.5 text-xs text-tertiary">{channel.location || '未设置地区'}</div>
                {channel.bio ? <p className={`mt-2 text-sm ${TEXT.body}`}>{channel.bio}</p> : null}
                {channel.contactText ? <p className={`mt-1 text-sm ${TEXT.body}`}>联系方式：{channel.contactText}</p> : null}
                {safeArray(channel.profileTags).length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {channel.profileTags.map(tag => (
                      <span key={tag} className="rounded-full border border-subtle bg-surface-overlay px-2 py-0.5 text-[11px] text-tertiary">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                {channel.friendFollowText ? (
                  <div className="mt-2 text-xs text-tertiary">{channel.friendFollowText}</div>
                ) : null}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
              <div className="rounded-lg border border-subtle bg-surface-overlay p-3 text-center">
                <div className="text-lg font-semibold text-primary">{channel.postCount}</div>
                <div className="mt-0.5 text-xs text-tertiary">视频</div>
              </div>
              <div className="rounded-lg border border-subtle bg-surface-overlay p-3 text-center">
                <div className="text-lg font-semibold text-primary">{channel.liveSessionCount}</div>
                <div className="mt-0.5 text-xs text-tertiary">直播</div>
              </div>
              <div className="rounded-lg border border-subtle bg-surface-overlay p-3 text-center">
                <div className="text-lg font-semibold text-primary">{channel.showWechatStoreWindow ? '已开' : '未开'}</div>
                <div className="mt-0.5 text-xs text-tertiary">小店</div>
              </div>
            </div>

            <div className="mt-3 text-xs text-tertiary">主页短链 {channel.ownerId || '未设置'}</div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className={ACTION.secondary} onClick={() => copyChannelLink(channel)}>复制主页短链</button>
              <QrCodeButton
                target={{ contentType: 'channel', channelId, label: channel.nickname || '频道主页' }}
                loading={qrLoading}
                onOpen={openQrCode}
              />
              <button type="button" className={ACTION.primary} onClick={openEditChannel}>编辑主页</button>
            </div>
          </div>
        </section>
      )}

      {contentMode === 'shortVideo' && (
        shortVideoPosts.length === 0 ? (
          <EmptyState>该渠道还没有短视频，点右上角「发布视频」发一条。</EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shortVideoPosts.map(post => (
              <VideoTile
                key={post.id}
                post={post}
                active={generationForm.postId === post.id}
                onSelect={() => { setGenerationField('postId', post.id); setPreviewPost(post) }}
                actions={videoActions(post)}
              />
            ))}
          </div>
        )
      )}

      {contentMode === 'liveVideo' && (
        <section className="space-y-6">
          {liveVideoPosts.length === 0 ? (
            <EmptyState>该渠道还没有直播视频，点右上角「发布视频」发一条（类型选“直播”）。</EmptyState>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {liveVideoPosts.map(post => (
                <VideoTile
                  key={post.id}
                  post={post}
                  active={liveForm.sourcePostId === post.id}
                  onSelect={() => { selectPostForLive(post); setPreviewPost(post) }}
                  actions={videoActions(post)}
                />
              ))}
            </div>
          )}

          <section className="ui-panel p-4">
            <div className="mb-3 text-sm font-semibold text-primary">已生成直播</div>
            {channelLiveSessions.length === 0 ? (
              <p className="text-sm text-tertiary">暂无已生成直播</p>
            ) : (
              <div className="space-y-2">
                {channelLiveSessions.map(session => (
                  <div key={session.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-subtle bg-surface-overlay p-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-primary">{session.title}</div>
                      <div className="mt-1 text-xs text-tertiary">{session.statusText} · {session.scheduledText}</div>
                    </div>
                    <QrCodeButton
                      target={{ contentType: 'live', channelId, liveSessionId: session.id, label: session.title }}
                      loading={qrLoading}
                      onOpen={openQrCode}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
        </section>
      )}

      {contentMode === 'article' && (
        articlePosts.length === 0 ? (
          <EmptyState>该渠道还没有文章，点右上角「发布文章」创建第一篇。</EmptyState>
        ) : (
          <section className="space-y-3">
            {articlePosts.map(article => (
              <article key={article.id} className="ui-panel p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold text-primary">{article.title}</h3>
                    {article.description ? <p className={`mt-1 line-clamp-2 text-sm ${TEXT.muted}`}>{article.description}</p> : null}
                  </div>
                  <button type="button" className={ACTION.secondary} onClick={() => openPublishArticle(article)}>编辑</button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-tertiary">
                  <span>{article.statusText}</span>
                  <span>{article.articleBlocks.length} 个正文块</span>
                  <span>阅读 {article.views}</span>
                  <span>赞 {article.likes}</span>
                </div>
                <div className="mt-3">
                  <QrCodeButton
                    target={{ contentType: 'article', channelId, postId: article.id, label: article.title }}
                    loading={qrLoading}
                    onOpen={openQrCode}
                  />
                </div>
              </article>
            ))}
          </section>
        )
      )}

      {contentMode === 'wechatStore' && (
        <section className="ui-panel space-y-3 p-4">
          <h3 className="text-sm font-semibold text-primary">微信小店绑定</h3>
          <p className={`text-sm ${TEXT.muted}`}>
            给这个渠道绑定组织自己的微信小店。保存后，该渠道的主页和直播间会用这个小店展示商品。
          </p>
          <Toggle
            label="显示商品橱窗"
            checked={profileForm.showWechatStoreWindow}
            onChange={value => setProfileField('showWechatStoreWindow', value)}
          />
          <Field label="小店 appid">
            <input
              value={profileForm.wechatStoreAppId}
              onChange={e => setProfileField('wechatStoreAppId', e.target.value)}
              className={FORM.input}
              placeholder="本组织微信小店 appid / 小店 ID"
            />
          </Field>
          <Field label="商品 ID 列表" hint="每行一个；需要带货跟佣可写 商品ID|product-promotion-link">
            <textarea
              rows={5}
              value={profileForm.wechatStoreProductIdsText}
              onChange={e => setProfileField('wechatStoreProductIdsText', e.target.value)}
              className={FORM.textarea}
              placeholder={'商品ID\n商品ID|product-promotion-link'}
            />
          </Field>
          <button type="button" className={`${ACTION.primary} w-full`} disabled={saving} onClick={saveWechatStoreBinding}>
            {saving ? '保存中' : '保存微信小店绑定'}
          </button>
        </section>
      )}

      {/* ── 发布视频 ── */}
      <Modal
        open={publishOpen}
        onClose={closePublish}
        title="发布视频"
        size="2xl"
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className={ACTION.secondary} onClick={closePublish}>取消</button>
            <button
              type="button"
              className={ACTION.primary}
              disabled={saving || uploadTarget === 'videoFile'}
              onClick={publishVideo}
            >
              {uploadTarget === 'videoFile' ? '上传中…' : saving ? '发布中' : '发布视频'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <AsyncActionState
            state={publishError ? 'error' : null}
            title="发布视频失败"
            detail={publishError}
            onRetry={publishErrorRetry || undefined}
          />
          <input ref={videoFileInputRef} type="file" accept="video/*" className="hidden" onChange={onVideoFilePicked} />
          <input ref={videoCoverInputRef} type="file" accept="image/*" className="hidden" onChange={onVideoCoverPicked} />
          <Field label="发布渠道">
            <select value={publishChannelId} onChange={e => setPublishChannelId(e.target.value)} className={FORM.select}>
              {channels.length === 0 ? <option value="">请先创建渠道</option> : null}
              {channels.map(item => <option key={item.id} value={item.id}>{item.nickname}</option>)}
            </select>
          </Field>

          <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
            <div className="space-y-2">
              <button
                type="button"
                onClick={pickVideoFile}
                className="relative block h-[240px] w-full overflow-hidden rounded-xl border border-dashed border-default bg-surface-sunken text-xs text-tertiary transition-colors duration-[120ms] ease-out hover:border-strong"
              >
                {videoForm.videoUrl || videoForm.localVideoUrl ? (
                  <video
                    src={videoForm.videoUrl || videoForm.localVideoUrl}
                    poster={videoForm.coverUrl}
                    muted
                    loop
                    autoPlay
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full flex-col items-center justify-center gap-1">
                    <span className="text-2xl">+</span>
                    <span>选择视频</span>
                  </span>
                )}
                {uploadTarget === 'videoFile' ? (
                  <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-scrim text-xs text-primary">
                    上传中…
                  </span>
                ) : null}
              </button>
              {uploadTarget === 'videoFile' ? (
                <button type="button" className={`${ACTION.secondary} w-full`} onClick={cancelActiveUpload}>取消上传</button>
              ) : (
                <div className="text-center text-xs text-tertiary">
                  {videoForm.videoUrl ? '视频已就绪' : videoForm.localVideoUrl ? '等待上传完成' : '支持 mp4 / mov，单文件 1GB 以内'}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <TabBar
                tabs={[{ key: 'shortVideo', label: '短视频' }, { key: 'liveVideo', label: '直播' }]}
                active={videoForm.videoKind}
                onChange={kind => setVideoField('videoKind', kind)}
              />
              <Field label="标题">
                <input value={videoForm.title} onChange={e => setVideoField('title', e.target.value)} className={FORM.input} placeholder="标题" />
              </Field>
              <Field label="描述">
                <textarea rows={3} value={videoForm.description} onChange={e => setVideoField('description', e.target.value)} className={FORM.textarea} placeholder="说点什么..." />
              </Field>
              <Field label="标签" hint="空格或逗号分隔">
                <input value={videoForm.tagsText} onChange={e => setVideoField('tagsText', e.target.value)} className={FORM.input} placeholder="标签" />
              </Field>
              <button
                type="button"
                onClick={pickVideoCover}
                className="flex w-full items-center gap-3 rounded-lg border border-subtle bg-surface-overlay p-2 text-left transition-colors duration-[120ms] ease-out hover:bg-state-hover"
              >
                <span className="h-12 w-12 shrink-0 overflow-hidden rounded-md bg-surface-sunken">
                  {videoForm.coverUrl ? <img src={videoForm.coverUrl} alt="" className="h-full w-full object-cover" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm text-primary">封面</span>
                  <span className="block text-xs text-tertiary">
                    {uploadTarget === 'videoCover' ? '上传中' : videoForm.coverUrl ? '可更换' : '点击选择封面图'}
                  </span>
                </span>
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* ── 发布文章 ── */}
      <Modal
        open={articleOpen}
        onClose={() => setArticleOpen(false)}
        title={articleForm.id ? '编辑文章' : '发布文章'}
        size="2xl"
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className={ACTION.secondary} onClick={() => setArticleOpen(false)}>取消</button>
            <button type="button" className={ACTION.primary} disabled={saving} onClick={publishArticle}>
              {saving ? '发布中' : '发布文章'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="标题">
            <input value={articleForm.title} onChange={event => setArticleField('title', event.target.value)} className={FORM.input} placeholder="文章标题" />
          </Field>
          <Field label="摘要">
            <textarea rows={3} value={articleForm.description} onChange={event => setArticleField('description', event.target.value)} className={FORM.textarea} placeholder="在列表中展示的摘要" />
          </Field>
          <Field label="封面 URL" hint="可选，使用已上传的图片地址">
            <input value={articleForm.coverUrl} onChange={event => setArticleField('coverUrl', event.target.value)} className={FORM.input} placeholder="https://..." />
          </Field>
          <Field label="标签" hint="空格或逗号分隔">
            <input value={articleForm.tagsText} onChange={event => setArticleField('tagsText', event.target.value)} className={FORM.input} placeholder="AI创业 私域转化" />
          </Field>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-primary">正文</div>
              <button type="button" className={ACTION.secondary} onClick={addArticleBlock}>+ 添加段落</button>
            </div>
            {articleForm.articleBlocks.map((block, index) => (
              <div key={`${block.type}-${index}`} className="rounded-lg border border-subtle bg-surface-overlay p-3">
                <div className="mb-2 flex items-center gap-2">
                  <select value={block.type} onChange={event => setArticleBlock(index, 'type', event.target.value)} className={FORM.select}>
                    <option value="heading">小标题</option>
                    <option value="paragraph">段落</option>
                    <option value="quote">引用</option>
                    <option value="emphasis">强调</option>
                    <option value="image">图片</option>
                  </select>
                  <button type="button" className={ACTION.secondary} onClick={() => removeArticleBlock(index)} disabled={articleForm.articleBlocks.length === 1}>删除</button>
                </div>
                {block.type === 'image' ? (
                  <>
                    <input value={block.url || ''} onChange={event => setArticleBlock(index, 'url', event.target.value)} className={FORM.input} placeholder="图片 URL" />
                    <input value={block.caption || ''} onChange={event => setArticleBlock(index, 'caption', event.target.value)} className={`${FORM.input} mt-2`} placeholder="图片说明（可选）" />
                  </>
                ) : (
                  <textarea rows={block.type === 'paragraph' ? 4 : 2} value={block.text || ''} onChange={event => setArticleBlock(index, 'text', event.target.value)} className={FORM.textarea} placeholder="填写正文" />
                )}
              </div>
            ))}
          </div>
        </div>
      </Modal>

      {/* ── 视频预览：小程序点卡片是跳观众端播放页，桌面端没有观众端，就地播 ── */}
      <Modal
        open={Boolean(previewPost)}
        onClose={() => setPreviewPost(null)}
        title={previewPost?.title || '视频预览'}
        description={previewPost?.kindLabel}
        size="2xl"
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className={ACTION.secondary} onClick={() => copyPostLink(previewPost)}>复制视频地址</button>
            <button type="button" className={ACTION.secondary} onClick={() => setPreviewPost(null)}>关闭</button>
          </div>
        }
      >
        {previewPost?.videoUrl ? (
          <video src={previewPost.videoUrl} poster={previewPost.coverUrl} controls autoPlay className="max-h-[60vh] w-full rounded-lg bg-surface-sunken" />
        ) : (
          <EmptyState>这条视频还没有可播放的文件。</EmptyState>
        )}
        {previewPost?.description ? (
          <p className={`mt-3 text-sm ${TEXT.body}`}>{previewPost.description}</p>
        ) : null}
      </Modal>

      {/* ── 更多操作 ── */}
      <Modal
        open={Boolean(moreActionsPost)}
        onClose={() => setMoreActionsPost(null)}
        title="更多操作"
        description={moreActionsPost?.title}
        size="sm"
        footer={
          <div className="flex justify-end">
            <button type="button" className={ACTION.secondary} onClick={() => setMoreActionsPost(null)}>取消</button>
          </div>
        }
      >
        <div className="space-y-2">
          {moreActionsPost?.videoKind === 'liveVideo' && (
            <button type="button" className={`${ACTION.secondary} w-full`} onClick={() => openLive(moreActionsPost)}>生成直播</button>
          )}
          {moreActionsPost ? (
            <QrCodeButton
              target={{ contentType: 'video', channelId, postId: moreActionsPost.id, label: moreActionsPost.title }}
              loading={qrLoading}
              onOpen={openQrCode}
            />
          ) : null}
          <button type="button" className={`${ACTION.secondary} w-full`} onClick={() => runParse(moreActionsPost)}>视频解析</button>
          <button type="button" className={`${ACTION.secondary} w-full`} onClick={() => openParseResult(moreActionsPost)}>查看解析</button>
          <button type="button" className={`${ACTION.secondary} w-full`} onClick={() => copyPostLink(moreActionsPost)}>复制视频地址</button>
        </div>
      </Modal>

      {/* ── 内容二维码 ── */}
      <Modal
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        title="内容二维码"
        description={`正式版 · ${qrTarget?.label || '微信扫码打开内容'}`}
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className={ACTION.secondary} onClick={() => setQrOpen(false)}>关闭</button>
            <button type="button" className={ACTION.primary} onClick={downloadQrCode}>下载二维码</button>
          </div>
        }
      >
        {qrCodeDataUrl ? (
          <img src={qrCodeDataUrl} alt={`${qrTarget?.label || '内容'}二维码`} className="mx-auto h-64 w-64 rounded-lg border border-subtle bg-white p-2" />
        ) : null}
      </Modal>

      <WechatBindingQrModal
        open={wechatBindingQrOpen}
        onClose={() => setWechatBindingQrOpen(false)}
        qrCodeDataUrl={qrBindingCodeDataUrl}
        expiresAt={wechatBindingExpiresAt}
      />

      {/* ── 生成直播 ── */}
      <Modal
        open={liveOpen}
        onClose={() => setLiveOpen(false)}
        title="生成直播"
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className={ACTION.secondary} onClick={() => setLiveOpen(false)}>取消</button>
            <button type="button" className={ACTION.primary} disabled={saving} onClick={scheduleLive}>
              {saving ? '生成中' : '生成直播'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="直播标题">
            <input value={liveForm.title} onChange={e => setLiveField('title', e.target.value)} className={FORM.input} placeholder="直播标题" />
          </Field>
          <Field label="来源视频" hint="直播素材跟随来源视频，不单独选择">
            <select
              value={liveForm.sourcePostId}
              onChange={e => {
                const post = liveVideoPosts.find(item => item.id === e.target.value)
                if (post) openLive(post)
              }}
              className={FORM.select}
            >
              {liveVideoPosts.length === 0 ? <option value="">暂无可选视频</option> : null}
              {liveVideoPosts.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="开播日期">
              <input type="date" value={liveForm.scheduledDate} onChange={e => setLiveField('scheduledDate', e.target.value)} className={FORM.input} />
            </Field>
            <Field label="开播时间">
              <input type="time" value={liveForm.scheduledTime} onChange={e => setLiveField('scheduledTime', e.target.value)} className={FORM.input} />
            </Field>
          </div>
          <Toggle label="直播间密码" checked={liveForm.passwordEnabled} onChange={v => setLiveField('passwordEnabled', v)} />
          {liveForm.passwordEnabled ? (
            <Field label="密码">
              <input value={liveForm.password} onChange={e => setLiveField('password', e.target.value)} className={FORM.input} placeholder="输入直播间密码" />
            </Field>
          ) : null}
        </div>
      </Modal>

      {/* ── 视频数据分析 ── */}
      <Modal
        open={analyticsOpen}
        onClose={() => setAnalyticsOpen(false)}
        title="视频数据分析"
        size="2xl"
        footer={
          <div className="flex justify-end">
            <button type="button" className={ACTION.secondary} onClick={() => setAnalyticsOpen(false)}>关闭</button>
          </div>
        }
      >
        {analytics ? (
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-surface-sunken">
                {analytics.post.coverUrl ? <img src={analytics.post.coverUrl} alt="" className="h-full w-full object-cover" /> : null}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-primary">{analytics.post.title || '未命名视频'}</div>
                <div className="mt-0.5 text-xs text-tertiary">
                  {analytics.post.kindLabel || '视频'} · {analytics.post.statusText || '已发布'}
                </div>
                {analytics.post.description ? (
                  <p className="mt-1 line-clamp-2 text-xs text-tertiary">{analytics.post.description}</p>
                ) : null}
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2">
              {[
                { key: 'comments', label: '评论' },
                { key: 'likes', label: '点赞' },
                { key: 'favorites', label: '收藏' },
                { key: 'shares', label: '转发' },
              ].map(item => (
                <div key={item.key} className="rounded-lg border border-subtle bg-surface-overlay p-3 text-center">
                  <div className="text-lg font-semibold text-primary">{analytics.summary[item.key] || 0}</div>
                  <div className="mt-0.5 text-xs text-tertiary">{item.label}</div>
                </div>
              ))}
            </div>

            <TabBar
              tabs={ANALYTICS_TABS.map(key => ({
                key,
                label: `${{ comments: '评论', likes: '点赞', favorites: '收藏', shares: '转发' }[key]} ${analytics[key].length}`,
              }))}
              active={analyticsTab}
              onChange={setAnalyticsTab}
            />

            <AsyncActionState
              state={analyticsError ? 'error' : analyticsLoading ? 'loading' : null}
              title={analyticsError ? '数据分析加载失败' : '正在加载数据分析…'}
              detail={analyticsError}
              onRetry={() => loadAnalytics(analytics.post)}
            >
              {analytics[analyticsTab].length === 0 ? (
                <EmptyState>暂无{{ comments: '评论', likes: '点赞', favorites: '收藏', shares: '转发' }[analyticsTab]}明细</EmptyState>
              ) : (
                <div className="max-h-[40vh] divide-y divide-subtle overflow-y-auto">
                  {analytics[analyticsTab].map(item => (
                    <div key={item.id} className="flex gap-3 py-3">
                      <span className="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-surface-sunken">
                        {item.avatar ? <img src={item.avatar} alt="" className="h-full w-full object-cover" /> : null}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm text-primary">{item.nickname}</span>
                          <span className="shrink-0 rounded-full border border-subtle bg-surface-overlay px-1.5 py-0.5 text-[10px] text-tertiary">
                            {item.sourceLabel || item.typeLabel}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-tertiary">{item.openidText}</div>
                        {item.content ? <div className={`mt-1 text-sm ${TEXT.body}`}>{item.content}</div> : null}
                        <div className="mt-1 text-[11px] text-tertiary">
                          {item.timeText}{item.likes != null && item.content ? ` · 赞 ${item.likes}` : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </AsyncActionState>
          </div>
        ) : null}
      </Modal>

      {/* ── 视频解析 ── */}
      <Modal
        open={parseOpen}
        onClose={() => { if (!parseLoading) setParseOpen(false) }}
        title="视频解析"
        size="2xl"
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className={ACTION.secondary} disabled={parseLoading} onClick={() => setParseOpen(false)}>
              {parseLoading ? '解析中' : '关闭'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <span className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-surface-sunken">
              {parsePost?.coverUrl ? <img src={parsePost.coverUrl} alt="" className="h-full w-full object-cover" /> : null}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-primary">{parsePost?.title || '未命名视频'}</div>
              <div className="mt-0.5 text-xs text-tertiary">{parsePost?.kindLabel || '视频'} · 关键片段识别</div>
            </div>
          </div>

          <AsyncActionState
            state={parseError ? 'error' : parseLoading ? 'loading' : null}
            title={parseError ? '视频解析失败' : parseStatusText || '解析中…'}
            detail={parseError}
            onRetry={parseRetry || undefined}
            retryLabel={parseRetryLabel}
          >
            {!parseLoading || parseTranscript || parseFragments.length > 0 ? (
              <>
                {!parseError && parseStatusText ? <div className="text-xs text-tertiary">{parseStatusText}</div> : null}
                {parseTranscript ? (
                  <div>
                    <div className="mb-1 text-sm font-semibold text-primary">全文转写</div>
                    <pre className={`max-h-[24vh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-subtle bg-surface-sunken p-3 text-sm ${TEXT.body}`}>
                      {parseTranscript}
                    </pre>
                  </div>
                ) : null}
                <div className="text-sm font-semibold text-primary">关键片段（{parseFragments.length}）</div>
                {parseFragments.length === 0 ? (
                  <EmptyState>未识别到关键片段</EmptyState>
                ) : (
                  <div className="max-h-[32vh] divide-y divide-subtle overflow-y-auto">
                    {parseFragments.map(fragment => (
                      <div key={fragment.id} className="py-2.5">
                        <div className="flex items-center gap-2 text-[11px] text-tertiary">
                          <span className="rounded bg-surface-overlay px-1.5 py-0.5">{fragment.timeText}</span>
                          <span>{fragment.channelText}</span>
                        </div>
                        <div className={`mt-1 text-sm ${TEXT.body}`}>{fragment.text}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : null}
          </AsyncActionState>
        </div>
      </Modal>
    </div>
  )
}
