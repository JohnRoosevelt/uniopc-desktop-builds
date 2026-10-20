import assert from 'node:assert/strict'
import test from 'node:test'

const modulePath = new URL('./appUpdateTitlebar.js', import.meta.url)

test('titlebar app update view model shows current version when no update is available', async () => {
  const { titlebarAppUpdateViewModel } = await import(modulePath)

  assert.deepEqual(
    titlebarAppUpdateViewModel({
      currentVersion: '0.1.7',
      latestVersion: '0.1.7',
      available: false,
      busy: false,
      installed: false,
    }),
    {
      kind: 'version',
      label: 'v0.1.7',
      actionable: false,
      disabled: false,
    },
  )
})

test('titlebar app update view model shows update action when a newer version exists', async () => {
  const { titlebarAppUpdateViewModel } = await import(modulePath)

  assert.deepEqual(
    titlebarAppUpdateViewModel({
      currentVersion: '0.1.7',
      latestVersion: '0.1.8',
      available: true,
      busy: false,
      installed: false,
    }),
    {
      kind: 'update',
      label: '更新',
      actionable: true,
      disabled: false,
    },
  )
})

test('titlebar app update view model shows updating while install is running', async () => {
  const { titlebarAppUpdateViewModel } = await import(modulePath)

  assert.deepEqual(
    titlebarAppUpdateViewModel({
      currentVersion: '0.1.7',
      latestVersion: '0.1.8',
      available: true,
      busy: true,
      installed: false,
    }),
    {
      kind: 'update',
      label: '更新中...',
      actionable: true,
      disabled: true,
    },
  )
})

test('titlebar app update view model switches to automatic relaunch after install', async () => {
  const { titlebarAppUpdateViewModel } = await import(modulePath)

  assert.deepEqual(
    titlebarAppUpdateViewModel({
      currentVersion: '0.1.7',
      latestVersion: '0.1.8',
      available: true,
      busy: false,
      installed: true,
    }),
    {
      kind: 'restarting',
      label: '重启中...',
      actionable: false,
      disabled: true,
    },
  )
})
