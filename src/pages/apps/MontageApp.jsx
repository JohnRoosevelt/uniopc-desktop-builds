/** Desktop 智能混剪：品牌档案 → 文案 → 选片 → 母版 → 字幕成片。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AppPageHeader, EmptyState, Field, InlineButton, MessageBar, TabBar } from '../../components/AppsUI'
import Modal from '../../components/Modal'
import { ACTION, LAYOUT, TEXT } from '../../lib/theme'
import { callMedia, callMontage, formatFileSize, safeArray, text, uploadOperatorAsset } from '../../lib/appsBackend'
import { callSupabaseFunction } from '../../lib/supabase'
import { smartMontageFuncs } from '../../lib/montageFuncs'

export const MAX_MONTAGE_ASSET_BYTES = 500 * 1024 * 1024

const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm'])
const DEFAULT_INDUSTRIES = [
  { id: 'auto', name: '由 Agent 自动判断' }, { id: 'general', name: '通用' }, { id: 'restaurant', name: '餐饮' },
  { id: 'local-service', name: '本地生活' }, { id: 'education', name: '知识教育' }, { id: 'beauty', name: '丽人' },
  { id: 'leisure-entertainment', name: '休闲娱乐' }, { id: 'health', name: '健康' }, { id: 'factory', name: '实体工厂' },
  { id: 'home-building', name: '家居建材' }, { id: 'franchise', name: '招商加盟' }, { id: 'automotive', name: '汽车' },
  { id: 'life-service', name: '生活服务' }, { id: 'retail', name: '购物零售' }, { id: 'fitness', name: '运动健身' }, { id: 'apparel', name: '鞋服' },
]
const TABS = [{ key: 'create', label: '创作' }, { key: 'materials', label: '素材集合' }, { key: 'works', label: '作品' }, { key: 'tasks', label: '任务' }]
const ACTIVE_STATUSES = new Set(['queued', 'running'])
const CAPTION_STYLE = { size: 'medium', color: 'white', position: 'bottom', background: 'none', animation: 'pop' }

function emptyBrief() {
  return { brandId: '', industry: 'auto', brandName: '', location: '', durationSeconds: '60', product: '', audience: '', sellingPoints: '', businessVision: '', tone: '', platform: '', mustInclude: '', mustAvoid: '', extraRequirement: '' }
}

function MontageIcon() {
  return <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M7 4.5v15M17 4.5v15M4 8h16M4 16h16" /><path strokeLinecap="round" strokeLinejoin="round" d="m10 10 4 2-4 2v-4z" /></svg>
}

const idOf = value => text(value?.id || value?.assetId || value?.asset_id || value?.jobId || value?.job_id)
const lines = value => text(value).split(/[\n,，]/).map(item => item.trim()).filter(Boolean)
const errorText = (error, fallback) => text(error?.message) || (typeof error === 'string' ? text(error) : '') || fallback
const optional = value => text(value) || undefined

// Stable serialization makes an idempotency key reflect the complete request,
// rather than incidental JavaScript object insertion order.
function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function stableRequestHash(value) {
  let hash = 0xcbf29ce484222325n
  const source = stableSerialize(value)
  for (const character of source) {
    hash ^= BigInt(character.codePointAt(0))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(36)
}

export function captionIdempotencyKey(masterJobId, request) {
  return `desktop-montage-caption-${text(masterJobId)}-${stableRequestHash(request)}`
}

export function montageFileError(file) {
  const extension = text(file?.name).split('.').pop()?.toLowerCase() || ''
  const contentType = text(file?.type).toLowerCase()
  if (!text(file?.name) || !VIDEO_EXTENSIONS.has(extension) || (contentType && !VIDEO_TYPES.has(contentType))) return '仅支持 MP4、MOV 或 WebM 视频素材'
  if (!Number.isFinite(Number(file?.size)) || Number(file.size) <= 0) return '不能上传空文件'
  if (Number(file.size) > MAX_MONTAGE_ASSET_BYTES) return '单个视频不能超过 500MB'
  return ''
}

async function readVideoDuration(file) {
  const url = URL.createObjectURL(file)
  try {
    return await new Promise(resolve => {
      const video = document.createElement('video')
      const finish = value => { video.removeAttribute('src'); video.load(); resolve(Number(value) || 0) }
      video.preload = 'metadata'; video.onloadedmetadata = () => finish(video.duration); video.onerror = () => finish(0); video.src = url
    })
  } finally { URL.revokeObjectURL(url) }
}

function brandBrief(value, industries) {
  const field = name => text(value?.[name] ?? value?.[name.replace(/[A-Z]/g, part => `_${part.toLowerCase()}`)])
  const industry = field('industry') || 'auto'
  return { ...emptyBrief(), brandId: field('id'), industry: industries.some(item => item.id === industry) ? industry : 'auto', brandName: field('name'), location: field('location'), product: field('product'), audience: field('audience'), sellingPoints: field('sellingPoints'), businessVision: field('businessVision'), tone: field('tone'), platform: field('platform'), mustInclude: field('mustInclude'), mustAvoid: field('mustAvoid'), extraRequirement: field('extraRequirement') }
}

function mediaAsset(value) {
  return { id: idOf(value), mediaAssetId: text(value?.mediaAssetId || value?.media_asset_id) || idOf(value), name: text(value?.originalName || value?.original_name || value?.name) || '未命名视频', size: Number(value?.byteSize || value?.byte_size || 0), duration: Number(value?.durationSeconds || value?.duration_seconds || 0), url: text(value?.publicUrl || value?.public_url || value?.downloadUrl || value?.download_url) }
}

function jobInfo(value) {
  const output = value?.output || value?.result || {}
  return { id: idOf(value), type: text(value?.type), source: text(value?.source || value?.input?.output?.metadata?.source), status: text(value?.status) || 'queued', title: text(value?.title || value?.input?.output?.title) || '智能混剪', createdAt: text(value?.createdAt || value?.created_at), stage: text(value?.stage), progress: Number(value?.progress || 0), error: text(value?.error?.message || value?.errorMessage || value?.error_message), output, videoUrl: text(output?.url || output?.videoUrl || output?.video_url), audioUrl: text(output?.narrationUrl || output?.narration_url || output?.audioUrl || output?.audio_url || output?.ttsUrl || (typeof output?.audio === 'string' ? output.audio : output?.audio?.url)) }
}

function jobStatus(status) { return ({ queued: '排队中', running: '处理中', succeeded: '已完成', failed: '失败', cancelled: '已取消', manual_review: '需确认重试' })[status] || status }
function clipValid(clip) { return text(clip?.id) && text(clip?.url) && Number(clip?.startSeconds) >= 0 && Number(clip?.durationSeconds) > 0 }

export default function MontageApp() {
  const inputRef = useRef(null)
  const captionStarts = useRef(new Set())
  const [tab, setTab] = useState('create')
  const [creationStep, setCreationStep] = useState('brief')
  const [brief, setBrief] = useState(emptyBrief)
  const [brands, setBrands] = useState([])
  const [industries, setIndustries] = useState(DEFAULT_INDUSTRIES)
  const [script, setScript] = useState(null)
  const [scriptInstruction, setScriptInstruction] = useState('')
  const [voices, setVoices] = useState([])
  const [voiceId, setVoiceId] = useState('')
  const [voiceLoadError, setVoiceLoadError] = useState('')
  const [collections, setCollections] = useState([])
  const [selectedCollectionId, setSelectedCollectionId] = useState('')
  const [assets, setAssets] = useState([])
  const [clips, setClips] = useState([])
  const [jobs, setJobs] = useState([])
  const [captionJobs, setCaptionJobs] = useState({})
  const [previewJob, setPreviewJob] = useState(null)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState('info')

  const selectedCollection = useMemo(() => collections.find(item => item.id === selectedCollectionId), [collections, selectedCollectionId])
  const selectedAssets = assets
  const activeJob = jobs.find(job => ACTIVE_STATUSES.has(job.status))
  const selectedVoice = voices.find(voice => voice.id === voiceId)
  const masterJob = jobs.find(job => job.source === 'desktop-smart-montage-create' && job.status === 'succeeded')
  const finalJob = jobs.find(job => job.source === 'desktop-smart-montage-caption' && job.status === 'succeeded')
  const completedWorks = jobs.filter(job => job.status === 'succeeded' && job.videoUrl)

  const client = () => smartMontageFuncs()
  const montage = (action, payload = {}) => callMontage(action, payload)
  const notify = (value, tone = 'info') => { setMessage(value); setMessageTone(tone) }
  const updateBrief = (key, value) => setBrief(current => ({ ...current, [key]: value }))

  async function loadBrands() {
    const result = await callSupabaseFunction('organization-stores', { action: 'list_brands', payload: {} })
    setBrands(safeArray(result?.brands))
  }

  async function loadIndustries() {
    try {
      const result = await client().listCopywritingSkills()
      const next = safeArray(result?.skills).map(item => ({ id: text(item?.id), name: text(item?.name).replace(/行业文案\s*Skill|文案\s*Skill/ig, '').trim() })).filter(item => item.id && item.name)
      if (next.length) setIndustries([{ id: 'auto', name: '由 Agent 自动判断' }, ...next])
    } catch (_) { /* The checked-in fallback mirrors the service catalogue. */ }
  }

  async function loadCollections() {
    const result = await montage('list_collections')
    const next = safeArray(result?.collections).map(item => ({ id: text(item?.id), name: text(item?.name), assetCount: Number(item?.assetCount || item?.asset_count || 0) })).filter(item => item.id)
    setCollections(next); setSelectedCollectionId(previous => next.some(item => item.id === previous) ? previous : (next[0]?.id || ''))
    return next
  }

  async function loadAssets(collectionId = selectedCollectionId) {
    if (!collectionId) { setAssets([]); return }
    const result = await montage('list_assets', { collectionId })
    setAssets(safeArray(result?.assets).map(mediaAsset).filter(asset => asset.id && asset.mediaAssetId))
  }

  async function loadJobs({ quiet = false } = {}) {
    try {
      const [masters, captions] = await Promise.all([client().listJobs({ type: 'montage' }), client().listJobs({ type: 'video-caption' })])
      const next = [...safeArray(masters?.jobs), ...safeArray(captions?.jobs)].map(jobInfo)
        .filter(job => job.id && (job.source === 'desktop-smart-montage-create' || job.source === 'desktop-smart-montage-caption'))
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      setJobs(next)
    } catch (error) { if (!quiet) notify(errorText(error, '加载混剪任务失败'), 'error') }
  }

  useEffect(() => {
    Promise.allSettled([loadBrands(), loadIndustries(), loadCollections(), loadJobs({ quiet: true })]).then(results => {
      const failed = results.find(item => item.status === 'rejected')
      if (failed) notify(errorText(failed.reason, '部分初始化数据加载失败'), 'error')
    })
  }, [])

  useEffect(() => { loadAssets().catch(error => notify(errorText(error, '加载素材集合失败'), 'error')); setClips([]) }, [selectedCollectionId])

  useEffect(() => {
    if (!activeJob) return undefined
    const timer = window.setInterval(() => loadJobs({ quiet: true }), 5000)
    return () => window.clearInterval(timer)
  }, [activeJob?.id])

  async function submitCaption(master, instruction = '') {
    if (!master?.id || !master?.videoUrl || !Array.isArray(master.output?.captions) || !master.output.captions.length || captionStarts.current.has(master.id)) return
    captionStarts.current.add(master.id)
    try {
      const captionRequest = {
        type: 'video-caption',
        input: { url: master.videoUrl, captions: master.output.captions, style: CAPTION_STYLE, ...(text(instruction) ? { styleInstruction: text(instruction) } : {}) },
        output: { fileName: 'desktop-montage-caption.mp4', title: `${brief.brandName || master.title}智能混剪`, channelType: 'video', metadata: { source: 'desktop-smart-montage-caption', masterJobId: master.id } },
      }
      const result = await client().createJob(captionRequest, captionIdempotencyKey(master.id, captionRequest))
      const created = jobInfo(result?.job || result)
      if (created.id) { setCaptionJobs(current => ({ ...current, [master.id]: created.id })); setJobs(current => [created, ...current.filter(job => job.id !== created.id)]) }
      notify('母版完成，已开始生成字幕成片', 'success')
    } catch (error) { captionStarts.current.delete(master.id); notify(errorText(error, '母版已完成，但创建字幕任务失败'), 'error') }
  }

  useEffect(() => {
    if (masterJob && !captionJobs[masterJob.id]) submitCaption(masterJob)
  }, [masterJob?.id, masterJob?.videoUrl, masterJob?.output?.captions?.length])

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || [])
    const invalid = files.map(montageFileError).find(Boolean)
    if (invalid) return notify(invalid, 'error')
    setUploading(true)
    try {
      if (!selectedCollectionId) throw new Error('请先创建或选择素材集合')
      for (const file of files) {
        const uploaded = await uploadOperatorAsset({ file, assetKind: 'video', durationSeconds: await readVideoDuration(file) })
        if (!text(uploaded.mediaAssetId)) throw new Error('素材上传后未返回媒体编号')
        await montage('create_asset', { collectionId: selectedCollectionId, mediaAssetId: uploaded.mediaAssetId })
      }
      await Promise.all([loadAssets(), loadCollections()]); notify(`已上传 ${files.length} 个素材到「${selectedCollection?.name || '当前集合'}」`, 'success')
    } catch (error) { notify(errorText(error, '上传素材失败'), 'error') } finally { setUploading(false) }
  }

  async function createCollection() {
    const name = window.prompt('请输入素材集合名称')
    if (!text(name)) return
    setBusy(true)
    try {
      const result = await montage('create_collection', { name: text(name) })
      const created = text(result?.collection?.id)
      await loadCollections()
      if (created) setSelectedCollectionId(created)
      notify('素材集合已创建', 'success')
    } catch (error) { notify(errorText(error, '创建素材集合失败'), 'error') } finally { setBusy(false) }
  }

  function selectBrand(event) {
    const id = event.target.value
    const brand = brands.find(item => text(item?.id) === id)
    if (!brand) return
    setBrief(brandBrief(brand, industries)); setScript(null); setClips([]); setVoiceId('')
  }

  function validateBrief() {
    const duration = Number(brief.durationSeconds)
    if (!text(brief.brandName) || !text(brief.location) || !Number.isFinite(duration) || duration < 15 || duration > 180) {
      notify('请填写店铺名、城市，并设置 15–180 秒时长', 'error'); return null
    }
    return duration
  }

  function copywritingPayload(revision = false) {
    const duration = validateBrief()
    if (!duration) return null
    const base = `请为${brief.location}的${brief.brandName}生成智能混剪视频文案，目标时长 ${duration} 秒。`
    const requirement = `${base}${text(brief.businessVision) ? `\n生意愿景：${text(brief.businessVision)}` : ''}${text(brief.extraRequirement) ? `\n补充要求：${text(brief.extraRequirement)}` : ''}${revision ? `\n当前完整文案：\n${text(script?.content)}\n\n本轮修改意见：${text(scriptInstruction)}\n请按修改意见返回一份完整替换稿。` : ''}`
    const brand = { name: optional(brief.brandName), product: optional(brief.product), audience: optional(brief.audience), sellingPoints: lines(brief.sellingPoints), location: optional(brief.location), tone: optional(brief.tone) }
    const constraints = { durationSeconds: duration, platform: optional(brief.platform), mustInclude: lines(brief.mustInclude), mustAvoid: lines(brief.mustAvoid) }
    return { ...(brief.industry !== 'auto' ? { industry: brief.industry } : {}), copyType: 'smart-montage', requirement, brand: Object.fromEntries(Object.entries(brand).filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length))), constraints: Object.fromEntries(Object.entries(constraints).filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length))) }
  }

  async function generateScript(revision = false) {
    if (revision && !text(scriptInstruction)) return notify('请先填写修改意见', 'error')
    const payload = copywritingPayload(revision)
    if (!payload) return
    setBusy(true)
    try {
      const result = await client().generateScript(payload)
      if (!text(result?.content)) throw new Error('文案服务未返回正文')
      setScript(result); setScriptInstruction(''); setClips([]); setVoiceId(''); setCreationStep('voice')
      // Mirror the mini-program transition from the script step to the voice step:
      // the voice catalogue is loaded as soon as a usable script is available.
      const voiceResult = await loadVoices({ silent: true, withBusy: false })
      notify(voiceResult.voices.length
        ? `${revision ? '文案已按意见更新' : '文案已生成'}，已加载 ${voiceResult.voices.length} 个音色，请选择音色和素材`
        : `${revision ? '文案已按意见更新' : '文案已生成'}；${voiceResult.error || '音色暂未加载，请点击“重新加载音色”重试'}`, voiceResult.voices.length ? 'success' : 'info')
    } catch (error) { notify(errorText(error, '生成文案失败'), 'error') } finally { setBusy(false) }
  }

  async function loadVoices({ silent = false, withBusy = true } = {}) {
    if (withBusy) setBusy(true)
    setVoiceLoadError('')
    try {
      const result = await client().listVoices()
      const next = safeArray(result?.voices).map(voice => ({ id: text(voice?.voice_id || voice?.voiceId || voice?.id), name: text(voice?.voice_name || voice?.name || voice?.id) })).filter(voice => voice.id)
      if (!next.length) throw new Error('暂无可用音色，请稍后重试')
      setVoices(next); setVoiceId(current => current || next[0].id)
      return { voices: next, error: '' }
    } catch (error) {
      const message = errorText(error, '加载音色失败')
      setVoiceLoadError(message)
      if (!silent) notify(message, 'error')
      return { voices: [], error: message }
    } finally { if (withBusy) setBusy(false) }
  }

  async function resolveAssetUrls() {
    return await Promise.all(selectedAssets.map(async asset => {
      if (asset.url) return asset
      const access = await callMedia('operator_get_media_download_url', { mediaAssetId: asset.mediaAssetId })
      const url = text(access?.cdnUrl || access?.signedUrl || access?.publicUrl)
      if (!url) throw new Error(`素材「${asset.name}」缺少可用的视频地址`)
      return { ...asset, url }
    }))
  }

  async function generatePlan() {
    const duration = validateBrief()
    if (!duration) return
    if (!script?.content) return notify('请先生成文案', 'error')
    if (!selectedCollectionId) return notify('请选择素材集合', 'error')
    if (!selectedAssets.length) return notify('当前素材集合没有视频素材', 'error')
    setBusy(true)
    try {
      const sourceAssets = await resolveAssetUrls()
      const result = await client().planMontage({ assets: sourceAssets.map(asset => ({ id: asset.id, mediaAssetId: asset.mediaAssetId, name: asset.name, url: asset.url, durationSeconds: asset.duration })), targetDurationSeconds: duration, maxClips: 60 })
      const next = safeArray(result?.clips).map(clip => ({ ...clip, startSeconds: Number(clip?.startSeconds), durationSeconds: Number(clip?.durationSeconds) }))
      if (!next.length || next.some(clip => !clipValid(clip))) throw new Error('选片服务返回了无效的片段方案')
      setClips(next); notify('随机片段方案已生成，可微调起点和时长', 'success')
    } catch (error) { notify(errorText(error, '生成片段方案失败'), 'error') } finally { setBusy(false) }
  }

  async function createMasterJob() {
    if (!script?.content) return notify('请先确认完整文案', 'error')
    if (!voiceId) return notify('请选择可用音色', 'error')
    if (!clips.length || clips.some(clip => !clipValid(clip))) return notify('请生成有效的片段方案', 'error')
    setBusy(true)
    try {
      const result = await client().createJob({
        type: 'montage', input: { assets: clips.map(clip => ({ id: text(clip.id), url: text(clip.url), startSeconds: Number(clip.startSeconds), durationSeconds: Number(clip.durationSeconds) })), voiceId, voiceSource: 'minimax', transcript: text(script.content), captions: false },
        output: { fileName: 'desktop-montage-master.mp4', title: `${brief.brandName}智能混剪母版`, channelType: 'video', metadata: { source: 'desktop-smart-montage-create', kind: 'montage-master', ...(brief.brandId ? { brandId: brief.brandId } : {}) } },
      }, `desktop-montage-master-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      const created = jobInfo(result?.job || result)
      if (!created.id) throw new Error('任务服务未返回任务编号，请重试')
      setJobs(current => [created, ...current.filter(job => job.id !== created.id)]); setTab('tasks'); notify('云端母版任务已创建，完成后将自动烧录字幕；完成作品会归入「作品」', 'success')
    } catch (error) { notify(errorText(error, '创建云端母版任务失败'), 'error') } finally { setBusy(false) }
  }

  async function retryJob(job) { setBusy(true); try { await client().retryJob(job.id, job.status === 'manual_review'); await loadJobs(); notify('任务已重新提交', 'success') } catch (error) { notify(errorText(error, '重试失败'), 'error') } finally { setBusy(false) } }
  async function cancelJob(job) { setBusy(true); try { await client().cancelJob(job.id); await loadJobs(); notify('任务已取消', 'success') } catch (error) { notify(errorText(error, '取消失败'), 'error') } finally { setBusy(false) } }
  async function refreshJob(job) { setBusy(true); try { await client().refreshJob(job.id); await loadJobs(); notify('已刷新制作进度', 'success') } catch (error) { notify(errorText(error, '刷新失败'), 'error') } finally { setBusy(false) } }


  return <div className={LAYOUT.page}>
    <AppPageHeader title="智能混剪" subtitle="店铺档案驱动文案，云端智能选片后依次生成母版与字幕成片" icon={<MontageIcon />} actions={<InlineButton onClick={() => { loadAssets().catch(() => {}); loadJobs() }} disabled={busy || uploading}>刷新</InlineButton>} />
    <MessageBar message={message} tone={messageTone} onDismiss={() => setMessage('')} />
    <TabBar tabs={TABS} active={tab} onChange={setTab} />

    {tab === 'create' ? <div className="mb-5 grid grid-cols-4 gap-2 rounded-2xl border border-subtle bg-surface p-3">{[
      ['brief', '1. 店铺与文案'], ['voice', '2. 选择音色'], ['material', '3. 素材与选片'], ['production', '4. 开始制作'],
    ].map(([key, label], index) => <button key={key} type="button" disabled={(index > 0 && !script) || (index > 1 && !voiceId) || (index > 2 && !clips.length)} onClick={() => setCreationStep(key)} className={`rounded-lg px-3 py-2 text-left text-sm ${creationStep === key ? 'bg-accent-soft font-semibold text-accent-text' : 'text-secondary hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-50'}`}>{label}</button>)}</div> : null}

    {tab === 'create' ? <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <section className={`${creationStep === 'brief' ? 'space-y-5' : 'hidden'} rounded-2xl border border-subtle bg-surface p-5`}>
        <div><h3 className="text-base font-semibold text-primary">1. 店铺与创作要求</h3><p className={`mt-1 text-sm ${TEXT.secondary}`}>选择组织中的店铺档案会自动带入行业、商品与卖点；也可补充或修改本次需求。</p></div>
        <Field label="店铺 / 品牌档案"><select value={brief.brandId} onChange={selectBrand} className="mt-1.5 w-full rounded-lg border border-default bg-surface-overlay px-3 py-2 text-sm text-primary"><option value="">手动填写本次店铺信息</option>{brands.map(brand => <option key={brand.id} value={brand.id}>{text(brand.name)}</option>)}</select></Field>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="店铺名"><input value={brief.brandName} onChange={event => updateBrief('brandName', event.target.value)} className="mt-1.5 w-full rounded-lg border border-default bg-surface-overlay px-3 py-2 text-sm text-primary" placeholder="例如：山城咖啡" /></Field><Field label="城市 / 门店区域"><input value={brief.location} onChange={event => updateBrief('location', event.target.value)} className="mt-1.5 w-full rounded-lg border border-default bg-surface-overlay px-3 py-2 text-sm text-primary" placeholder="例如：杭州西湖" /></Field></div>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="行业类型"><select value={brief.industry} onChange={event => updateBrief('industry', event.target.value)} className="mt-1.5 w-full rounded-lg border border-default bg-surface-overlay px-3 py-2 text-sm text-primary">{industries.map(industry => <option key={industry.id} value={industry.id}>{industry.name}</option>)}</select></Field><Field label="目标时长（15–180 秒）"><input type="number" min="15" max="180" value={brief.durationSeconds} onChange={event => updateBrief('durationSeconds', event.target.value)} className="mt-1.5 w-full rounded-lg border border-default bg-surface-overlay px-3 py-2 text-sm text-primary" /></Field></div>
        <Field label="商品 / 服务"><textarea value={brief.product} onChange={event => updateBrief('product', event.target.value)} className="mt-1.5 min-h-20 w-full rounded-lg border border-default bg-surface-overlay px-3 py-2 text-sm text-primary" placeholder="本次主推什么商品或服务？" /></Field>
        <Field label="目标客群"><input value={brief.audience} onChange={event => updateBrief('audience', event.target.value)} className="mt-1.5 w-full rounded-lg border border-default bg-surface-overlay px-3 py-2 text-sm text-primary" placeholder="例如：周边年轻白领、亲子家庭" /></Field>
        <Field label="核心卖点" hint="换行或逗号分隔"><textarea value={brief.sellingPoints} onChange={event => updateBrief('sellingPoints', event.target.value)} className="mt-1.5 min-h-20 w-full rounded-lg border border-default bg-surface-overlay px-3 py-2 text-sm text-primary" placeholder="例如：现磨手冲、限时团购、可带宠物" /></Field>
        <details className="rounded-xl border border-subtle bg-surface-overlay p-3"><summary className="cursor-pointer text-sm font-medium text-secondary">更多文案约束</summary><div className="mt-3 grid gap-3"><Field label="生意愿景"><input value={brief.businessVision} onChange={event => updateBrief('businessVision', event.target.value)} className="mt-1.5 w-full rounded-lg border border-default bg-surface px-3 py-2 text-sm text-primary" /></Field><Field label="语气"><input value={brief.tone} onChange={event => updateBrief('tone', event.target.value)} className="mt-1.5 w-full rounded-lg border border-default bg-surface px-3 py-2 text-sm text-primary" placeholder="例如：真诚、有烟火气" /></Field><Field label="发布平台"><input value={brief.platform} onChange={event => updateBrief('platform', event.target.value)} className="mt-1.5 w-full rounded-lg border border-default bg-surface px-3 py-2 text-sm text-primary" placeholder="例如：抖音" /></Field><Field label="必须包含 / 禁止出现"><div className="mt-1.5 grid gap-2 sm:grid-cols-2"><input value={brief.mustInclude} onChange={event => updateBrief('mustInclude', event.target.value)} className="rounded-lg border border-default bg-surface px-3 py-2 text-sm text-primary" placeholder="必须包含" /><input value={brief.mustAvoid} onChange={event => updateBrief('mustAvoid', event.target.value)} className="rounded-lg border border-default bg-surface px-3 py-2 text-sm text-primary" placeholder="禁止出现" /></div></Field><Field label="补充要求"><textarea value={brief.extraRequirement} onChange={event => updateBrief('extraRequirement', event.target.value)} className="mt-1.5 min-h-20 w-full rounded-lg border border-default bg-surface px-3 py-2 text-sm text-primary" /></Field></div></details>
        <div className="flex flex-wrap gap-2"><InlineButton tone="primary" onClick={() => generateScript(false)} disabled={busy}>{busy ? '处理中…' : '生成混剪文案'}</InlineButton>{script ? <InlineButton onClick={() => generateScript(true)} disabled={busy}>按意见重写</InlineButton> : null}</div>
        {script ? <div className="rounded-xl border border-subtle bg-surface-overlay p-4"><div className="font-medium text-primary">{text(script?.structure?.title) || '文案成稿'}</div><div className={`mt-1 text-xs ${TEXT.secondary}`}>行业：{text(script?.selectedSkill?.name) || '自动选择'}{script?.qualityReview?.score ? ` · 质量评分 ${script.qualityReview.score}/100` : ''}</div><textarea value={text(script.content)} onChange={event => setScript(current => ({ ...current, content: event.target.value }))} className="mt-3 min-h-44 w-full rounded-lg border border-default bg-surface px-3 py-2 text-sm text-primary" /><textarea value={scriptInstruction} onChange={event => setScriptInstruction(event.target.value)} className="mt-3 min-h-20 w-full rounded-lg border border-default bg-surface px-3 py-2 text-sm text-primary" placeholder="修改意见，例如：开场更有吸引力，加上团购福利" /></div> : null}
      </section>
      {creationStep !== 'brief' ? <aside className="space-y-4 rounded-2xl border border-subtle bg-surface p-5">
        {creationStep === 'voice' ? <><div><h3 className="text-base font-semibold text-primary">2. 选择旁白音色</h3><p className={`mt-1 text-sm ${TEXT.secondary}`}>确认文案后选择音色；旁白会在最后制作时生成。</p></div><Field label="旁白音色" hint={voices.length ? `已加载 ${voices.length} 个音色` : (voiceLoadError || '请重新加载音色')}><div className="mt-1.5 flex gap-2"><select value={voiceId} onChange={event => setVoiceId(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-default bg-surface-overlay px-3 py-2 text-sm text-primary"><option value="">选择音色</option>{voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select><InlineButton onClick={() => loadVoices()} disabled={busy}>重新加载</InlineButton></div></Field><InlineButton tone="primary" onClick={() => setCreationStep('material')} disabled={!voiceId}>确认音色，选择素材</InlineButton></> : null}
        {creationStep === 'material' ? <><div><h3 className="text-base font-semibold text-primary">3. 选择素材集合并选片</h3><p className={`mt-1 text-sm ${TEXT.secondary}`}>只选择集合，云端服务会从集合内随机推荐片段。</p></div><div className="rounded-xl border border-subtle bg-surface-overlay p-3"><div className="flex items-start justify-between gap-2"><div className="text-sm font-medium text-primary">视频素材集合</div><InlineButton onClick={() => setTab('materials')}>管理集合</InlineButton></div><select value={selectedCollectionId} onChange={event => setSelectedCollectionId(event.target.value)} className="mt-3 w-full rounded-lg border border-default bg-surface px-3 py-2 text-sm text-primary"><option value="">选择素材集合</option>{collections.map(collection => <option key={collection.id} value={collection.id}>{collection.name}{collection.assetCount ? ` · ${collection.assetCount} 个素材` : ''}</option>)}</select>{selectedCollection ? <p className={`mt-2 text-xs ${TEXT.secondary}`}>「{selectedCollection.name}」共 {selectedAssets.length} 个视频素材</p> : null}</div><InlineButton onClick={generatePlan} disabled={busy || !selectedCollectionId || !selectedAssets.length}>{busy ? '处理中…' : clips.length ? '重新随机推荐片段' : '生成随机片段方案'}</InlineButton>{clips.length ? <><div className={`text-sm ${TEXT.secondary}`}>已生成 {clips.length} 个云端片段方案，可在下一步制作。</div><InlineButton tone="primary" onClick={() => setCreationStep('production')}>确认片段方案</InlineButton></> : <EmptyState>选择素材集合后生成随机片段方案。</EmptyState>}</> : null}
        {creationStep === 'production' ? <><div><h3 className="text-base font-semibold text-primary">4. 开始云端制作</h3><p className={`mt-1 text-sm ${TEXT.secondary}`}>云端将生成旁白、拼接片段，并自动生成字幕成片。</p></div><div className="rounded-xl border border-subtle bg-surface-overlay p-3 text-sm text-secondary">音色：{selectedVoice?.name || voiceId}<br />素材集合：{selectedCollection?.name || '未选择'}<br />片段方案：{clips.length} 个</div><InlineButton tone="primary" onClick={createMasterJob} disabled={busy || !clips.length}>{busy ? '处理中…' : '开始云端制作'}</InlineButton>{finalJob?.videoUrl ? <a className="block rounded-lg bg-success-surface px-3 py-2 text-sm text-success-text hover:underline" href={finalJob.videoUrl} target="_blank" rel="noreferrer">打开字幕成片</a> : null}</> : null}
      </aside> : null}
    </div> : null}

    {tab === 'materials' ? <section className="rounded-2xl border border-subtle bg-surface p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-base font-semibold text-primary">素材集合</h3><p className={`mt-1 text-sm ${TEXT.secondary}`}>上传的视频归入一个集合；创作时只选择集合，不逐个勾选素材。</p></div><InlineButton onClick={createCollection} disabled={busy}>新建集合</InlineButton></div><div className="mt-4 flex gap-2"><select value={selectedCollectionId} onChange={event => setSelectedCollectionId(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-default bg-surface px-3 py-2 text-sm text-primary"><option value="">选择素材集合</option>{collections.map(collection => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select><input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" multiple className="hidden" onChange={event => { uploadFiles(event.target.files); event.target.value = '' }} /><button type="button" className={ACTION.primary} disabled={uploading || !selectedCollectionId} onClick={() => inputRef.current?.click()}>{uploading ? '上传中…' : '上传视频'}</button></div><div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{assets.map(asset => <div key={asset.id} className="rounded-xl border border-subtle bg-surface-overlay p-3"><span className="block truncate text-sm font-medium text-primary">{asset.name}</span><span className={`mt-1 block text-xs ${TEXT.secondary}`}>{formatFileSize(asset.size)}{asset.duration ? ` · ${Math.round(asset.duration)}s` : ''}</span></div>)}</div>{selectedCollectionId && !assets.length ? <div className="mt-5"><EmptyState>当前集合暂无素材，上传视频后即可开始选片。</EmptyState></div> : null}</section> : null}

    {tab === 'works' ? <section className="rounded-2xl border border-subtle bg-surface p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-base font-semibold text-primary">作品</h3><p className={`mt-1 text-sm ${TEXT.secondary}`}>已完成的云端混剪母版和字幕成片会自动归入这里，可在桌面端直接播放预览。</p></div><InlineButton onClick={() => loadJobs()} disabled={busy}>刷新作品</InlineButton></div>{completedWorks.length ? <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{completedWorks.map(job => <article key={job.id} className="overflow-hidden rounded-xl border border-subtle bg-surface-overlay"><div className="flex h-36 items-center justify-center bg-surface-sunken text-3xl" aria-hidden="true">{job.type === 'video-caption' ? '▣' : '▶'}</div><div className="space-y-2 p-3"><div className="truncate text-sm font-medium text-primary">{job.title}</div><div className={`text-xs ${TEXT.secondary}`}>{job.type === 'video-caption' ? '字幕成片' : '混剪母版'} · 已完成</div><div className="flex flex-wrap gap-2"><InlineButton tone="primary" onClick={() => setPreviewJob(job)}>播放预览</InlineButton><a className="inline-flex h-8 items-center rounded-lg px-1 text-xs text-accent-text hover:underline" href={job.videoUrl} target="_blank" rel="noreferrer">在浏览器打开</a></div></div></article>)}</div> : <div className="mt-5"><EmptyState>完成云端制作后，混剪母版和字幕成片会自动出现在这里。</EmptyState></div>}</section> : null}

    {tab === 'tasks' ? <section className="rounded-2xl border border-subtle bg-surface p-5"><div className="flex items-center justify-between"><div><h3 className="text-base font-semibold text-primary">云端混剪任务</h3><p className={`mt-1 text-sm ${TEXT.secondary}`}>母版完成后自动提交字幕任务；任务与成片均来自 video-clips 云端服务。</p></div><InlineButton onClick={() => loadJobs()} disabled={busy}>刷新任务</InlineButton></div><div className="mt-5 space-y-3">{jobs.map(job => <article key={job.id} className="flex flex-col gap-3 rounded-xl border border-subtle bg-surface-overlay p-4 md:flex-row md:items-center md:justify-between"><div className="min-w-0"><div className="truncate font-medium text-primary">{job.title}</div><div className={`mt-1 text-sm ${job.status === 'failed' || job.status === 'manual_review' ? 'text-danger-text' : TEXT.secondary}`}>{job.type === 'video-caption' ? '字幕成片 · ' : '混剪母版 · '}{jobStatus(job.status)}{job.stage ? ` · ${job.stage}` : ''}{job.progress ? ` · ${job.progress}%` : ''}{job.error ? ` · ${job.error}` : ''}</div>{job.videoUrl ? <a className="mt-2 inline-block text-sm text-accent-text hover:underline" href={job.videoUrl} target="_blank" rel="noreferrer">打开视频</a> : null}</div><div className="flex shrink-0 gap-2">{job.status === 'manual_review' || job.status === 'failed' ? <InlineButton onClick={() => retryJob(job)} disabled={busy}>重试</InlineButton> : null}{job.type === 'montage' && job.status === 'running' ? <InlineButton onClick={() => refreshJob(job)} disabled={busy}>刷新进度</InlineButton> : null}{ACTIVE_STATUSES.has(job.status) ? <InlineButton tone="danger" onClick={() => cancelJob(job)} disabled={busy}>取消</InlineButton> : null}</div></article>)}</div>{!jobs.length ? <div className="mt-5"><EmptyState>还没有云端智能混剪任务。</EmptyState></div> : null}</section> : null}

    {tab === 'tasks' && jobs.some(job => job.type === 'montage' && job.audioUrl) ? <section className="mt-5 rounded-2xl border border-subtle bg-surface p-5"><h3 className="text-base font-semibold text-primary">旁白音频素材</h3><p className={`mt-1 text-sm ${TEXT.secondary}`}>这是本次云端混剪制作时由 MiniMax 生成并保存的旁白。</p><div className="mt-4 space-y-3">{jobs.filter(job => job.type === 'montage' && job.audioUrl).map(job => <div key={`audio-${job.id}`} className="rounded-xl border border-subtle bg-surface-overlay p-3"><div className="mb-2 text-sm font-medium text-primary">{job.title}</div><audio className="w-full" controls preload="metadata" src={job.audioUrl}>当前环境不支持音频播放。</audio></div>)}</div></section> : null}

    <Modal
      open={Boolean(previewJob)}
      onClose={() => setPreviewJob(null)}
      title={previewJob?.title || '作品预览'}
      description={previewJob?.type === 'video-caption' ? '字幕成片' : '混剪母版'}
      size="2xl"
      footer={<div className="flex justify-end gap-2"><a className={ACTION.secondary} href={previewJob?.videoUrl} target="_blank" rel="noreferrer">在浏览器打开</a><button type="button" className={ACTION.secondary} onClick={() => setPreviewJob(null)}>关闭</button></div>}
    >
      {previewJob?.videoUrl ? <video key={previewJob.id} src={previewJob.videoUrl} controls autoPlay className="max-h-[60vh] w-full rounded-lg bg-surface-sunken" /> : <EmptyState>这个作品暂时没有可播放的视频文件。</EmptyState>}
    </Modal>
  </div>
}
