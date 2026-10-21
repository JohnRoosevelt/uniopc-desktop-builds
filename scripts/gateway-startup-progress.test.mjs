import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const preload = fileURLToPath(new URL('../src-tauri/src/services/gateway_startup_progress.cjs', import.meta.url));
const run = input => spawnSync(process.execPath, ['--require', preload, '-e', "process.stdout.write('body');require('node:fs').writeSync(1,require('node:fs').readFileSync(0))"], {input, timeout:3000});
test('first preload requires exactly one ACK plus EOF and preserves vendor EOF', () => {
  for (const input of [Buffer.alloc(0),Buffer.from([0]),Buffer.from([0xa7,0]),Buffer.from([0xa7,0xa7,0xa7])]) {
    const result = run(input); assert.equal(result.status,78); assert.equal(result.stdout.toString(),'');
  }
  const result = run(Buffer.from([0xa7])); assert.equal(result.status,0); assert.equal(result.stdout.toString(),'body');
  assert.match(result.stderr.toString(),/UNIOPC_GATEWAY_STARTUP {"event":"node_preload"}/);
});
test('entry and its descendant cannot run until ACK and close', async () => {
  const child = spawn(process.execPath,['--require',preload,'-e',"require('node:child_process').spawnSync(process.execPath,['-e',\"process.stdout.write('grandchild')\"],{stdio:['ignore',1,2]})"]);
  let output=''; child.stdout.on('data', chunk => output += chunk);
  const exited = new Promise(resolve => child.on('close',resolve));
  await new Promise(resolve => setTimeout(resolve,100)); assert.equal(output,'');
  child.stdin.write(Buffer.from([0xa7]));
  await new Promise(resolve => setTimeout(resolve,100)); assert.equal(output,'');
  child.stdin.end(); assert.equal(await exited,0); assert.equal(output,'grandchild');
});
test('listen emits only fixed numeric events and heartbeat timer does not hold exit', () => {
  const result = spawnSync(process.execPath,['--require',preload,'-e',"const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>{const next=net.createServer();next.listen(port,'127.0.0.1',()=>{process.stdout.write(String(port));next.close()})})})"],{input:Buffer.from([0xa7]),timeout:3000});
  assert.equal(result.status,0);
  const events=result.stderr.toString().trim().split('\n').map(line=>JSON.parse(line.slice('UNIOPC_GATEWAY_STARTUP '.length)));
  assert.equal(events[0].event,'node_preload');
  const port=Number(result.stdout.toString());
  assert.deepEqual(events.slice(1),[{event:'http_listen_requested',port},{event:'listening',port}]);
});

// Real subprocesses exercise inheritance; no source-text or mocked Worker checks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const fixture = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniopc-preload-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  return dir;
};
const launch = (args, options = {}) => {
  const env = {...process.env}; delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, args, {input:Buffer.from([0xa7]), timeout:8000, env, ...options});
};
const successful = result => {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr.toString());
};

test('every Worker context cleans argv before default fork and nested Worker descendants', t => {
  const dir = fixture(t);
  const extra = path.join(dir, 'extra.cjs');
  const worker = path.join(dir, 'worker.cjs');
  const child = path.join(dir, 'child.cjs');
  fs.writeFileSync(extra, 'global.extraPreload = (global.extraPreload || 0) + 1');
  const forkFunction = `async function fork(mode){return await new Promise((resolve,reject)=>{
    const c=require('node:child_process').fork(${JSON.stringify(child)},[mode],{stdio:['ignore','ignore','inherit','ipc']});
    let answer;c.on('message',v=>answer=v);c.on('error',reject);c.on('exit',code=>code?reject(new Error('fork exit '+code)):resolve(answer));
  });}`;
  const workerFunction = `async function worker(explicit,route='leaf'){
    return await new Promise((resolve,reject)=>{
      const options={workerData:{route}};
      if(explicit) options.execArgv=['--trace-warnings','--require',${JSON.stringify(preload)}];
      const w=new (require('node:worker_threads').Worker)(${JSON.stringify(worker)},options);
      let answer;w.on('message',v=>answer=v);w.on('error',reject);w.on('exit',code=>code?reject(new Error('worker exit '+code)):resolve(answer));
    });
  }`;
  fs.writeFileSync(worker, `${workerFunction}${forkFunction}
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      let descendant;
      if(workerData.route==='fork') descendant=await fork('fork');
      if(workerData.route==='worker-fork') descendant=await worker(false,'fork');
      const net=require('node:net');const first=net.createServer();
      await new Promise(resolve=>first.listen(0,'127.0.0.1',resolve));const port=first.address().port;
      await new Promise(resolve=>first.close(resolve));const second=net.createServer();
      await new Promise(resolve=>second.listen(port,'127.0.0.1',resolve));await new Promise(resolve=>second.close(resolve));
      parentPort.postMessage({argv:process.execArgv,extra:global.extraPreload||0,options:process.env.NODE_OPTIONS,descendant});
    })().catch(e=>{console.error(e);process.exit(1)});
  `);
  fs.writeFileSync(child, `${workerFunction}
    (async()=>{const result=process.argv[2]==='fork'?{argv:process.execArgv,extra:global.extraPreload||0,options:process.env.NODE_OPTIONS}:await worker(process.argv[2]==='fork-worker-explicit');process.send(result);process.disconnect()})().catch(e=>{console.error(e);process.exit(1)});
  `);
  for (const mode of ['worker', 'worker-explicit', 'fork', 'fork-worker', 'fork-worker-explicit',
    'worker-fork','worker-explicit-fork','worker-worker-fork','worker-explicit-worker-fork']) {
    const explicit=mode.includes('explicit');
    const route=mode.includes('worker-worker-fork')||mode==='worker-explicit-worker-fork'?'worker-fork':mode.endsWith('-fork')?'fork':'leaf';
    const body = `${workerFunction}${forkFunction}(async()=>{
      const result=${JSON.stringify(mode)}.startsWith('fork')?await fork(${JSON.stringify(mode)}):await worker(${explicit},${JSON.stringify(route)});
      process.stdout.write(JSON.stringify({root:process.execArgv,result,options:process.env.NODE_OPTIONS}));
    })().catch(e=>{console.error(e);process.exit(1)});`;
    const main = path.join(dir, `main-${mode}.cjs`);fs.writeFileSync(main,body);
    const rootArgs = ['--require',extra,'--trace-warnings'];
    const options = '--trace-warnings';
    const result = launch(['--require',preload,...rootArgs,main], {env:{...process.env,NODE_OPTIONS:options}});
    successful(result);
    const parsed = JSON.parse(result.stdout.toString());
    assert.deepEqual(parsed.root, rootArgs, mode);assert.equal(parsed.options,options);
    const expected=explicit?['--trace-warnings']:rootArgs;
    let observation=parsed.result;
    while(observation){
      assert.deepEqual(observation.argv,expected,mode);
      assert.equal(observation.extra,explicit?0:1,mode);assert.equal(observation.options,options);
      observation=observation.descendant;
    }
    assert.equal(result.stderr.toString().split('\n').filter(line=>line.startsWith('UNIOPC_GATEWAY_STARTUP ')).length,1,mode);
  }
});

test('canonical symlink alias removes just its one startup pair', t => {
  const dir=fixture(t);const alias=path.join(dir,'startup-alias.cjs');
  try { fs.symlinkSync(preload,alias,'file'); } catch(error) { if(error.code==='EPERM'){t.skip('file symlinks unavailable');return;}throw error; }
  const body='process.stdout.write(JSON.stringify(process.execArgv))';
  const result=launch(['--require',alias,'--trace-warnings','-e',body]);
  successful(result);assert.deepEqual(JSON.parse(result.stdout.toString()),['--trace-warnings','-e',body]);
  const duplicate=launch(['--require',preload,'--require',alias,'-e',body]);
  assert.equal(duplicate.status,78);assert.equal(duplicate.stdout.toString(),'');
});

test('duplicate aliases, ambiguous hard links, unsupported self forms, missing pairs and resolution errors fail closed', t => {
  const dir=fixture(t);const hardlink=path.join(dir,'startup-hardlink.cjs');fs.linkSync(preload,hardlink);
  const body="process.stdout.write('body-ran')";
  const cases=[
    ['--require',preload,'--require',preload],
    ['--require',preload,'--require',hardlink],
    [`--require=${preload}`],['-r',preload],
    ['--require',preload,'--import',pathToFileURL(preload).href],
    ['--require',preload,'--require',path.join(dir,'missing.cjs')],
  ];
  for(const args of cases){const result=launch([...args,'-e',body]);assert.equal(result.status,78,result.stderr.toString());assert.equal(result.stdout.toString(),'');}
  const missing=launch(['-e',body],{env:{...process.env,NODE_OPTIONS:`--require ${JSON.stringify(preload)}`}});
  assert.equal(missing.status,78);assert.equal(missing.stdout.toString(),'');
});

test('Windows canonical case aliases are accepted and duplicate case aliases are rejected', {skip:process.platform!=='win32'}, () => {
  const alias=preload.toUpperCase();const body="process.stdout.write('body')";
  const result=launch(['--require',alias,'-e',body]);successful(result);assert.equal(result.stdout.toString(),'body');
  const duplicate=launch(['--require',preload,'--require',alias,'-e',body]);assert.equal(duplicate.status,78);assert.equal(duplicate.stdout.toString(),'');
});

test('Worker cleanup rejects duplicate, ambiguous, unsupported and missing startup pairs before its body', t => {
  const dir=fixture(t);const workerFile=path.join(dir,'worker.cjs');
  const hardlink=path.join(dir,'startup-hardlink.cjs');fs.linkSync(preload,hardlink);
  fs.writeFileSync(workerFile,"require('node:worker_threads').parentPort.postMessage('body-ran')");
  const cases=[
    ['--require',preload,'--require',preload],
    ['--require',preload,'--require',hardlink],
    [`--require=${preload}`],['-r',preload],
  ];
  for(const execArgv of cases){
    const main=path.join(dir,'main.cjs');
    fs.writeFileSync(main,`const {Worker}=require('node:worker_threads');const w=new Worker(${JSON.stringify(workerFile)},{execArgv:${JSON.stringify(execArgv)}});w.on('message',()=>process.exit(1));w.on('error',()=>process.exit(2));w.on('exit',code=>{if(code!==78)process.exit(3)});`);
    const result=launch(['--require',preload,main]);successful(result);
    assert.equal(result.stderr.toString().split('\n').filter(line=>line.startsWith('UNIOPC_GATEWAY_STARTUP ')).length,1);
  }
  // NODE_OPTIONS loads the module, but its absence from public execArgv is invalid.
  const main=path.join(dir,'missing.cjs');
  fs.writeFileSync(main,`const {Worker}=require('node:worker_threads');const w=new Worker(${JSON.stringify(workerFile)},{execArgv:[],env:{...process.env,NODE_OPTIONS:${JSON.stringify(`--require ${JSON.stringify(preload)}`)}}});w.on('message',()=>process.exit(1));w.on('error',()=>process.exit(2));w.on('exit',code=>{if(code!==78)process.exit(3)});`);
  successful(launch(['--require',preload,main]));
});
