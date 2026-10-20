import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as benchmark from './benchmark-openclaw-startup.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, summarize, parseTrace, isReady, resolveRuntime, isolatedEnv, runSample, boundedSyntheticDiagnostic } from './benchmark-openclaw-startup.mjs';

test('failures and timeouts are not zero-valued latency samples; nearest-rank P95', () => {
  assert.deepEqual(summarize([{status:'ready', readyMs:10}, {status:'failed'}, {status:'timeout'}, {status:'ready', readyMs:30}]), {n:2, failures:1, timeouts:1, interrupted:0, p50Ms:10, p95Ms:30});
  assert.equal(summarize([{status:'failed'}]).p95Ms, null);
});
test('trace spans retain individual timings rather than summing nested durations', () => {
  assert.deepEqual(parseTrace('[gateway] startup trace: plugins.bootstrap 100.0ms total=200.0ms eventLoopMax=3.0ms'), {name:'plugins.bootstrap', durationMs:100, totalMs:200});
  assert.equal(parseTrace('token=secret startup trace: bad secret'), null);
});
test('HTTP success requires a literal ready true payload', () => {
  for (const body of [{ready:false}, {ready:'true'}, {ok:true}, null]) assert.equal(isReady(200, body), false);
  assert.equal(isReady(503, {ready:true}), false);
  assert.equal(isReady(200, {ready:true}), true);
});
test('synthetic startup diagnostics redact the isolated root and token', () => {
  assert.deepEqual(boundedSyntheticDiagnostic('Error at C:\\bench\\state\nToken secret\n','C:\\bench','secret'),[
    'Error at <benchmark-root>\\state','Token <redacted-token>'
  ]);
});
test('arguments reject missing paths, invalid counts, modes and unknown flags', () => {
  for (const args of [[], ['--runtime'], ['--runtime','x','--runs','0'], ['--runtime','x','--timeout-ms','NaN'], ['--runtime','x','--control-ui','both'], ['--runtime','x','--bogus']]) assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(['--runtime','x']).runs,20);
});

test('shutdown grace is configurable and rejects invalid deadlines', () => {
  assert.equal(parseArgs(['--runtime','x']).stopTimeoutMs,30000);
  assert.equal(parseArgs(['--runtime','x','--stop-timeout-ms','50']).stopTimeoutMs,50);
  assert.throws(()=>parseArgs(['--runtime','x','--stop-timeout-ms','0']));
});
test('runtime resolution finds shipped versioned Unix layout and rejects missing entry', async () => {
  const root = await mkdtemp(join(tmpdir(),'benchmark-test-'));
  try {
    await mkdir(join(root,'tools/node-v24/bin'),{recursive:true});
    await mkdir(join(root,'tools/node-v24/lib/node_modules/uniopc-engine/dist'),{recursive:true});
    await writeFile(join(root,'tools/node-v24/bin/node'),'');
    await assert.rejects(resolveRuntime(root));
    await writeFile(join(root,'tools/node-v24/lib/node_modules/uniopc-engine/dist/entry.js'),'');
    assert.equal((await resolveRuntime(root)).node,join(root,'tools/node-v24/bin/node'));
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('child environment drops inherited runtime flags, credentials and node injection', () => {
  const env=isolatedEnv('/tmp/synthetic','token',{PATH:'/bin',HOME:'/real',OPENCLAW_CONFIG_PATH:'/real/config',NODE_OPTIONS:'--require evil',ANTHROPIC_API_KEY:'secret',HTTP_PROXY:'secret'});
  assert.equal(env.HOME,undefined);
  assert.equal(env.OPENCLAW_HOME,join('/tmp/synthetic','home'));
  assert.equal(env.OPENCLAW_CONFIG_PATH,join('/tmp/synthetic','openclaw.json'));
  assert.equal(env.ANTHROPIC_API_KEY,undefined);
  assert.equal(env.NODE_OPTIONS,undefined);
  assert.equal(env.HTTP_PROXY,undefined);
});
test('a dead child fails promptly, and records no raw output', async () => {
  const sample = await runSample({node:process.execPath,entry:'/nonexistent-benchmark-entry.js'}, {timeoutMs:10000,controlUi:'enabled',cpuProfile:false}, '/tmp', 1, new AbortController().signal);
  assert.equal(sample.status,'failed');
  assert.ok(sample.elapsedMs < 9000);
  assert.equal(sample.readyMs,undefined);
  assert.ok(!JSON.stringify(sample).includes('Cannot find module'));
});

test('a hung readiness body cannot exceed the deadline, and gateway is stopped', async () => {
  const root=await mkdtemp(join(tmpdir(),'benchmark-http-test-'));
  try {
    const entry=join(root,'fake-gateway.mjs');
    await writeFile(entry,`import {createServer} from 'node:http';
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{"ready":');}).listen(port,'127.0.0.1');`);
    const sample=await runSample({node:process.execPath,entry},{timeoutMs:400,controlUi:'enabled',cpuProfile:false},root,1,new AbortController().signal);
    assert.equal(sample.status,'timeout');
    assert.ok(sample.elapsedMs<1300);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('ready false remains pending until ready true and nested trace timings remain separate', async () => {
  const root=await mkdtemp(join(tmpdir(),'benchmark-ready-test-'));
  try {
    const entry=join(root,'fake-gateway.mjs');
    await writeFile(entry,`import {createServer} from 'node:http';
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
console.log('[gateway] startup trace: outer 100.0ms total=200.0ms');
console.log('[gateway] startup trace: inner 40.0ms total=180.0ms');
let count=0;
createServer((req,res)=>{count++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ready:count>=3}));}).listen(port,'127.0.0.1');`);
    const sample=await runSample({node:process.execPath,entry},{timeoutMs:5000,controlUi:'enabled',cpuProfile:false},root,1,new AbortController().signal);
    assert.equal(sample.status,'ready');
    assert.ok(sample.readyMs>=100);
    assert.deepEqual(sample.stages.map(s=>s.durationMs),[100,40]);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('stdout and stderr fragments never splice separate trace lines together', async () => {
  const root=await mkdtemp(join(tmpdir(),'benchmark-stream-test-'));
  try {
    const entry=join(root,'fake-gateway.mjs');
    await writeFile(entry,`import {createServer} from 'node:http';
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
process.stdout.write('[gateway] startup trace: outer ');
setTimeout(()=>process.stderr.write('[gateway] startup trace: inner 40.0ms total=180.0ms\\n'),100);
setTimeout(()=>{process.stdout.write('100.0ms total=200.0ms\\n');createServer((req,res)=>res.end('{"ready":true}')).listen(port,'127.0.0.1');},200);`);
    const sample=await runSample({node:process.execPath,entry},{timeoutMs:5000,controlUi:'enabled',cpuProfile:false},root,1,new AbortController().signal);
    assert.equal(sample.status,'ready');
    assert.deepEqual(sample.stages.map(s=>s.name).sort(),['inner','outer']);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('interrupt saves completed samples, kills the child and prevents later runs', {skip:process.platform==='win32'}, async () => {
  const root=await mkdtemp(join(tmpdir(),'benchmark-interrupt-test-'));
  let child;
  try {
    const runtime=join(root,'runtime');
    const pkg=join(runtime,'tools/node/lib/node_modules/uniopc-engine');
    await mkdir(join(pkg,'dist'),{recursive:true});
    await mkdir(join(runtime,'tools/node/bin'),{recursive:true});
    await symlink(process.execPath,join(runtime,'tools/node/bin/node'));
    await writeFile(join(pkg,'package.json'),'{"version":"test"}');
    const pidFile=join(root,'gateway-pid');
    await writeFile(join(pkg,'dist/entry.js'),`const {createServer}=require('node:http');const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(pidFile)},process.pid+'\\n');
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
setTimeout(()=>createServer((req,res)=>res.end('{"ready":true}')).listen(port,'127.0.0.1'),100);`);
    const output=join(root,'report.json');
    child=spawn(process.execPath,[new URL('./benchmark-openclaw-startup.mjs',import.meta.url).pathname,'--runtime',runtime,'--runs','20','--output',output],{stdio:['ignore','pipe','pipe']});
    const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    const until=Date.now()+10000;
    let report;
    while (Date.now()<until) {
      report=await readFile(output,'utf8').then(JSON.parse).catch(()=>null);
      if (report?.samples.length) break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(report?.samples[0]?.status,'ready');
    child.kill('SIGINT');
    assert.equal((await exited).code,130);
    report=JSON.parse(await readFile(output,'utf8'));
    assert.equal(report.status,'interrupted');
    assert.ok(report.samples.length<20);
    const pids=(await readFile(pidFile,'utf8')).trim().split('\n').map(Number);
    for (const pid of pids) assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  } finally {
    child?.kill('SIGKILL');
    await rm(root,{recursive:true,force:true});
  }
});

test('cleanup never signals an already reaped child or its former process group', {skip:process.platform==='win32'}, async t => {
  const signals=[];
  t.mock.method(process,'kill',(pid,signal)=>{signals.push({pid,signal});return true;});
  await benchmark.stopChild({pid:12345,exitCode:0,signalCode:null});
  assert.deepEqual(signals,[]);
});

test('graceful child exit suppresses all subsequent process-group signals', {skip:process.platform==='win32'}, async t => {
  const child=Object.assign(new EventEmitter(),{pid:12345,exitCode:null,signalCode:null});
  const signals=[];
  t.mock.method(process,'kill',(pid,signal)=>{
    signals.push(signal);
    setImmediate(()=>{child.exitCode=0;child.emit('exit',0,null);});
    return true;
  });
  await benchmark.stopChild(child);
  assert.deepEqual(signals,['SIGTERM']);
});

test('cleanup failure is surfaced rather than permitting another sample', {skip:process.platform==='win32'}, async t => {
  const child=Object.assign(new EventEmitter(),{pid:12345,exitCode:null,signalCode:null});
  t.mock.method(process,'kill',()=>{throw Object.assign(new Error('permission denied'),{code:'EPERM'});});
  await assert.rejects(benchmark.stopChild(child),{code:'CLEANUP_FAILED'});
});

test('IPC CPU profiling captures main startup work without worker overwrites', async () => {
  const root=await mkdtemp(join(tmpdir(),'benchmark-profile-test-'));
  try {
    const entry=join(root,'fake-gateway.mjs');
    await writeFile(entry,`import {createServer} from 'node:http';import {Worker} from 'node:worker_threads';import {fileURLToPath} from 'node:url';import {realpathSync} from 'node:fs';
if(realpathSync(process.argv[1])!==realpathSync(fileURLToPath(import.meta.url)) || process.argv[2]!=='gateway' || process.execArgv.some(arg=>arg==='--import' || arg.startsWith('--import=')))process.exit(9);
function startupWork(){const until=Date.now()+150;while(Date.now()<until)Math.sqrt(Math.random());}startupWork();
const worker=new Worker('let value=0;for(let i=0;i<100000;i++)value+=Math.sqrt(i);',{eval:true});
worker.on('exit',()=>createServer((req,res)=>res.end('{"ready":true}')).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1'));
process.on('SIGTERM',()=>process.exit(0));`);
    const sample=await runSample({node:process.execPath,entry},{timeoutMs:5000,controlUi:'enabled',cpuProfile:true,output:join(root,'report.json')},root,1,new AbortController().signal);
    assert.equal(sample.status,'ready');
    assert.equal(typeof sample.cpuProfileDirectory,'string');
    const profiles=(await readdir(join(root,sample.cpuProfileDirectory))).filter(name=>name.endsWith('.cpuprofile'));
    assert.equal(profiles.length,1);
    assert.deepEqual(sample.cpuProfileFiles,profiles.sort().map(name=>join(sample.cpuProfileDirectory,name)));
    assert.equal(sample.cpuProfileStatus,'complete');
    const profile=JSON.parse(await readFile(join(root,sample.cpuProfileFiles[0]),'utf8'));
    assert.ok(profile.endTime-profile.startTime>=150000);
    assert.ok(profile.nodes.some(node=>node.callFrame.functionName==='startupWork'));
  } finally {await rm(root,{recursive:true,force:true});}
});

test('shutdown escalation is reported only after the configured graceful deadline', {skip:process.platform==='win32'}, async t => {
  const child=Object.assign(new EventEmitter(),{pid:12345,exitCode:null,signalCode:null});
  const signals=[];
  t.mock.method(process,'kill',(pid,signal)=>{
    signals.push(signal);
    if (signal==='SIGKILL') setImmediate(()=>{child.signalCode='SIGKILL';child.emit('exit',null,'SIGKILL');});
    return true;
  });
  const cleanup=await benchmark.stopChild(child,{timeoutMs:20});
  assert.deepEqual(signals,['SIGTERM','SIGKILL']);
  assert.equal(cleanup.escalated,true);
  assert.equal(cleanup.confirmed,true);
});

test('main profile is persisted at readiness before forced gateway shutdown', {skip:process.platform==='win32'}, async () => {
  const root=await mkdtemp(join(tmpdir(),'benchmark-missing-profile-test-'));
  try {
    const entry=join(root,'fake-gateway.mjs');
    await writeFile(entry,`import {createServer} from 'node:http';
process.on('SIGTERM',()=>{});
createServer((req,res)=>res.end('{"ready":true}')).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');`);
    const sample=await runSample({node:process.execPath,entry},{timeoutMs:5000,stopTimeoutMs:20,controlUi:'enabled',cpuProfile:true,output:join(root,'report.json')},root,1,new AbortController().signal);
    assert.equal(sample.status,'ready');
    assert.equal(sample.cleanup.escalated,true);
    assert.equal(sample.cpuProfileStatus,'complete');
    assert.ok(sample.cpuProfileCaptureMs>=0);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('profile ACK deadline is bounded and listeners are removed on timeout', async () => {
  const child=Object.assign(new EventEmitter(),{connected:true,exitCode:null,signalCode:null,send:()=>{}});
  assert.equal(await benchmark.captureMainProfile(child,20),'PROFILE_CAPTURE_TIMEOUT');
  assert.equal(child.listenerCount('message'),0);
  assert.equal(child.listenerCount('exit'),0);
});

test('profile launcher IPC does not keep an otherwise finished child alive', async () => {
  const root=await mkdtemp(join(tmpdir(),'benchmark-profile-exit-test-'));
  try {
    const entry=join(root,'fake-gateway.mjs');
    await writeFile(entry,'// No server or timers: process must exit despite the profiler IPC listener.');
    const sample=await runSample({node:process.execPath,entry},{timeoutMs:5000,stopTimeoutMs:20,controlUi:'enabled',cpuProfile:true,output:join(root,'report.json')},root,1,new AbortController().signal);
    assert.equal(sample.status,'failed');
    assert.equal(sample.errorCode,'EARLY_EXIT');
    assert.equal(sample.cpuProfileStatus,'main_profile_missing');
    assert.equal(sample.cpuProfileErrorCode,'PROFILE_CHILD_EXITED');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('a TERM-ignoring descendant fails cleanup, persists the current sample and prevents later runs', {skip:process.platform==='win32'}, async () => {
  const root=await mkdtemp(join(tmpdir(),'benchmark-descendant-test-'));
  let child,retained;
  const stopFile=join(root,'stop-fixture');
  const exitedFile=join(root,'descendant-exited');
  const startedFile=join(root,'descendant-started');
  try {
    const runtime=join(root,'runtime');
    const pkg=join(runtime,'tools/node/lib/node_modules/uniopc-engine');
    await mkdir(join(pkg,'dist'),{recursive:true});
    await mkdir(join(runtime,'tools/node/bin'),{recursive:true});
    await symlink(process.execPath,join(runtime,'tools/node/bin/node'));
    await writeFile(join(pkg,'package.json'),'{"version":"test"}');
    const descendant=join(root,'descendant.cjs');
    await writeFile(descendant,`const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.appendFileSync(${JSON.stringify(startedFile)},'started\\n');
setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopFile)})){fs.appendFileSync(${JSON.stringify(exitedFile)},'exited\\n');process.exit(0);}},20);
process.send('ready');`);
    await writeFile(join(pkg,'dist/entry.js'),`const {spawn}=require('node:child_process');const {createServer}=require('node:http');
const child=spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});
child.once('message',()=>createServer((req,res)=>res.end('{"ready":true}')).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1'));
process.on('SIGTERM',()=>process.exit(0));`);
    const output=join(root,'report.json');
    child=spawn(process.execPath,[new URL('./benchmark-openclaw-startup.mjs',import.meta.url).pathname,'--runtime',runtime,'--runs','3','--timeout-ms','10000','--stop-timeout-ms','500','--output',output],{stdio:'ignore'});
    const code=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('benchmark did not halt')),20000);
      child.once('exit',code=>{clearTimeout(timer);resolve(code);});
    });
    const report=JSON.parse(await readFile(output,'utf8'));
    retained=report.retainedStateDirectory;
    assert.equal(code,1);
    assert.equal(report.status,'cleanup_failed');
    assert.equal(report.samples.length,1);
    assert.equal(report.samples[0].startupStatus,'ready');
    assert.equal(report.samples[0].errorCode,'CLEANUP_FAILED');
    assert.equal(report.samples[0].cleanup.confirmed,false);
    assert.equal(report.summary.failures,1);
    await access(retained);
  } finally {
    // Test-owned control file stops only our fixture, without signalling any
    // reaped PID or potentially reused process group.
    await writeFile(stopFile,'stop');
    const startedCount=(await readFile(startedFile,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).length;
    for(let i=0;i<100;i++) {
      const exitedCount=(await readFile(exitedFile,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).length;
      if(exitedCount>=startedCount) break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    if(child && child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
    if(retained) await rm(retained,{recursive:true,force:true});
    await rm(root,{recursive:true,force:true});
  }
});
