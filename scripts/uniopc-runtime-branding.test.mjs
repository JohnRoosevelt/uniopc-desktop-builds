import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { rebrandEngineWrapperContract, rebrandPluginManifestPaths, rebrandCompiledRuntimePaths, rebrandDisplayMetadata, rebrandVisibleText } from './uniopc-runtime-branding.mjs'

test('rebrands visible names while preserving derived machine identifiers', () => {
  assert.equal(rebrandVisibleText('OpenClaw OPENCLAW 小龙虾 OpenClawConfig'), 'Uniopc Uniopc Uniopc OpenClawConfig')
})

test('rebrands UI metadata fields without changing package identity or protocol fields', () => {
  assert.deepEqual(rebrandDisplayMetadata({
    name: '@openclaw/channel',
    npmSpec: '@openclaw/channel',
    description: 'OpenClaw channel plugin',
    channel: { label: 'OpenClaw Chat' },
  }), {
    name: '@openclaw/channel',
    npmSpec: '@openclaw/channel',
    description: 'Uniopc channel plugin',
    channel: { label: 'Uniopc Chat' },
  })
})

test('rebrands browser extension display name while retaining upstream technical IDs elsewhere', () => {
  assert.deepEqual(rebrandDisplayMetadata({
    name: 'OpenClaw Helper',
    description: 'OpenClaw companion',
    default_locale: 'en',
  }, { browserManifest: true }), {
    name: 'Uniopc Helper',
    description: 'Uniopc companion',
    default_locale: 'en',
  })
})

test('rebrands cached CLI help shown on startup', () => {
  assert.deepEqual(rebrandDisplayMetadata({
    rootHelpText: 'OpenClaw 2026.8.1 — All your chats, one OpenClaw.\nUsage: openclaw [options]\nDocs: https://docs.openclaw.ai',
    subcommandHelpText: { plugins: 'OpenClaw plugins\nUsage: openclaw plugins\nDocs: https://docs.openclaw.ai' },
  }), {
    rootHelpText: 'Uniopc 2026.8.1 — All your chats, one Uniopc.\nUsage: uniopc-engine [options]\nDocs: https://docs.openclaw.ai',
    subcommandHelpText: { plugins: 'Uniopc plugins\nUsage: uniopc-engine plugins\nDocs: https://docs.openclaw.ai' },
  })
})

test('renames compiled chunks and references while preserving plugin manifest names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-rebrand-chunk-test-'))
  try {
    const dist = join(root, 'dist')
    await mkdir(join(dist, 'extensions', 'demo'), { recursive: true })
    await writeFile(join(dist, 'openclaw-root-HASH.js'), 'export const ready = true')
    await writeFile(join(dist, 'entry.js'), 'import "./openclaw-root-HASH.js"; const wallpaper = "./openclaw-wallpaper.png"')
    await writeFile(join(dist, 'openclaw-wallpaper.png'), Buffer.from([137, 80, 78, 71]))
    await writeFile(join(dist, 'paths-HASH.js'), 'const suffix = uid != null ? `openclaw-${uid}` : "openclaw";')
    await writeFile(join(dist, 'extensions', 'demo', 'openclaw.plugin.json'), '{}')
    await addLifecycleFixtures(root)
    await rebrandCompiledRuntimePaths(root)
    assert.ok((await readdir(dist)).includes('uniopc-root-HASH.js'))
    assert.ok((await readdir(dist)).includes('uniopc-wallpaper.png'))
    assert.match(await readFile(join(dist, 'entry.js'), 'utf8'), /uniopc-root-HASH\.js/)
    assert.match(await readFile(join(dist, 'entry.js'), 'utf8'), /uniopc-wallpaper\.png/)
    assert.match(await readFile(join(dist, 'paths-HASH.js'), 'utf8'), /`uniopc-\$\{uid\}` : "uniopc"/)
    assert.ok((await readdir(join(dist, 'extensions', 'demo'))).includes('openclaw.plugin.json'))
    assert.deepEqual(await rebrandCompiledRuntimePaths(root), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('manifest transform supports executable discovery, legacy reads, idempotence and collision rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-manifest-contract-'))
  try {
    const dist = join(root, 'dist')
    const plugin = join(dist, 'extensions', 'demo')
    await mkdir(plugin, { recursive: true })
    await writeFile(join(plugin, 'openclaw.plugin.json'), '{"id":"demo"}')
    const loader = join(dist, 'manifest-HASH.mjs')
    await writeFile(loader, `import path from "node:path";
import {readFileSync} from "node:fs";
const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
function readPluginCacheFile(p) { return JSON.parse(readFileSync(path.join(p.rootDir, p.relativePath), "utf8")); }
export function loadPluginManifest(rootDir, rejectHardlinks = true, rootRealPath) {
 const manifestPath = path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
 return readPluginCacheFile({rootDir, relativePath: PLUGIN_MANIFEST_FILENAME,});
}
export function discover(root) { return JSON.parse(readFileSync(path.join(root, "openclaw.plugin.json"), "utf8")); }
`)
    assert.equal((await rebrandPluginManifestPaths(root)).renamed, 1)
    const {loadPluginManifest, discover} = await import(loader)
    assert.equal(loadPluginManifest(plugin).id, 'demo')
    assert.equal(discover(plugin).id, 'demo')
    await writeFile(join(root, 'openclaw.plugin.json'), '{"id":"existing-user-plugin"}')
    assert.equal(loadPluginManifest(root).id, 'existing-user-plugin')
    assert.equal(discover(root).id, 'existing-user-plugin')
    // Leave the read-only compatibility fixture outside the staged artifact.
    await rm(join(root, 'openclaw.plugin.json'))
    assert.deepEqual(await rebrandPluginManifestPaths(root), {renamed: 0, patched: 0})
    await writeFile(join(plugin, 'openclaw.plugin.json'), '{"id":"conflict"}')
    await assert.rejects(rebrandPluginManifestPaths(root), /collision/)
    assert.equal(JSON.parse(await readFile(join(plugin, 'uniopc.plugin.json'), 'utf8')).id, 'demo')
  } finally { await rm(root, {recursive: true, force: true}) }
})


test('wrapper contract repair is idempotent and rejects unsupported entry layouts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-wrapper-contract-'))
  try {
    await mkdir(join(root, 'dist'))
    const entry = join(root, 'dist', 'entry.js')
    await writeFile(entry, 'const a={wrapperBasename: "openclaw.mjs"};const b={wrapperBasename: "openclaw.mjs"};')
    await rebrandEngineWrapperContract(root)
    const branded = await readFile(entry, 'utf8')
    assert.equal(branded.includes('openclaw.mjs'), false)
    await rebrandEngineWrapperContract(root)
    assert.equal(await readFile(entry, 'utf8'), branded)
    await writeFile(entry, 'new unsupported entry')
    await assert.rejects(rebrandEngineWrapperContract(root), /wrapper contract changed/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

// Verbatim path functions from the installed pinned engine, independent of production constants.
const lifecycleReadableFixture = "function resolveLifecycleCoordinatorPath(family, params) {\n\tconst canonicalDatabasePath = resolvePathViaExistingAncestorSync(params.databasePath);\n\tconst canonicalRuntimeDirectory = resolvePathViaExistingAncestorSync(params.runtimeDirectory);\n\tconst suffix = params.uid === void 0 ? \"openclaw-state-locks\" : `openclaw-state-locks-${params.uid}`;\n\treturn path.join(canonicalRuntimeDirectory, suffix, `${family}.${sha256HexPrefixCore(canonicalDatabasePath, 8)}.lock.sqlite`);\n}"
const lifecycleWorkerFixture = "function resolveLifecycleCoordinatorPath(Ot,Zt){let _n=resolvePathViaExistingAncestorSync(Zt.databasePath),Dn=resolvePathViaExistingAncestorSync(Zt.runtimeDirectory),kn=Zt.uid===void 0?`openclaw-state-locks`:`openclaw-state-locks-${Zt.uid}`;return path.join(Dn,kn,`${Ot}.${sha256HexPrefixCore(_n,8)}.lock.sqlite`)}"
const lifecycleFixtures = [
  ['dist/state-database-coordinator-fixture.js', lifecycleReadableFixture],
  ['dist/config-doctor/official-external-plugin-catalog-snapshot-store-DAJ2jZEn.js', lifecycleReadableFixture],
  ['dist/worker/worker.mjs', lifecycleWorkerFixture],
]
async function addLifecycleFixtures(root, branded = false) {
  for (const [name, body] of lifecycleFixtures) {
    const path = join(root, name)
    await mkdir(join(path, '..'), {recursive: true})
    let existing = ''
    try { existing = await readFile(path, 'utf8') } catch {}
    await writeFile(path, existing + '\n' + (branded ? body.replaceAll('openclaw-state-locks', 'uniopc-state-locks') : body))
  }
  await addGeneratedStateFixtures(root, branded)
}

test('lifecycle preflight rejects missing, duplicate, drifted and extra legacy suffixes without writes', async t => {
  for (const variant of ['missing', 'duplicate', 'duplicate-file', 'drift', 'extra', 'comment', 'string', 'nested']) {
    const root = await mkdtemp(join(tmpdir(), 'uniopc-lock-preflight-'))
    t.after(() => rm(root, {recursive: true, force: true}))
    await addLifecycleFixtures(root)
    await writeFile(join(root, 'dist/paths-fixture.js'), 'const suffix = uid != null ? `openclaw-${uid}` : "openclaw";')
    await writeFile(join(root, 'dist/openclaw-chunk.js'), 'const x = true;')
    const file = join(root, lifecycleFixtures[1][0])
    if (variant === 'missing') await rm(file)
    if (variant === 'duplicate') await writeFile(file, lifecycleReadableFixture + '\n' + lifecycleReadableFixture)
    if (variant === 'duplicate-file') await writeFile(join(root, 'dist/state-database-coordinator-duplicate.js'), 'const unused = true;')
    if (variant === 'drift') await writeFile(file, lifecycleReadableFixture.replace('canonicalDatabasePath, 8', 'canonicalDatabasePath, 9'))
    if (variant === 'comment') await writeFile(file, '/*' + lifecycleReadableFixture + '*/')
    if (variant === 'string') await writeFile(file, 'const fake = ' + JSON.stringify(lifecycleReadableFixture) + ';')
    if (variant === 'nested') await writeFile(file, 'function wrapper(){' + lifecycleReadableFixture + '}')
    if (variant === 'extra') await writeFile(join(root, 'dist/extra.js'), 'const x="openclaw-state-locks";')
    const snapshot = async () => {
      const result = []
      async function walk(dir) {
        for (const e of await readdir(dir, {withFileTypes:true})) {
          const path = join(dir, e.name)
          if (e.isDirectory()) await walk(path)
          else result.push([path, await readFile(path, 'utf8')])
        }
      }
      await walk(root)
      return result
    }
    const before = await snapshot()
    await assert.rejects(rebrandCompiledRuntimePaths(root), /Lifecycle coordinator/)
    assert.deepEqual(await snapshot(), before, variant)
  }
})

test('pinned main, config-doctor and worker derivations retain database hashes and both lifecycle families', () => {
  const databasePath = path.resolve('/state/main.sqlite')
  const runtimeDirectory = path.resolve('/profile/Uniopc/locks')
  const hash = createHash('sha256').update(databasePath).digest('hex').slice(0, 8)
  for (const [, body] of lifecycleFixtures) {
    const derive = new Function('path', 'resolvePathViaExistingAncestorSync', 'sha256HexPrefixCore',
      body.replaceAll('openclaw-state-locks', 'uniopc-state-locks') + ';return resolveLifecycleCoordinatorPath;')(
        path, path.resolve, (value, length) => createHash('sha256').update(value).digest('hex').slice(0, length))
    for (const uid of [undefined, 501]) for (const family of ['gateway-lifecycle', 'state-lifecycle']) {
      assert.equal(derive(family, {databasePath, runtimeDirectory, uid}),
        join(runtimeDirectory, `uniopc-state-locks${uid === undefined ? '' : '-501'}`, `${family}.${hash}.lock.sqlite`))
    }
  }
})


async function largeDistFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-rebrand-fd-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  await mkdir(join(root, 'dist'))
  // Fixture setup is sequential too: it must not exhaust the test runner's FDs.
  for (let index = 0; index < 1024; index++) {
    const extension = ['js', 'mjs', 'cjs', 'ts', 'mts', 'json', 'html', 'css', 'map'][index % 9]
    await writeFile(join(root, 'dist', `chunk-${String(index).padStart(4, '0')}.${extension}`), '"./openclaw-chunk.js"')
  }
  await addLifecycleFixtures(root)
  await writeFile(join(root, 'dist/openclaw-chunk.js'), 'const ready = true;')
  await writeFile(join(root, 'dist/paths-fixture.js'), 'const suffix = uid != null ? `openclaw-${uid}` : "openclaw";')
  return root
}

async function distSnapshot(root) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await visit(file)
      else files.push([path.relative(root, file), createHash('sha256').update(await readFile(file)).digest('hex')])
    }
  }
  await visit(join(root, 'dist'))
  return files.sort(([a], [b]) => a.localeCompare(b))
}

function transformWithLowFdLimit(moduleUrl, root) {
  const program = `import { rebrandCompiledRuntimePaths } from ${JSON.stringify(moduleUrl)};
try { await rebrandCompiledRuntimePaths(process.argv[1]); }
catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }`
  // Positional arguments avoid shell interpolation of paths or source code.
  return spawnSync('/bin/sh', ['-c', 'ulimit -n 64 || exit 90; exec "$@"', 'fd-limit-test',
    process.execPath, '--input-type=module', '-e', program, root], {encoding: 'utf8', timeout: 60000})
}

test('large dist preflight uses bounded file handles and preserves full coverage and idempotence', async t => {
  const root = await largeDistFixture(t)
  const before = await distSnapshot(root)
  if (process.platform !== 'win32') {
    // Reconstruct the previous unbounded reader without requiring Git history.
    // Run it only on the isolated fixture, never on an installed/live runtime.
    const currentSource = await readFile(new URL('./uniopc-runtime-branding.mjs', import.meta.url), 'utf8')
    const sequentialReader = "const sources = []\n  for (const path of textFiles) sources.push({path, source: await readFile(path, 'utf8')})"
    assert.equal(currentSource.split(sequentialReader).length, 2, 'bounded reader fixture anchor drift')
    const parentSource = currentSource.replace(sequentialReader,
      "const sources = await Promise.all(textFiles.map(async path => ({path, source: await readFile(path, 'utf8')})))")
      .replace(/from '(\.\/[^']+)'/g, (_, relative) => `from '${new URL(relative, import.meta.url).href}'`)
    const parentModule = join(root, 'parent-branding.mjs')
    await writeFile(parentModule, parentSource)
    const oldResult = transformWithLowFdLimit(pathToFileURL(parentModule).href, root)
    assert.equal(oldResult.error, undefined)
    assert.notEqual(oldResult.status, 0)
    assert.match(oldResult.stderr, /EMFILE/)
    assert.deepEqual(await distSnapshot(root), before)
    t.diagnostic('Unbounded reader fixture under soft FD limit 64: EMFILE; fixture bytes and names unchanged')
    const result = transformWithLowFdLimit(new URL('./uniopc-runtime-branding.mjs', import.meta.url).href, root)
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    t.diagnostic('Current implementation under soft FD limit 64: success')
  } else {
    t.diagnostic('POSIX soft FD limit comparison unavailable on Windows; large-directory conversion still runs')
    await rebrandCompiledRuntimePaths(root)
  }
  const after = await distSnapshot(root)
  assert.ok(after.some(([name]) => name === 'dist/uniopc-chunk.js'))
  assert.ok(!after.some(([name]) => name === 'dist/openclaw-chunk.js'))
  for (const [name] of after.filter(([name]) => /chunk-\d+\./.test(name))) {
    assert.equal(await readFile(join(root, name), 'utf8'), '"./uniopc-chunk.js"')
  }
  assert.deepEqual(await rebrandCompiledRuntimePaths(root), [])
  assert.deepEqual(await distSnapshot(root), after)
})

test('large dist rejects a late extra lifecycle suffix before any byte or filename changes', async t => {
  const root = await largeDistFixture(t)
  await writeFile(join(root, 'dist/zzzz-last-chunk.js'), 'const unsupported = "openclaw-state-locks";')
  const before = await distSnapshot(root)
  await assert.rejects(rebrandCompiledRuntimePaths(root), /Lifecycle coordinator/)
  assert.deepEqual(await distSnapshot(root), before)
})

async function addGeneratedStateFixtures(root, branded = false) {
  const {GENERATED_STATE_ROLES, GENERATED_STATE_FUNCTIONS, inspectGeneratedStateSources} = await import('./verify-uniopc-whitelabel-runtime.mjs')
  const names=['openclaw-agent.sqlite','incognito-openclaw-agent.sqlite','openclaw.sqlite']
  for(const {role,counts} of [...GENERATED_STATE_ROLES, ...[...new Set(GENERATED_STATE_FUNCTIONS.map(item=>item.role))].filter(role=>!GENERATED_STATE_ROLES.some(item=>item.role===role)).map(role=>({role,counts:[0,0,0]}))]) {
    const file=join(root,'dist',role)
    await mkdir(join(file,'..'),{recursive:true})
    let source=''
    try {source=await readFile(file,'utf8')} catch {}
    for(const contract of GENERATED_STATE_FUNCTIONS.filter(item=>item.role===role)) source+='\n'+contract.body
    if(role==='uniopc-cli-invocation-Dah1vX_Z.js') source+='\nconst OPENCLAW_CLI_ENTRY_BASENAMES = /* @__PURE__ */ new Set(["openclaw", "openclaw.mjs"]);'
    if(role==='worker/worker.mjs') source+='\nvar OPENCLAW_CLI_ENTRY_BASENAMES=new Set([`openclaw`,`openclaw.mjs`]);'
    if(role==='register.backup-BFONF7_5.js') source+='\nconst BACKUP_CRON_JOB_NAME = "openclaw-backup-scheduled";'
    const present=names.map(name=>source.split(name).length-1);present[0]-=present[1]
    for(let i=0;i<3;i++) for(let j=present[i];j<counts[i];j++) source+='\n// '+names[i]
    await writeFile(file,source)
  }
  if(branded) {
    const sources=[]
    async function visit(dir) {for(const e of await readdir(dir,{withFileTypes:true})){const file=join(dir,e.name);if(e.isDirectory())await visit(file);else sources.push({path:file,source:await readFile(file,'utf8')})}}
    await visit(join(root,'dist'))
    for(const [file,source] of inspectGeneratedStateSources(sources,{allowUnpatched:true})) await writeFile(file,source)
  }
}

test('plugin manifest root display name preserves package identities and nested commands', () => {
  const input={name:'OpenClaw Memory',id:'openclaw-memory',cliCommands:[{name:'OpenClaw',description:'OpenClaw help'}]}
  assert.deepEqual(rebrandDisplayMetadata(input,{pluginManifest:true}),{name:'Uniopc Memory',id:'openclaw-memory',cliCommands:[{name:'OpenClaw',description:'Uniopc help'}]})
  for(const name of ['@openclaw/foo','openclaw','openclaw-memory']) {
    assert.equal(rebrandDisplayMetadata({name},{pluginManifest:true}).name,name)
    assert.equal(rebrandDisplayMetadata({name},{}).name,name)
  }
  assert.equal(rebrandDisplayMetadata({name:'OpenClaw Memory'}).name,'OpenClaw Memory')
})

test('actual pinned engine converts all generated state roles atomically and runs its technical CLI', {skip:!process.env.LAN46_ENGINE_SOURCE, timeout:600000}, async t => {
  const {cp,rename}=await import('node:fs/promises')
  const {inspectGeneratedStateSources}=await import('./verify-uniopc-whitelabel-runtime.mjs')
  const root=await mkdtemp(join(tmpdir(),'uniopc-real-generated-state-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const engine=join(root,'uniopc-engine')
  await cp(process.env.LAN46_ENGINE_SOURCE,engine,{recursive:true})
  const entries=[]
  async function visit(dir) {for(const e of await readdir(dir,{withFileTypes:true})){const file=join(dir,e.name);if(e.isDirectory())await visit(file);else if(/\.(?:js|mjs|cjs|ts|mts|json|html|css|map)$/.test(file))entries.push({path:file,source:await readFile(file,'utf8')})}}
  await visit(join(engine,'dist'))
  assert.equal(inspectGeneratedStateSources(entries,{allowUnpatched:true}).size,entries.length)
  const original=await distSnapshot(engine)
  const worker=join(engine,'dist/worker/worker.mjs')
  const workerBefore=await readFile(worker,'utf8')
  const invocation=entries.find(e=>/\/uniopc-cli-invocation-[^/]+\.js$/.test(e.path))
  const session=entries.find(e=>/\/session-sqlite-target-[^/]+\.js$/.test(e.path))
  const main=entries.find(e=>/\/uniopc-state-db-[^-]+\.js$/.test(e.path))
  for(const variant of ['missing','duplicate','partial','count','unknown-old','unknown-new','cli','session','backup-partial','backup-unknown','escaped-drift','escaped-unknown']) {
    const before=await distSnapshot(engine)
    let restore
    if(variant==='missing'){await rename(main.path,main.path+'.hidden');restore=()=>rename(main.path+'.hidden',main.path)}
    if(variant==='duplicate'){const file=main.path.replace(/-[^-]+\.js$/,'-duplicate.js');await writeFile(file,main.source);restore=()=>rm(file)}
    if(variant==='partial'||variant==='count'){await writeFile(worker,workerBefore.replace('openclaw-agent.sqlite',variant==='partial'?'uniopc-agent.sqlite':'other-agent.sqlite'));restore=()=>writeFile(worker,workerBefore)}
    if(variant.startsWith('unknown-')){const file=join(engine,'dist/zz-unknown.json');await writeFile(file,JSON.stringify({file:variant==='unknown-old'?'openclaw.sqlite':'uniopc.sqlite'}));restore=()=>rm(file)}
    if(variant==='cli'){await writeFile(invocation.path,invocation.source.replace('const sourceEntry =','const sourceEntryDrift ='));restore=()=>writeFile(invocation.path,invocation.source)}
    if(variant==='session'){await writeFile(session.path,session.source.replace('|| "openclaw-agent"','|| "other-agent"'));restore=()=>writeFile(session.path,session.source)}
    if(variant==='backup-partial'){await writeFile(worker,workerBefore.replace('-openclaw-backup`','-uniopc-backup`'));restore=()=>writeFile(worker,workerBefore)}
    if(variant==='backup-unknown'||variant==='escaped-unknown'){const file=join(engine,'dist/unknown-generated.txt');await writeFile(file,variant==='backup-unknown'?'unexpected-uniopc-backup':'uniopc-agent\\.sqlite');restore=()=>rm(file)}
    if(variant==='escaped-drift'){const file=join(engine,'dist/backup-archive-path-policy-DKQb_csh.js'),source=await readFile(file,'utf8');await writeFile(file,source.replace('(?:-wal|-shm|-journal)?','(?:-wal|-shm)?'));restore=()=>writeFile(file,source)}
    const malformed=await distSnapshot(engine)
    await assert.rejects(rebrandCompiledRuntimePaths(engine),/Generated state|Backup output/)
    assert.deepEqual(await distSnapshot(engine),malformed,variant+' made zero byte/name writes')
    await restore()
    assert.deepEqual(await distSnapshot(engine),before)
  }
  await rebrandCompiledRuntimePaths(engine)
  const converted=await distSnapshot(engine)
  assert.notDeepEqual(converted,original)
  await rebrandCompiledRuntimePaths(engine)
  assert.deepEqual(await distSnapshot(engine),converted)
  const patchedWorker=await readFile(worker,'utf8')
  const technicalSet='new Set([`openclaw`,`openclaw.mjs`])'
  assert.ok(workerBefore.split(technicalSet).length-1>1,'real worker includes an unrelated identical technical Set')
  assert.equal(patchedWorker.split(technicalSet).length,workerBefore.split(technicalSet).length-1)
  assert.equal(patchedWorker.split('openclaw-agent').length-1,workerBefore.split('openclaw-agent').length-1-31-1-1-1-1) // DBs, escaped validator, default and CLI temp prefix only
  const program=`
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {readdirSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
const engine=process.argv[1], state=process.argv[2];
process.env.OPENCLAW_STATE_DIR=state;
process.env.HOME=path.dirname(state);
const modules={'uniopc-agent-db.paths':'uniopc-agent-db.paths-BAQb87PB.js','uniopc-state-db-readonly':'uniopc-state-db-readonly-YhcJ4nbp.js','session-sqlite-target':'session-sqlite-target-Cc4hugKW.js','uniopc-agent-db':'uniopc-agent-db-DwEkomYQ.js','state-database-coordinator':'state-database-coordinator-Dscslso6.js','uniopc-cli-invocation':'uniopc-cli-invocation-Dah1vX_Z.js','uniopc-cli-shim':'uniopc-cli-shim-BECwG_UE.js'};
const load=async stem=>import(pathToFileURL(path.join(engine,'dist',modules[stem])));
const paths=await load('uniopc-agent-db.paths');
const shared=await load('uniopc-state-db-readonly');
const sessions=await load('session-sqlite-target');
const env={...process.env,OPENCLAW_STATE_DIR:state};
const agent=paths.r({agentId:'main',env});
assert.equal(agent,path.join(state,'agents/main/agent/uniopc-agent.sqlite'));
assert.equal(paths.n({agentId:'main',env}),path.join(path.dirname(agent),'incognito-uniopc-agent.sqlite'));
assert.equal(shared.J(env),path.join(state,'state/uniopc.sqlite'));
assert.equal(sessions.i(path.join(state,'agents/main/sessions/sessions.json')).path,agent);
const custom=path.join(state,'custom.sqlite');
assert.equal(paths.r({agentId:'main',env,path:custom}),custom);
assert.equal(sessions.i(custom).path,custom);
const agentDb=await load('uniopc-agent-db');
const open=agentDb.g({agentId:'main',env});
open.db.prepare('INSERT INTO auth_profile_state VALUES (?,?,?)').run('fixture',JSON.stringify({token:'fixture-token'}),1);
open.db.prepare('INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at) VALUES (?,?,?,?)').run('agent:main:fixture','fixture-session','{}',1);
open.db.prepare('INSERT INTO session_windows (session_id,session_key,created_at,updated_at) VALUES (?,?,?,?)').run('fixture-session','agent:main:fixture',1,1);
open.db.prepare('INSERT INTO transcript_events VALUES (?,?,?,?)').run('fixture-session',1,JSON.stringify({message:{role:'user',content:'fixture-message'}}),1);
assert.ok(existsSync(agent+'-wal'));assert.ok(existsSync(agent+'-shm'));
agentDb.i(agent);
const reopened=agentDb.g({agentId:'main',env});
assert.equal(JSON.parse(reopened.db.prepare('SELECT state_json FROM auth_profile_state WHERE state_key=?').get('fixture').state_json).token,'fixture-token');
assert.equal(JSON.parse(reopened.db.prepare('SELECT event_json FROM transcript_events WHERE session_id=?').get('fixture-session').event_json).message.content,'fixture-message');
agentDb.i(agent);
assert.ok(!existsSync(path.join(path.dirname(agent),'openclaw-agent.sqlite')));
const memoryFile=path.join(engine,'dist/extensions/memory-core/manager-runtime.js');
if(!readFileSync(memoryFile,'utf8').includes('export {acquireCrossProcessLease as testGenerationLease}')) writeFileSync(memoryFile,readFileSync(memoryFile,'utf8')+'\\nexport {acquireCrossProcessLease as testGenerationLease};');
const memory=await import(pathToFileURL(memoryFile));
const generation=await memory.testGenerationLease(agent,'write');
assert.ok(existsSync(agent+'.generation-writer.sqlite'));
assert.ok(existsSync(agent+'.generation-lock.sqlite'));
generation.release();
const reindexFile=path.join(engine,'dist',readdirSync(path.join(engine,'dist')).find(n=>n.startsWith('manager-vector-warning-')));
if(!readFileSync(reindexFile,'utf8').includes('export {resolveMemoryReindexLockPath as testReindexPath}')) writeFileSync(reindexFile,readFileSync(reindexFile,'utf8')+'\\nexport {resolveMemoryReindexLockPath as testReindexPath};');
const reindex=await import(pathToFileURL(reindexFile).href+'?contract-test=1');
const reindexPath=reindex.testReindexPath(agent);
assert.equal(reindexPath,agent+'.reindex-lock.sqlite');
const reindexLease=reindex.m(reindexPath,'exclusive');assert.ok(reindexLease);reindexLease.release();
// The specialized config-doctor module also initializes excluded historical
// migration resources. Exercise its complete coordinator region with its real
// runtime dependencies, preserving its initializer and every coordinator byte.
const roleFiles=['state-database-coordinator-Dscslso6.js','config-doctor/official-external-plugin-catalog-snapshot-store-DAJ2jZEn.js','worker/worker.mjs'];
const roleSources=roleFiles.map(file=>readFileSync(path.join(engine,'dist',file),'utf8'));
const digest=source=>createHash('sha256').update(source).digest('hex');
const sqliteStart=roleSources[0].indexOf('//#region src/infra/sqlite-coordinator.ts');
const sqliteEnd=roleSources[0].indexOf('//#endregion',sqliteStart);
const sqliteRegion=roleSources[0].slice(sqliteStart,sqliteEnd);
const stage=path.join(path.dirname(state),'coordinator-proof');mkdirSync(stage,{recursive:true});
const base=pathToFileURL(engine).href;
const {n:canonical}=await import(base+'/dist/root-path-existing-CLr-7fqF.js');
const dependencies="import fs from 'node:fs';import os from 'node:os';import path from 'node:path';const fs$1=fs;\\n"+
"import {n as resolvePathViaExistingAncestorSync} from '"+base+"/dist/root-path-existing-CLr-7fqF.js';\\nimport {o as tryAcquireExclusiveSqliteCoordinator} from '"+base+"/dist/node-sqlite-GN5_mcoB.js';\\nimport {t as applyPrivateModeSync} from '"+base+"/dist/private-mode-B6dWGRb2.js';\\nimport {o as sha256HexPrefixCore} from '"+base+"/dist/crypto-digest-IGAbV2KW.js';\\n";
const extraction=[];
for(let role=0;role<3;role++) {
 const source=roleSources[role];let code,ranges;
 if(role<2){const first=source.indexOf('//#region src/infra/sqlite-coordinator.ts'),firstEnd=source.indexOf('//#endregion',first),start=source.indexOf('//#region src/infra/state-database-coordinator.ts'),end=source.indexOf('//#endregion',start);ranges=[[first,firstEnd],[start,end]];code=ranges.map(([start,end])=>source.slice(start,end)).join('\\n');}
 else{const start=source.indexOf('function resolveStateLifecycleRuntimeDirectory('),end=source.indexOf(',FAILOVER_REASONS$1',start);ranges=[[start,end]];code=sqliteRegion+'\\nconst __esmMin=fn=>fn;const init_boundary_path=()=>{},init_crypto_digest=()=>{},init_node_sqlite=()=>{},init_sqlite_coordinator=()=>{};\\n'+source.slice(start,end)+';init_state_database_coordinator();';}
 assert.ok(ranges.every(([start,end])=>start>=0&&end>start));
 extraction.push({file:roleFiles[role],sourceSha256:digest(source),ranges:ranges.map(([start,end])=>({startByte:Buffer.byteLength(source.slice(0,start)),endByte:Buffer.byteLength(source.slice(0,end)),sha256:digest(source.slice(start,end))}))});
 writeFileSync(path.join(stage,'role'+role+'.mjs'),dependencies+code+'\\nexport {resolveLifecycleCoordinatorPath,acquireGatewayLifecycleCoordinator,acquireStateDatabaseCoordinator};');
}
const runner=path.join(stage,'runner.mjs');
writeFileSync(runner,"const m=await import(process.argv[2]);let held=[];process.on('message',msg=>{try{if(msg.op==='acquire'){const p=msg.params;if(msg.explicit)p.coordinatorPath=m.resolveLifecycleCoordinatorPath(msg.family,p);const h=m[msg.family==='gateway-lifecycle'?'acquireGatewayLifecycleCoordinator':'acquireStateDatabaseCoordinator'](p);held.push(h);process.send({ok:true,path:h.path});}else{held.shift()?.release();process.send({ok:true})}}catch(e){process.send({ok:false,name:e.name,message:e.message})}});process.send({ready:true});");
const children=[];
async function child(role){const c=spawn(process.execPath,[runner,pathToFileURL(path.join(stage,'role'+role+'.mjs')).href],{stdio:['ignore','ignore','pipe','ipc'],env:process.env});children.push(c);await once(c,'message');return c;}
async function command(child,message){const reply=once(child,'message');child.send(message);const result=(await reply)[0];if(!result.ok)assert.equal(result.name,'StateDatabaseCoordinatorContentionError',JSON.stringify(result));return result;}
const runtimeDirectory=path.join(state,'locks'),uid=process.getuid?.();mkdirSync(runtimeDirectory,{recursive:true});
try {
 for(const databasePath of [agent,shared.J(env)]) for(const family of ['gateway-lifecycle','state-lifecycle']) for(const peer of [1,2]) for(const owner of [0,peer]) {
  const other=owner===0?peer:0,a=await child(owner),b=await child(other),params={databasePath,runtimeDirectory,uid,busyTimeoutMs:0},request={op:'acquire',family,params};
  const first=await command(a,request);assert.equal(first.ok,true);assert.match(first.path,/uniopc-state-locks/);
  assert.equal((await command(a,request)).path,first.path);assert.equal((await command(b,request)).ok,false);
  assert.equal((await command(b,{...request,params:{...params,databasePath:databasePath+'-different'}})).ok,true);await command(b,{op:'release'});
  await command(a,{op:'release'});assert.equal((await command(b,request)).ok,false);await command(a,{op:'release'});assert.equal((await command(b,request)).path,first.path);await command(b,{op:'release'});
  assert.equal((await command(a,{...request,explicit:true})).path,first.path);assert.equal((await command(b,request)).ok,false);await command(a,{op:'release'});
  assert.equal((await command(a,request)).ok,true);a.kill('SIGKILL');await once(a,'exit');assert.equal((await command(b,request)).ok,true);await command(b,{op:'release'});b.kill();
 }
 const main=await import(pathToFileURL(path.join(stage,'role0.mjs')));
 const params={databasePath:agent,runtimeDirectory,uid,busyTimeoutMs:0},customCoordinator=path.join(state,'custom-coordinator.sqlite');
 const customLease=main.acquireStateDatabaseCoordinator({...params,coordinatorPath:customCoordinator});assert.equal(customLease.path,customCoordinator);customLease.release();customLease.release();
 for(const uid of [undefined,501]) for(const databasePath of [agent,shared.J(env)]) for(const family of ['gateway-lifecycle','state-lifecycle']) {
  const expected=path.join(canonical(runtimeDirectory),'uniopc-state-locks'+(uid===undefined?'':'-'+uid),family+'.'+digest(canonical(databasePath)).slice(0,8)+'.lock.sqlite');
  for(let role=0;role<3;role++) assert.equal((await import(pathToFileURL(path.join(stage,'role'+role+'.mjs')))).resolveLifecycleCoordinatorPath(family,{databasePath,runtimeDirectory,uid}),expected);
 }
 console.log(JSON.stringify({coordinatorExtraction:extraction,agent,global:shared.J(env),threeRoleContention:true}));
} finally {for(const child of children)child.kill();}
const invocation=(await load('uniopc-cli-invocation')).n([], {argv1:path.join(engine,'unrecognized-launcher'),cwd:engine,moduleUrl:pathToFileURL(path.join(engine,'dist/entry.js')).href,execArgv:[]});
assert.equal(invocation.args.at(-1),path.join(engine,'uniopc-engine.mjs'));
const shim=await load('uniopc-cli-shim');
await shim.r({stateDir:state,env,invocation});
const cliEnv={...env,PATH:path.join(state,'tmp/agent-cli')+path.delimiter+process.env.PATH};
const version=execFileSync('openclaw',['--version'],{env:cliEnv,encoding:'utf8',timeout:30000});
assert.match(version,/2026\\.8\\.1/);
const doctor=execFileSync('openclaw',['doctor','--non-interactive'],{env:{...cliEnv,CI:'1'},encoding:'utf8',timeout:60000});
assert.ok(doctor.length>0);
const policyFile=path.join(engine,'dist/backup-archive-path-policy-DKQb_csh.js');
writeFileSync(policyFile,readFileSync(policyFile,'utf8')+'\\nexport {createBackupResourceInventory as testInventory, listDefaultAgentTemporaryRoots as testTemporaryRoots, MANAGED_STATE_ROOTS as testManagedRoots, isPathWithin as testIsPathWithin, formatBackupArchiveTimestamp as testTimestamp};');
const policy=await import(pathToFileURL(policyFile).href+'?inventory-contract=1');
const inventoryStart=roleSources[2].indexOf('async function createBackupResourceInventory('),inventoryEnd=roleSources[2].indexOf('var ',inventoryStart),inventoryBody=roleSources[2].slice(inventoryStart,inventoryEnd);
assert.ok(inventoryStart>=0&&inventoryEnd>inventoryStart);
const workerInventory=new Function('path','resolveOpenClawStateSqlitePath','MANAGED_STATE_ROOTS','listDefaultAgentTemporaryRoots','isPathWithin$1',inventoryBody+';return createBackupResourceInventory;')(path,shared.J,policy.testManagedRoots,policy.testTemporaryRoots,policy.testIsPathWithin);
const inventoryParams={stateDir:state,configPath:path.join(state,'config.json'),oauthDir:path.join(state,'credentials'),agentRoots:[],workspaceDirs:[],pluginResources:[],pluginRoots:[],onlyConfig:false};
const inventoryTests=[];
for(const create of [policy.testInventory,workerInventory]) {
 const inventory=await create(inventoryParams),base=path.join(state,'agents/node_modules/agent');
 for(const suffix of ['','-wal','-shm','-journal']) {const file=path.join(base,'uniopc-agent.sqlite'+suffix);assert.equal(inventory.isPackageContent(file),false);inventoryTests.push(file);}
 for(const name of ['openclaw-agent.sqlite','uniopc-agentXsqlite','prefix-uniopc-agent.sqlite','uniopc-agent.sqlite-extra']) assert.equal(inventory.isPackageContent(path.join(base,name)),true);
 const custom=path.join(base,'custom.sqlite');
 const registered=await create({...inventoryParams,agentRoots:[{agentId:'node_modules',sourcePath:path.join(state,'registered-root'),databasePath:custom}]});
 assert.equal(registered.isPackageContent(custom),false);
}
const nowMs=Date.UTC(2026,2,9,0,0,0);
assert.equal(policy.c(nowMs),policy.testTimestamp(nowMs)+'-uniopc-backup');
assert.equal(policy.o(nowMs),policy.c(nowMs)+'.tar.gz');
assert.ok(readFileSync(path.join(engine,'dist/register.backup-BFONF7_5.js'),'utf8').includes('const BACKUP_CRON_JOB_NAME = "openclaw-backup-scheduled";'));
console.log(JSON.stringify({inventorySourceSha256:digest(roleSources[2]),inventoryRange:{startByte:Buffer.byteLength(roleSources[2].slice(0,inventoryStart)),endByte:Buffer.byteLength(roleSources[2].slice(0,inventoryEnd)),sha256:digest(inventoryBody)},inventoryTests,regexProtection:true}));
const archive=path.join(path.dirname(state),'custom.tar.gz');
const backup=execFileSync('openclaw',['backup','create','--output',archive,'--verify','--no-include-workspace','--json'],{env:cliEnv,encoding:'utf8',timeout:60000});
assert.ok(existsSync(archive));
const backupResult=JSON.parse(backup);
assert.equal(backupResult.archivePath,archive);
assert.ok(backupResult.archiveRoot.endsWith('-uniopc-backup'));
const listed=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).trim().split(/\\r?\\n/).filter(Boolean).map(name=>name.replace(/^\\.\\//,''));
assert.deepEqual([...new Set(listed.map(name=>name.split('/')[0]))],[backupResult.archiveRoot]);
execFileSync('openclaw',['backup','verify',archive,'--json'],{env:cliEnv,encoding:'utf8',timeout:60000});
const restored=path.join(path.dirname(state),'restored');
execFileSync('openclaw',['backup','restore',archive,'--target',restored,'--json'],{env:cliEnv,encoding:'utf8',timeout:60000});
const restoredFiles=[];
function scan(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())scan(p);else restoredFiles.push(p)}}scan(restored);
const restoredAgent=restoredFiles.find(p=>p.endsWith('/agents/main/agent/uniopc-agent.sqlite'));
assert.ok(restoredAgent,JSON.stringify(restoredFiles));
assert.ok(restoredFiles.some(p=>p.endsWith('/state/uniopc.sqlite')));
assert.ok(!restoredFiles.some(p=>/openclaw(?:-agent)?\.sqlite/.test(p)));
const {DatabaseSync}=await import('node:sqlite');const restoredDb=new DatabaseSync(restoredAgent,{readOnly:true});
assert.equal(JSON.parse(restoredDb.prepare('SELECT event_json FROM transcript_events WHERE session_id=?').get('fixture-session').event_json).message.content,'fixture-message');restoredDb.close();
const manifestFile=path.join(restored,backupResult.archiveRoot,'manifest.json'),manifestText=readFileSync(manifestFile,'utf8');
for(const badRoot of ['mismatched-uniopc-backup','../escape']) {
 writeFileSync(manifestFile,JSON.stringify({...JSON.parse(manifestText),archiveRoot:badRoot}));
 const badArchive=path.join(path.dirname(state),badRoot.startsWith('.')?'unsafe.tar.gz':'mismatch.tar.gz');
 execFileSync('tar',['-czf',badArchive,'-C',restored,backupResult.archiveRoot]);
 const verify=spawnSync('openclaw',['backup','verify',badArchive,'--json'],{env:cliEnv,encoding:'utf8',timeout:60000});assert.notEqual(verify.status,0);
 const badTarget=badArchive+'.restored';
 const restore=spawnSync('openclaw',['backup','restore',badArchive,'--target',badTarget,'--json'],{env:cliEnv,encoding:'utf8',timeout:60000});assert.notEqual(restore.status,0);assert.ok(!existsSync(badTarget));
}
writeFileSync(manifestFile,manifestText);
console.log(JSON.stringify({agent,global:shared.J(env),version:version.trim(),doctor:true,custom:true,reopened:true,backupRestore:true,sidecars:true,threeRoleContention:true,backupNameSafety:true,regexProtection:true}));
`
  const result=spawnSync(process.execPath,['--input-type=module','-e',program,engine,join(root,'state')],{encoding:'utf8',timeout:300000,env:{PATH:process.env.PATH,HOME:root,TMPDIR:root,CI:'1',NODE_OPTIONS:'',NODE_PATH:''}})
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout)
  t.diagnostic(result.stdout.trim())
})

test('generated state rejects CLI/session declaration and anchor drift with zero writes', async t => {
  const {GENERATED_STATE_FUNCTIONS}=await import('./verify-uniopc-whitelabel-runtime.mjs')
  for(const variant of ['comment','string','nested','duplicate','extra-file','entry-set','extra-prefix','partial-role']) {
    const root=await mkdtemp(join(tmpdir(),'uniopc-generated-preflight-'))
    t.after(()=>rm(root,{recursive:true,force:true}))
    await addLifecycleFixtures(root)
    await writeFile(join(root,'dist/paths-lock.js'),'const suffix = uid != null ? `openclaw-${uid}` : "openclaw";')
    const contract=GENERATED_STATE_FUNCTIONS.find(item=>item.name==='buildPackageRootCliArgs' && item.role!=='worker/worker.mjs')
    const file=join(root,'dist',contract.role)
    const source=await readFile(file,'utf8')
    if(variant==='comment') await writeFile(file,source.replace(contract.body,'/*'+contract.body+'*/'))
    if(variant==='string') await writeFile(file,source.replace(contract.body,'const fake='+JSON.stringify(contract.body)+';'))
    if(variant==='nested') await writeFile(file,source.replace(contract.body,'function wrapper(){'+contract.body+'}'))
    if(variant==='duplicate') await writeFile(file,source+'\n'+contract.body)
    if(variant==='extra-file') await writeFile(join(root,'dist','extra-cli.js'),contract.body)
    if(variant==='entry-set') await writeFile(file,source.replace('"openclaw.mjs"]','"openclaw.mjs", "drift"]'))
    if(variant==='extra-prefix') await writeFile(join(root,'dist','extra-temp.js'),'const prefix="openclaw-agent-cli";')
    if(variant==='partial-role') await writeFile(file,source.replace('return [path.join(packageRoot, "openclaw.mjs")];','return [path.join(packageRoot, "uniopc-engine.mjs")];'))
    const before=await distSnapshot(root)
    await assert.rejects(rebrandCompiledRuntimePaths(root),/Generated state/)
    assert.deepEqual(await distSnapshot(root),before,variant)
  }
})

test('backup output contracts reject missing, duplicate, partial, drifted and unknown names before writes', async t => {
  const {BACKUP_OUTPUT_ANCHORS}=await import('./verify-uniopc-whitelabel-runtime.mjs')
  for(const variant of ['missing','duplicate','partial','drift','unknown-old','unknown-new','cron']) {
    const root=await mkdtemp(join(tmpdir(),'uniopc-backup-preflight-'));t.after(()=>rm(root,{recursive:true,force:true}))
    await addLifecycleFixtures(root)
    await writeFile(join(root,'dist/paths-lock.js'),'const suffix = uid != null ? `openclaw-${uid}` : "openclaw";')
    const {role,anchor}=BACKUP_OUTPUT_ANCHORS[0],file=join(root,'dist',role),source=await readFile(file,'utf8')
    if(variant==='missing') await rm(file)
    if(variant==='duplicate') await writeFile(join(root,'dist','duplicate-backup.js'),source)
    if(variant==='partial') {const worker=join(root,'dist/worker/worker.mjs'),body=await readFile(worker,'utf8'),target=BACKUP_OUTPUT_ANCHORS.find(item=>item.role==='worker/worker.mjs');await writeFile(worker,body.replace(target.anchor,target.anchor.replaceAll('openclaw-backup','uniopc-backup')))}
    if(variant==='drift') await writeFile(file,source.replace(anchor,anchor.replace('formatBackupArchiveTimestamp(nowMs)','formatBackupArchiveTimestamp(nowMs + 1)')))
    if(variant.startsWith('unknown-')) await writeFile(join(root,'dist','unknown-output.txt'),variant==='unknown-old'?'test-openclaw-backup':'test-uniopc-backup')
    if(variant==='cron'){const cron=join(root,'dist/register.backup-BFONF7_5.js');await writeFile(cron,(await readFile(cron,'utf8')).replace('openclaw-backup-scheduled','uniopc-backup-scheduled'))}
    const before=await distSnapshot(root)
    await assert.rejects(rebrandCompiledRuntimePaths(root),/Generated state|Backup output|Backup scheduled/)
    assert.deepEqual(await distSnapshot(root),before,variant)
  }
})

test('escaped agent database contracts reject partial, duplicate, drift and unknown escaped forms atomically', async t => {
  const {ESCAPED_DATABASE_ANCHORS}=await import('./verify-uniopc-whitelabel-runtime.mjs')
  for(const variant of ['partial-main','partial-worker','missing','duplicate','drift','unknown-old','unknown-new']) {
    const root=await mkdtemp(join(tmpdir(),'uniopc-escaped-db-'));t.after(()=>rm(root,{recursive:true,force:true}))
    await addLifecycleFixtures(root)
    await writeFile(join(root,'dist/paths-lock.js'),'const suffix = uid != null ? `openclaw-${uid}` : "openclaw";')
    const contract=ESCAPED_DATABASE_ANCHORS[variant==='partial-worker'?1:0],file=join(root,'dist',contract.role),source=await readFile(file,'utf8')
    if(variant.startsWith('partial')) await writeFile(file,source.replace(contract.anchor,contract.anchor.replace('openclaw-agent','uniopc-agent')))
    if(variant==='missing') await rm(file)
    if(variant==='duplicate') await writeFile(join(root,'dist','extra-inventory.js'),source)
    if(variant==='drift') await writeFile(file,source.replace(contract.anchor,contract.anchor.replace('(?:-wal|-shm|-journal)?','(?:-wal|-shm)?')))
    if(variant.startsWith('unknown')) await writeFile(join(root,'dist','escaped-extra.txt'),variant==='unknown-old'?'openclaw-agent\\.sqlite':'uniopc-agent\\.sqlite')
    const before=await distSnapshot(root)
    await assert.rejects(rebrandCompiledRuntimePaths(root),/Generated state|Lifecycle coordinator/)
    assert.deepEqual(await distSnapshot(root),before,variant)
  }
})
