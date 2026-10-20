import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { managedRuntimeFileKind, rebrandManagedModuleSpecifiers, rebrandManagedRuntimeScopes } from './uniopc-runtime-scopes.mjs'

test('changes only module syntax, including dynamic imports, require and declaration imports', () => {
  const source = `import x from '@openclaw/ai/transports'; export * from '@openclaw/ai/internal/runtime';
const dynamic = import('@openclaw/fs-safe/temp'); const cjs = require('@openclaw/proxyline');
const inline = moduleNamespace.createRequire(import.meta.url)('@openclaw/fs-safe/temp');
const p = require.resolve('@openclaw/ai'); type T = import('@openclaw/ai').T;
const protocol = Symbol.for('@openclaw/proxyline.dispatcher'); const message = '@openclaw/ai';
// import('@openclaw/ai')
const other = import('@openclaw/custom'); const pathValue = path.resolve('@openclaw/ai');`
  const after = rebrandManagedModuleSpecifiers(source)
  for (const name of ['ai/transports', 'ai/internal/runtime', 'fs-safe/temp', 'proxyline']) assert.ok(after.includes(`"@uniopc/${name}"`))
  assert.ok(after.includes('createRequire(import.meta.url)("@uniopc/fs-safe/temp")'))
  assert.match(after, /require\.resolve\("@uniopc\/ai"\)/)
  assert.match(after, /type T = import\("@uniopc\/ai"\)/)
  assert.ok(after.includes("Symbol.for('@openclaw/proxyline.dispatcher')"))
  assert.ok(after.includes("const message = '@openclaw/ai'"))
  assert.ok(after.includes("// import('@openclaw/ai')"))
  assert.ok(after.includes("import('@openclaw/custom')"))
  assert.ok(after.includes("path.resolve('@openclaw/ai')"))
  assert.equal(rebrandManagedModuleSpecifiers(after), after)
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-scope-test-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@openclaw/ai': '2026.8.1' }, description: 'Attribution OpenClaw', openclaw: { protocol: true } }))
  for (const name of ['ai', 'fs-safe', 'proxyline']) {
    const directory = join(root, 'node_modules', '@openclaw', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@openclaw/${name}`, type: 'module', exports: { '.': './index.js', './self': './self.js' } }))
    await writeFile(join(directory, 'index.js'), `export const value = ${JSON.stringify(name)};`)
    await writeFile(join(directory, 'self.js'), `export {value} from '@openclaw/${name}';`)
  }
  await writeFile(join(root, 'run.mjs'), `import {value} from '@openclaw/ai/self'; console.log(value, (await import('@openclaw/fs-safe')).value, (await import('@openclaw/proxyline')).value)`)
  return root
}

test('managed tree uses branded paths, keeps npm registry aliases and resolves self exports in real Node', async () => {
  const root = await fixture()
  try {
    const result = await rebrandManagedRuntimeScopes(root)
    assert.equal(result.renamed, 3)
    assert.ok(!(await readdir(join(root, 'node_modules'))).includes('@openclaw'))
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dependencies, { '@uniopc/ai': 'npm:@openclaw/ai@2026.8.1' })
    assert.equal(manifest.description, 'Attribution OpenClaw')
    assert.deepEqual(manifest.openclaw, { protocol: true })
    assert.equal(execFileSync(process.execPath, [join(root, 'run.mjs')], { encoding: 'utf8' }).trim(), 'ai fs-safe proxyline')
    assert.deepEqual(await rebrandManagedRuntimeScopes(root), { renamed: 0, patched: 0 })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('collision rejects the whole staging transform before any writes', async () => {
  const root = await fixture()
  try {
    const before = await readFile(join(root, 'run.mjs'), 'utf8')
    await mkdir(join(root, 'node_modules', '@uniopc', 'ai'), { recursive: true })
    await assert.rejects(rebrandManagedRuntimeScopes(root), /collision/)
    assert.equal(await readFile(join(root, 'run.mjs'), 'utf8'), before)
    assert.ok((await readdir(join(root, 'node_modules', '@openclaw'))).includes('ai'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('unknown scope entries and symlink scope roots fail closed', async () => {
  const root = await fixture()
  try {
    await mkdir(join(root, 'node_modules', '@openclaw', 'custom'))
    await assert.rejects(rebrandManagedRuntimeScopes(root), /Unsupported managed runtime scope/)
    await rm(join(root, 'node_modules', '@openclaw'), { recursive: true })
    await symlink('/tmp', join(root, 'node_modules', '@openclaw'))
    await assert.rejects(rebrandManagedRuntimeScopes(root), /symlink/)
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('package dependency collision also leaves staged files untouched', async () => {
  const root = await fixture()
  try {
    const path = join(root, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.dependencies['@uniopc/ai'] = '1.0.0'
    await writeFile(path, JSON.stringify(manifest))
    const before = await readFile(path, 'utf8')
    await assert.rejects(rebrandManagedRuntimeScopes(root), /dependency rename collision/)
    assert.equal(await readFile(path, 'utf8'), before)
    assert.ok((await readdir(join(root, 'node_modules', '@openclaw'))).includes('ai'))
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('Windows and POSIX paths select identical metadata/module conversion branches', () => {
  for (const root of ['C:\\Uniopc\\runtime\\node_modules', '/Uniopc/runtime/node_modules']) {
    const sep = root.includes('\\') ? '\\' : '/'
    for (const file of ['package.json', `@uniopc${sep}ai${sep}package.json`]) {
      assert.equal(managedRuntimeFileKind(`${root}${sep}${file}`), 'package')
    }
    assert.equal(managedRuntimeFileKind(`${root}${sep}module.d.mts`), 'module')
    assert.equal(managedRuntimeFileKind(`${root}${sep}package.json.backup`), null)
    const filename = `${root}${sep}plugin-module-loader-cache-HASH.js`
    assert.equal(rebrandManagedModuleSpecifiers('const x = {packageName: "@openclaw/ai"}', filename), 'const x = {packageName: "@uniopc/ai"}')
  }
})
