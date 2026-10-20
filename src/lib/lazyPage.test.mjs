import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { lazyPage } from './lazyPage.js'

test('optional page code loads on first render, leaving its surrounding shell visible', async () => {
  let calls = 0
  let resolvePage
  const pending = new Promise(resolve => { resolvePage = resolve })
  const Page = lazyPage(() => { calls++; return pending })
  assert.equal(calls, 0)
  const render = () => renderToString(createElement('main', null,
    createElement('nav', null, 'Workspace navigation'), createElement(Page, { label: 'Documents' })))
  const loading = render()
  assert.equal(calls, 1)
  assert.match(loading, /Workspace navigation/)
  assert.match(loading, /正在加载页面/)
  resolvePage({ default: ({ label }) => createElement('section', null, label) })
  await new Promise(resolve => setImmediate(resolve))
  const loaded = render()
  assert.equal(calls, 1)
  assert.match(loaded, /Workspace navigation/)
  assert.match(loaded, /<section>Documents<\/section>/)
  assert.doesNotMatch(loaded, /正在加载页面/)
})

test('the App route tree keeps only login and conversations in its eager page imports', async () => {
  const { readFile } = await import('node:fs/promises')
  const { parse } = await import('@babel/parser')
  const source = await readFile(new URL('../App.jsx', import.meta.url), 'utf8')
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] })
  const eagerPages = ast.program.body
    .filter(node => node.type === 'ImportDeclaration' && node.source.value.startsWith('./pages/'))
    .map(node => node.source.value)
    .sort()
  assert.deepEqual(eagerPages, ['./pages/Conversations', './pages/Login'])
})
