import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('minimize keeps the voice panel mounted and shows a bottom-right control', () => {
  const source = read('src/components/VoiceToDocumentPanel.jsx')

  assert.match(source, /function VoiceToDocumentPanel\(\{ memberNames = \[\], onCancel, onComplete, minimized = false, onMinimize, onExpand \}\)/)
  const minimizedStart = source.indexOf('{minimized &&')
  assert.ok(minimizedStart >= 0, 'the panel must render a compact branch while minimized')
  const expandedStart = source.indexOf('{!minimized &&', minimizedStart)
  assert.ok(expandedStart > minimizedStart, 'the full panel must remain a sibling branch')
  const minimizedBranch = source.slice(minimizedStart, expandedStart)

  assert.match(source, /onMinimize/)
  assert.match(minimizedBranch, /fixed bottom-5 right-5/)
  assert.match(minimizedBranch, /onClick=\{onExpand\}/)
  assert.match(minimizedBranch, /formatRecordingClock\(elapsedMs\)/)
  assert.match(minimizedBranch, /<button[\s\S]*?onClick=\{handleStopRecording\}[\s\S]*?>[\s\S]*?结束并转写/)
  assert.match(source, /recording \|\| recordedRef\.current\?\.blob\?\.size \|\| busy/)
  assert.match(source, /recording \|\| step === STEP\.working \|\| step === STEP\.retry \|\| step === STEP\.speakers/)
})

test('completion stays busy until document persistence finishes and reports persistence errors', () => {
  const source = read('src/components/VoiceToDocumentPanel.jsx')

  assert.equal((source.match(/await onComplete\?\.\(/g) || []).length, 2)
  assert.match(source, /await onComplete\?\.\(\{ markdown: finished\.markdown/)
  assert.match(source, /await onComplete\?\.\(\{ markdown: named\.markdown/)
})

test('录音面板只产出 markdown,落库交给 CloudDocuments 的既有路径', () => {
  const source = read('src/components/VoiceToDocumentPanel.jsx')

  // 面板自己建文档 = 绕开项目归属/访问权限/保存逻辑,那些必须只有一份实现。
  assert.equal(source.includes('createCloudDocument'), false)
  assert.equal(source.includes('createCloudCrdtDocumentFromMarkdown'), false)
  assert.match(source, /onComplete\?\.\(\{ markdown: [\s\S]*?title: documentTitleFromTranscript/)
})

test('面板卸载后停掉录音、字幕和轮询,不对着已卸载组件 setState', () => {
  const source = read('src/components/VoiceToDocumentPanel.jsx')

  assert.match(source, /disposedRef\.current = true/)
  assert.match(source, /recorderRef\.current\?\.cancel\?\.\(\)/)
  // 轮询的中断闸必须接在同一个 ref 上。
  assert.match(source, /shouldStop: \(\) => disposedRef\.current/)
})

test('macOS 实时字幕是纯加分项,起不来必须静默降级而不是打断录音', () => {
  const source = read('src/components/VoiceToDocumentPanel.jsx')

  // native_voice_input 在 Windows、未签名的 dev 二进制、无权限时都会 reject。
  // 这三处调用一个都不能把异常抛进录音主流程。
  assert.match(source, /invoke\('native_voice_input_start', \{ locale: 'zh-CN' \}\)[\s\S]*?\.catch\(\(\) => \{\}\)/)
  assert.match(source, /invoke\('native_voice_input_stop'\)\.catch\(\(\) => \{\}\)/)
  assert.match(source, /invoke\('native_voice_input_cancel'\)\.catch\(\(\) => \{\}\)/)
})

test('上传失败不丢录音 —— 音频留在 ref 里可原样重试', () => {
  const source = read('src/components/VoiceToDocumentPanel.jsx')

  // 真机事故:用户录了 1:00:10,上传时 token 过期,而当时 blob 只是
  // handleStopRecording 的局部变量,函数一返回音频就没了。
  assert.match(source, /const recordedRef = useRef\(null\)/)
  assert.match(source, /async function runTranscriptionPipeline/)
  assert.match(source, /retry: 'retry'/)

  // catch 分支绝不能清 recordedRef,否则重试按钮无音频可传。
  const catchBlock = source.slice(source.indexOf('} catch (err) {', source.indexOf('runTranscriptionPipeline')))
  const nextBrace = catchBlock.indexOf('setStep(STEP.retry)')
  assert.ok(nextBrace > 0, '重试态没有接上')
  assert.equal(catchBlock.slice(0, nextBrace).includes('recordedRef.current = null'), false)

  // 关面板前要拦一下,别让用户手滑丢掉未上传的录音。
  assert.match(source, /还有一段未上传的录音/)
})

test('长录音前先续期令牌 —— access token 默认只有一小时', () => {
  const source = read('src/lib/voiceTranscription.js')
  assert.match(source, /export async function freshAccessToken/)
  assert.match(source, /refreshSession\(\)/)
  // 每次调用都走这条路,不能有绕过续期直接取 token 的分支。
  assert.equal(source.includes('sessionData?.session?.access_token'), false)
})

test('音频上传走认证直传 —— 禁止改回签名上传 URL', () => {
  const source = read('src/lib/voiceTranscription.js')

  // 负向护栏:opentrust 的签名上传 token 只有 60 秒有效期(expiresIn 也被无视),
  // 网关收完整个请求体才校验,长录音必被判过期。2026-07-28 真机 163MB/79s 实锤。
  assert.equal(source.includes('uploadToSignedUrl'), false)
  assert.match(source, /\.upload\(storagePath, blob/)
  // 上传前必须把会话续到足够长,令牌要活过整个传输过程。
  assert.match(source, /UPLOAD_SESSION_MARGIN_SECONDS/)
  assert.match(source, /freshAccessToken\(client, UPLOAD_SESSION_MARGIN_SECONDS\)/)
})

test('重试上传先清掉上一轮报错,不让旧错误和进度同屏', () => {
  const source = read('src/components/VoiceToDocumentPanel.jsx')
  const pipeline = source.slice(
    source.indexOf('async function runTranscriptionPipeline'),
    source.indexOf('createTranscriptionUpload', source.indexOf('async function runTranscriptionPipeline')),
  )
  assert.ok(pipeline.includes("setError('')"), '重试进入 pipeline 时必须先 setError(\'\')')
})

test('没识别到说话人时跳过贴名字,不给用户一个空表单', () => {
  const source = read('src/components/VoiceToDocumentPanel.jsx')
  assert.match(source, /if \(\(finished\.speakers \|\| \[\]\)\.length === 0\)/)
})

test('录音层把单声道约束和格式探测都收在 lib 里', () => {
  const source = read('src/lib/audioRecorder.js')

  // 说话人分离只支持单声道 —— 改这里等于把整条链路打死,负向护栏钉住。
  assert.match(source, /channelCount: 1/)
  // 两个平台的容器不一样,必须探测不能写死:macOS 只能 mp4,Windows 是 webm。
  assert.match(source, /'audio\/webm;codecs=opus'/)
  assert.match(source, /'audio\/mp4'/)
  assert.match(source, /export function pickRecorderMimeType/)
})

test('转写客户端不 import supabase 单例,client 由调用方传入', () => {
  const source = read('src/lib/voiceTranscription.js')

  // 顶层 import 单例会让 node --test 一加载就撞 import.meta.env,
  // 也不符合 cloudDocuments.js 的既有约定。
  assert.equal(/^import .*from '\.\/supabase'/m.test(source), false)
  assert.match(source, /export async function callTranscribe\(client, action/)
  assert.match(source, /export async function waitForTranscription\(jobId, options/)
})
