import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

test('Apps exposes the smart montage card and route', () => {
  const appsSource = read('src/pages/Apps.jsx')
  const routerSource = read('src/App.jsx')

  assert.match(appsSource, /title: '智能混剪'/)
  assert.match(appsSource, /to: '\/apps\/montage'/)
  assert.match(routerSource, /path="\/apps\/montage" element=\{<MontageApp \/>\}/)
})

test('MontageApp uses the mini-program montage backend for material collections', () => {
  const pageSource = read('src/pages/apps/MontageApp.jsx')

  assert.match(pageSource, /uploadOperatorAsset/)
  assert.match(pageSource, /callMedia\('operator_get_media_download_url'/)
  assert.match(pageSource, /smartMontageFuncs/)
  assert.match(pageSource, /generateScript/)
  assert.match(pageSource, /copyType: 'smart-montage'/)
  assert.match(pageSource, /requirement,/)
  assert.match(pageSource, /planMontage/)
  assert.match(pageSource, /createJob/)
  assert.match(pageSource, /MAX_MONTAGE_ASSET_BYTES/)
  assert.match(pageSource, /callMontage/)
  assert.match(pageSource, /'list_collections'/)
  assert.match(pageSource, /'list_assets'/)
  assert.match(pageSource, /'create_asset'/)
})

test('MontageApp follows the mini-program brand brief and two-stage production flow', () => {
  const pageSource = read('src/pages/apps/MontageApp.jsx')

  assert.match(pageSource, /callSupabaseFunction\('organization-stores', \{ action: 'list_brands'/)
  assert.match(pageSource, /label="店铺名"/)
  assert.match(pageSource, /label="行业类型"/)
  assert.match(pageSource, /brandId/)
  assert.match(pageSource, /targetDurationSeconds: duration/)
  assert.match(pageSource, /type: 'video-caption'/)
  assert.match(pageSource, /desktop-smart-montage-caption/)
  assert.match(pageSource, /captionIdempotencyKey\(master\.id, captionRequest\)/)
  assert.match(pageSource, /stableRequestHash/)
})

test('MontageApp loads voices when a script becomes available, matching the mini-program voice step', () => {
  const pageSource = read('src/pages/apps/MontageApp.jsx')

  assert.match(pageSource, /await loadVoices\(\{ silent: true, withBusy: false \}\)/)
  assert.match(pageSource, /已加载 \$\{voiceResult\.voices\.length\} 个音色/)
  assert.match(pageSource, /重新加载音色/)
})

test('MontageApp mirrors the mini-program narration and material handoff', () => {
  const pageSource = read('src/pages/apps/MontageApp.jsx')

  assert.match(pageSource, /开始云端制作/)
  assert.match(pageSource, /云端将生成旁白/)
  assert.match(pageSource, /视频素材集合/)
  assert.match(pageSource, /管理集合/)
  assert.match(pageSource, /旁白音频素材/)
  assert.match(pageSource, /narrationUrl/)
  assert.match(pageSource, /creationStep/)
  assert.match(pageSource, /确认音色，选择素材/)
  assert.match(pageSource, /确认片段方案/)
})

test('MontageApp keeps completed videos in a parallel works tab with in-app playback', () => {
  const pageSource = read('src/pages/apps/MontageApp.jsx')

  assert.match(pageSource, /key: 'works', label: '作品'/)
  assert.match(pageSource, /completedWorks/)
  assert.match(pageSource, /播放预览/)
  assert.match(pageSource, /<Modal/)
  assert.match(pageSource, /<video key=\{previewJob\.id\}/)
  assert.match(pageSource, /完成作品会归入「作品」/)
})

test('Desktop Tauri HTTP scope permits every Smart Montage funcs origin', () => {
  const capabilities = JSON.parse(read('src-tauri/capabilities/default.json'))
  const httpScope = capabilities.permissions.find(item => item?.identifier === 'http:default')
  const allowedUrls = httpScope?.allow?.map(rule => rule.url) || []

  assert.ok(allowedUrls.includes('https://uniopc-ywriting-apoxivoeyq.cn-hangzhou.fcapp.run/**'))
  assert.ok(allowedUrls.includes('https://uniopc-eo-clips-aiwlkdpyyi.cn-hangzhou.fcapp.run/**'))
  assert.ok(allowedUrls.includes('https://uniopc-ips-prod-dscgwuprhl.cn-hangzhou.fcapp.run/**'))
})

test('MontageApp delegates rendering to video-clips rather than a local renderer', () => {
  const pageSource = read('src/pages/apps/MontageApp.jsx')

  assert.doesNotMatch(pageSource, /produce_video/)
  assert.doesNotMatch(pageSource, /FFmpeg/)
  assert.match(pageSource, /type: 'montage'/)
  assert.match(pageSource, /desktop-smart-montage/)
})

test('MontageApp keeps upload limits and polls only an active job', () => {
  const pageSource = read('src/pages/apps/MontageApp.jsx')

  assert.match(pageSource, /montageFileError/)
  assert.match(pageSource, /MAX_MONTAGE_ASSET_BYTES/)
  assert.match(pageSource, /window\.setInterval\(\(\) => loadJobs/)
  assert.match(pageSource, /disabled=\{uploading \|\| !selectedCollectionId\}/)
  assert.match(pageSource, /typeof error === 'string'/)

  const backendSource = read('src/lib/appsBackend.js')
  assert.match(backendSource, /byteSize: Number\(file\?\.size \|\| body\.byteLength\)/)
})
