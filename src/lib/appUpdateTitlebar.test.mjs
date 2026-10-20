import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppUpdateController, titlebarAppUpdateViewModel } from './appUpdateTitlebar.js'

const newer = { currentVersion: '0.4.19', available: true, update: { version: '0.4.20' } }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function setup(overrides = {}) {
  let state
  const controller = createAppUpdateController({
    check: async () => newer, install: async () => {}, relaunch: async () => {},
    isNewer: (a, b) => a > b, onChange: value => { state = value }, ...overrides,
  })
  return { controller, state: () => state }
}

test('control is visible before version loads and always offers manual checking', () => {
  assert.equal(titlebarAppUpdateViewModel().label, '检查更新')
  assert.equal(titlebarAppUpdateViewModel({ currentVersion: '0.4.20' }).label, 'v0.4.20 · 检查更新')
  assert.equal(titlebarAppUpdateViewModel({ phase: 'checking' }).disabled, true)
  assert.equal(titlebarAppUpdateViewModel({ phase: 'installed' }).label, '重启完成更新')
})

test('manual, focus and timer checks share a synchronous guard; disposed results are ignored', async () => {
  const pending = deferred()
  let checks = 0
  const { controller, state } = setup({ check: () => { checks++; return pending.promise } })
  const first = controller.refresh()
  await controller.click()
  await controller.refresh()
  assert.equal(checks, 1)
  controller.dispose()
  pending.resolve(newer)
  await first
  assert.equal(state().phase, 'checking')
  controller.setVersion('stale')
  assert.equal(state().currentVersion, '')
})

test('native check errors remain visible even when metadata reports a newer version; retry recovers', async () => {
  let calls = 0
  const { controller, state } = setup({ check: async () => ++calls === 1
    ? { ...newer, update: null, pendingPublication: true, updateCheckError: 'offline' }
    : { currentVersion: '0.4.20', available: false } })
  await controller.refresh()
  assert.equal(state().phase, 'error')
  assert.equal(state().available, false)
  assert.match(state().error, /offline/)
  await controller.click()
  assert.equal(state().phase, 'latest')
})

test('metadata alone, equal and older native versions never install', async () => {
  for (const value of [{ ...newer, update: null }, { ...newer, update: { version: '0.4.19' } }, { ...newer, update: { version: '0.4.18' } }]) {
    let installs = 0
    const { controller, state } = setup({ check: async () => value, install: async () => installs++ })
    await controller.refresh()
    await controller.click()
    await controller.confirm()
    assert.equal(state().available, false)
    assert.equal(installs, 0)
  }
})

test('cancel does not install; double confirmation and automatic checks cannot compete with install', async () => {
  const pending = deferred()
  let installs = 0
  let checks = 0
  let onEvent
  const { controller, state } = setup({
    check: async () => { checks++; return newer },
    install: async (_, event) => { installs++; onEvent = event; await pending.promise },
  })
  await controller.refresh()
  await controller.click()
  controller.cancel()
  await controller.confirm()
  assert.equal(installs, 0)
  await controller.click()
  const first = controller.confirm()
  await controller.confirm()
  await controller.refresh()
  await controller.click()
  assert.equal(installs, 1)
  assert.equal(checks, 1)
  onEvent({ event: 'Started', data: {} })
  onEvent({ event: 'Progress', data: { chunkLength: 100 } })
  assert.equal(state().progress.includes('%'), false)
  onEvent({ event: 'Started', data: { contentLength: 200 } })
  onEvent({ event: 'Progress', data: { chunkLength: 100 } })
  assert.match(state().progress, /50%/)
  onEvent({ event: 'Finished' })
  assert.equal(state().phase, 'installing')
  pending.resolve()
  await first
  assert.equal(state().phase, 'restarting')
})

test('install failure can retry, while relaunch failure retries only relaunch', async () => {
  let installs = 0
  let restarts = 0
  const { controller, state } = setup({
    install: async () => { if (++installs === 1) throw Error('download failed') },
    relaunch: async () => { if (++restarts === 1) throw Error('restart failed') },
  })
  await controller.refresh()
  await controller.click()
  await controller.confirm()
  assert.equal(state().phase, 'installError')
  assert.match(state().error, /download failed/)
  await controller.click()
  await controller.confirm()
  assert.equal(state().phase, 'installed')
  assert.match(state().error, /restart failed/)
  await controller.refresh()
  await controller.click()
  assert.equal(installs, 2)
  assert.equal(restarts, 2)
})

test('pending publication stays visible and a disposed install does not relaunch', async () => {
  const pending = deferred()
  let restarts = 0
  const { controller, state } = setup({ install: () => pending.promise, relaunch: async () => restarts++ })
  await controller.refresh()
  await controller.click()
  const install = controller.confirm()
  controller.dispose()
  pending.resolve()
  await install
  assert.equal(restarts, 0)
  const publication = setup({ check: async () => ({ currentVersion: '0.4.19', pendingPublication: true }) })
  await publication.controller.refresh()
  assert.equal(publication.state().phase, 'pending')
  assert.match(titlebarAppUpdateViewModel(publication.state()).label, /发布中/)
})
