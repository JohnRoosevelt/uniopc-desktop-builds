#!/usr/bin/env node
/** Standalone shipped-runtime benchmark; see benchmark-openclaw-startup.md. */
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { cpus, platform, arch, release, tmpdir, loadavg, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

export function parseArgs(argv) {
  const result = {runs:20, timeoutMs:90000, stopTimeoutMs:30000, controlUi:'enabled', cpuProfile:false, output:resolve('openclaw-startup-benchmark.json')};
  const keys = {'--runtime':'runtime','--runs':'runs','--timeout-ms':'timeoutMs','--stop-timeout-ms':'stopTimeoutMs','--output':'output','--control-ui':'controlUi'};
  for (let i=0;i<argv.length;i++) {
    const flag=argv[i];
    if (flag==='--cpu-profile') {result.cpuProfile=true;continue;}
    if (flag==='--help') {result.help=true;continue;}
    const key=keys[flag];
    if (!key || !argv[i+1] || argv[i+1].startsWith('--')) throw new Error('INVALID_ARGUMENT');
    result[key]=argv[++i];
  }
  if (result.help) return result;
  if (!result.runtime) throw new Error('RUNTIME_REQUIRED');
  for (const key of ['runs','timeoutMs','stopTimeoutMs']) {
    result[key]=Number(result[key]);
    if (!Number.isSafeInteger(result[key]) || result[key]<1) throw new Error('INVALID_ARGUMENT');
  }
  if (!['enabled','disabled'].includes(result.controlUi)) throw new Error('INVALID_CONTROL_UI');
  result.runtime=resolve(result.runtime); result.output=resolve(result.output);
  return result;
}
export function summarize(samples) {
  const values=samples.filter(s=>s.status==='ready' && Number.isFinite(s.readyMs)).map(s=>s.readyMs).sort((a,b)=>a-b);
  const percentile=p=>values.length ? values[Math.ceil(p*values.length)-1] : null;
  return {n:values.length, failures:samples.filter(s=>s.status==='failed').length, timeouts:samples.filter(s=>s.status==='timeout').length, interrupted:samples.filter(s=>s.status==='interrupted').length, p50Ms:percentile(.5),p95Ms:percentile(.95)};
}
export function parseTrace(line) {
  const match=/startup trace: ([a-zA-Z0-9_.-]{1,160}) ([0-9]+(?:\.[0-9]+)?)ms total=([0-9]+(?:\.[0-9]+)?)ms/.exec(line);
  return match ? {name:match[1],durationMs:Number(match[2]),totalMs:Number(match[3])} : null;
}
export function isReady(status,body) { return status===200 && body?.ready===true; }
export function boundedSyntheticDiagnostic(stderr,root,token) {
  return stderr.replaceAll(root,'<benchmark-root>').replaceAll(token,'<redacted-token>')
    .split(/\r?\n/).map(line=>line.trim()).filter(Boolean).slice(-8)
    .map(line=>line.slice(0,300));
}
export async function resolveRuntime(prefix) {
  const roots=[join(prefix,'tools/node')];
  for (const name of (await readdir(join(prefix,'tools')).catch(()=>[])).sort()) if (name.startsWith('node-v')) roots.push(join(prefix,'tools',name));
  for (const root of roots) {
    for (const [node,pkg] of [[join(root,'bin/node'),join(root,'lib/node_modules/uniopc-engine')],[join(root,'node.exe'),join(root,'node_modules/uniopc-engine')],[join(root,'bin/node.exe'),join(root,'lib/node_modules/uniopc-engine')]]) {
      const entry=join(pkg,'dist/entry.js');
      if (await Promise.all([access(node),access(entry)]).then(()=>true,()=>false)) return {node,pkg,entry};
    }
  }
  throw new Error('RUNTIME_NOT_FOUND');
}
export function isolatedEnv(root,token,source=process.env) {
  const env={};
  // Allowlist avoids model credentials, inherited OpenClaw settings, proxies,
  // NODE_OPTIONS and external config loaders; never reassign the shell's HOME.
  for (const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','LANG','LC_ALL','TZ']) if (source[key]) env[key]=source[key];
  return {...env, TMPDIR:join(root,'tmp'), TMP:join(root,'tmp'), TEMP:join(root,'tmp'), XDG_CONFIG_HOME:join(root,'home/.config'), XDG_CACHE_HOME:join(root,'home/.cache'),
    OPENCLAW_HOME:join(root,'home'),OPENCLAW_STATE_DIR:join(root,'state'),OPENCLAW_CONFIG_PATH:join(root,'openclaw.json'),OPENCLAW_WORKSPACE_DIR:join(root,'workspace'),OPENCLAW_OAUTH_DIR:join(root,'state/oauth'),OPENCLAW_GATEWAY_TOKEN:token,OPENCLAW_GATEWAY_STARTUP_TRACE:'1',OPENCLAW_NO_RESPAWN:'1',OPENCLAW_DISABLE_BONJOUR:'1',NO_COLOR:'1'};
}
async function freePort() {
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  return port;
}
export async function stopChild(child,{timeoutMs=30000}={}) {
  const result={confirmed:true,escalated:false};
  if (!child?.pid) return result;
  const live=()=>child.exitCode===null && child.signalCode===null;
  const failure=()=>Object.assign(new Error('CLEANUP_FAILED'),{code:'CLEANUP_FAILED',cleanup:{...result,confirmed:false}});
  const confirmGroupEmpty=async()=>{
    if(process.platform==='win32') return;
    const deadline=Date.now()+1000;
    while(Date.now()<deadline) {
      let listing;
      try {listing=execFileSync('/bin/ps',['-axo','pid=,pgid='],{encoding:'utf8',timeout:Math.max(1,deadline-Date.now()),maxBuffer:4*1024*1024});}
      catch {throw failure();}
      const survivors=listing.split('\n').some(line=>{
        const fields=line.trim().split(/\s+/);
        return fields.length===2 && Number(fields[1])===child.pid;
      });
      if(!survivors) return;
      await delay(Math.min(50,Math.max(0,deadline-Date.now())));
    }
    // Read-only observation is safe after reaping. Never signal survivors by a
    // former PGID: ownership is no longer strong enough to avoid PID reuse.
    throw failure();
  };
  if (!live()) {await confirmGroupEmpty();return result;}
  const waitForExit=ms=>new Promise(resolve=>{
    if (!live()) {resolve();return;}
    const finish=()=>{clearTimeout(timer);child.removeListener('exit',finish);resolve();};
    const timer=setTimeout(finish,ms);
    child.once('exit',finish);
  });
  const killGroup=signal=>{
    // Check and signal synchronously: once exit has been observed the PID/PGID
    // no longer belongs to this child and must never be signalled again.
    if (!live()) return;
    try {process.kill(-child.pid,signal);} catch(error) {
      if (error.code!=='ESRCH') throw failure();
    }
  };
  if (process.platform==='win32') {
    // Windows child.kill() can reap the leader before taskkill discovers its
    // descendants. Kill the tree first; this cannot preserve a graceful profile.
    if (live()) {
      result.escalated=true;
      try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',timeout:5000});}
      catch {await waitForExit(1000);if (live()) throw failure();}
    }
  } else {
    killGroup('SIGTERM');
    await waitForExit(timeoutMs);
    if (live()) {result.escalated=true;killGroup('SIGKILL');}
  }
  await waitForExit(1000);
  if (live()) throw failure();
  await confirmGroupEmpty();
  return result;
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function writeProfileLauncher(launcherPath,profilePath) {
  await writeFile(launcherPath,`
import { Session } from 'node:inspector';
import { isMainThread } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
if (isMainThread && process.send) {
  const session=new Session();
  const post=method=>new Promise((resolve,reject)=>session.post(method,(error,result)=>error?reject(error):resolve(result)));
  let started=false;
  try {session.connect();await post('Profiler.enable');await post('Profiler.start');started=true;} catch {}
  let stopping=false;
  process.on('message',async message=>{
    if (message?.type!=='benchmark-profile-stop' || stopping) return;
    stopping=true;
    let ok=false;
    try {
      if (!started) throw new Error('PROFILE_NOT_STARTED');
      const {profile}=await post('Profiler.stop');
      writeFileSync(${JSON.stringify(profilePath)},JSON.stringify(profile),{mode:0o600});
      ok=true;
    } catch {} finally {session.disconnect();}
    if (process.connected) process.send({type:'benchmark-profile-stopped',ok},()=>{});
  });
  process.channel?.unref();
}
// Expose the shipped entry as argv[1] before importing it: its main-module
// detection and CLI arguments stay intact without resolver-hook Node flags.
process.argv.splice(1,1);
await import(pathToFileURL(process.argv[1]).href);
`,{mode:0o600});
}
export async function captureMainProfile(child,timeoutMs=10000) {
  if (!child?.connected || child.exitCode!==null || child.signalCode!==null) return 'PROFILE_CHILD_EXITED';
  return new Promise(resolve=>{
    const finish=code=>{
      clearTimeout(timer);child.removeListener('message',message);child.removeListener('exit',exit);
      resolve(code);
    };
    const message=value=>{if(value?.type==='benchmark-profile-stopped') finish(value.ok===true?null:'PROFILE_CAPTURE_FAILED');};
    const exit=()=>finish('PROFILE_CHILD_EXITED');
    const timer=setTimeout(()=>finish('PROFILE_CAPTURE_TIMEOUT'),timeoutMs);
    child.on('message',message);child.once('exit',exit);
    try {child.send({type:'benchmark-profile-stop'},error=>{if(error) finish('PROFILE_IPC_FAILED');});}
    catch {finish('PROFILE_IPC_FAILED');}
  });
}
export async function runSample(runtime,options,root,index,signal) {
  const port=await freePort();
  const token=randomBytes(32).toString('hex');
  const args=[];
  let profileDirectory;
  if (options.cpuProfile) {
    profileDirectory=await mkdtemp(join(dirname(options.output),`openclaw-${options.controlUi}-${index}-`));
    const launcherPath=join(root,`benchmark-profiler-${index}.mjs`);
    await writeProfileLauncher(launcherPath,join(profileDirectory,'main.cpuprofile'));
    args.push(launcherPath);
  }
  args.push(runtime.entry,'gateway','run','--bind','loopback','--port',String(port),'--auth','token');
  let child,spawnError=false,exited=false;
  let lastStderr='';
  const stages=[];
  const started=performance.now();
  const deadline=started+options.timeoutMs;
  const sample={run:index,status:'timeout',stages};
  if (profileDirectory) sample.cpuProfileDirectory=relative(dirname(options.output),profileDirectory);
  try {
    if (signal.aborted) {sample.status='interrupted';return sample;}
    child=spawn(runtime.node,args,{cwd:root,env:isolatedEnv(root,token),stdio:options.cpuProfile?['ignore','pipe','pipe','ipc']:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
    child.once('error',()=>{spawnError=true;exited=true;});
    child.once('exit',()=>{exited=true;});
    const collector=()=>{
      let carry='';
      return chunk=>{
        carry=(carry+chunk.toString()).slice(-65536);
        const lines=carry.split('\n'); carry=lines.pop();
        for (const line of lines) {const stage=parseTrace(line);if (stage && stages.length<2000) stages.push(stage);}
      };
    };
    child.stdout.on('data',collector()); child.stderr.on('data',collector());
    if (process.env.UNIOPC_BENCHMARK_DIAGNOSTICS==='1') child.stderr.on('data',chunk=>{lastStderr=(lastStderr+chunk.toString()).slice(-4096);});
    while (performance.now()<deadline && !signal.aborted) {
      if (exited) {sample.status='failed';sample.errorCode=spawnError?'SPAWN_FAILED':'EARLY_EXIT';sample.exitCode=child.exitCode;break;}
      const controller=new AbortController();
      const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
      const timer=setTimeout(abort,Math.max(1,Math.min(500,deadline-performance.now())));
      try {
        const response=await fetch(`http://127.0.0.1:${port}/readyz`,{signal:controller.signal,redirect:'error'});
        const body=await response.json();
        if (!signal.aborted && !exited && performance.now()<=deadline && isReady(response.status,body)) {sample.status='ready';sample.readyMs=Math.round((performance.now()-started)*10)/10;break;}
      } catch {} finally {clearTimeout(timer);signal.removeEventListener('abort',abort);}
      await delay(Math.max(0,Math.min(50,deadline-performance.now())));
    }
    if (signal.aborted) sample.status='interrupted';
    if (sample.status==='timeout') sample.errorCode='READY_TIMEOUT';
    if (sample.status==='failed' && lastStderr) sample.syntheticDiagnostic=boundedSyntheticDiagnostic(lastStderr,root,token);
  } finally {
    sample.elapsedMs=Math.round((performance.now()-started)*10)/10;
    if (profileDirectory) {
      const captureStarted=performance.now();
      const captureError=await captureMainProfile(child);
      sample.cpuProfileCaptureMs=Math.round((performance.now()-captureStarted)*10)/10;
      sample.cpuProfileStatus=captureError?'main_profile_missing':'complete';
      if (captureError) sample.cpuProfileErrorCode=captureError;
    }
    const cleanupStarted=performance.now();
    try {sample.cleanup=await stopChild(child,{timeoutMs:options.stopTimeoutMs??30000});}
    catch(error) {
      sample.startupStatus=sample.status;
      sample.status='failed';sample.errorCode='CLEANUP_FAILED';
      sample.cleanup={...error.cleanup,confirmed:false,elapsedMs:Math.round((performance.now()-cleanupStarted)*10)/10};
      error.sample=sample;
      child?.stdout?.destroy();child?.stderr?.destroy();child?.channel?.unref();child?.unref();
      throw error;
    }
    sample.cleanup.elapsedMs=Math.round((performance.now()-cleanupStarted)*10)/10;
    if (profileDirectory) {
      const profiles=(await readdir(profileDirectory)).filter(name=>name.endsWith('.cpuprofile')).sort();
      sample.cpuProfileFiles=profiles.map(name=>join(sample.cpuProfileDirectory,name));
      if (!profiles.includes('main.cpuprofile')) sample.cpuProfileStatus='main_profile_missing';
    }
  }
  return sample;
}
async function saveReport(output,report) {
  report.summary=summarize(report.samples);
  const stages={};
  for (const sample of report.samples.filter(s=>s.status==='ready')) {
    const seen=new Set();
    for (const stage of sample.stages) {
      if (seen.has(stage.name)) continue; // One value per run; nested spans remain separate.
      seen.add(stage.name);(stages[stage.name]??=[]).push({status:'ready',readyMs:stage.durationMs});
    }
  }
  report.stageSummary=Object.fromEntries(Object.entries(stages).map(([name,values])=>[name,summarize(values)]));
  report.updatedAt=new Date().toISOString();
  const temporary=`${output}.${process.pid}.tmp`;
  await writeFile(temporary,`${JSON.stringify(report,null,2)}\n`,{mode:0o600});
  await rename(temporary,output);
}
export async function main(argv=process.argv.slice(2)) {
  const options=parseArgs(argv);
  if (options.help) {console.log('node scripts/benchmark-openclaw-startup.mjs --runtime <prefix> [--runs 20] [--timeout-ms 90000] [--stop-timeout-ms 30000] [--output report.json] [--control-ui enabled|disabled] [--cpu-profile]');return;}
  const runtime=await resolveRuntime(options.runtime);
  const root=await mkdtemp(join(tmpdir(),'openclaw-startup-benchmark-'));
  const controller=new AbortController();
  let cleanupFailed=false;
  let report;
  const interrupt=()=>controller.abort();
  process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  try {
    for (const directory of ['home','tmp','state','workspace']) await mkdir(join(root,directory),{recursive:true});
    await mkdir(dirname(options.output),{recursive:true});
    await writeFile(join(root,'openclaw.json'),JSON.stringify({agents:{defaults:{workspace:join(root,'workspace')}},gateway:{mode:'local',controlUi:{enabled:options.controlUi==='enabled'},auth:{mode:'token'}},discovery:{mdns:{mode:'off'}},update:{checkOnStart:false}}),{mode:0o600});
    const version=JSON.parse(await readFile(join(runtime.pkg,'package.json'),'utf8')).version;
    const nodeVersion=execFileSync(runtime.node,['--version'],{env:isolatedEnv(root,''),encoding:'utf8',timeout:10000}).trim();
    report={schemaVersion:1,startedAt:new Date().toISOString(),status:'running',condition:{controlUi:options.controlUi,runs:options.runs,timeoutMs:options.timeoutMs,stopTimeoutMs:options.stopTimeoutMs,pollIntervalMs:50,probeTimeoutMs:500,cpuProfile:options.cpuProfile},method:'Process cold starts; fixed synthetic workspace/state reused within this series; OS/disk caches are not flushed. First run has fresh state. Nested trace durations are not additive. No model requests.',runtime:{openclaw:version,node:nodeVersion},system:{platform:platform(),arch:arch(),release:release(),cpuModel:cpus()[0]?.model,cpuCount:cpus().length,totalMemoryBytes:totalmem(),loadAverageStart:loadavg()},samples:[]};
    if (options.cpuProfile) console.error(`CPU profiles may contain local paths and add overhead; stored in ${dirname(options.output)}`);
    await saveReport(options.output,report);
    for (let i=1;i<=options.runs && !controller.signal.aborted;i++) {
      const sample=await runSample(runtime,options,root,i,controller.signal);
      report.samples.push(sample);await saveReport(options.output,report);
      console.log(`run ${i}/${options.runs}: ${sample.status}${sample.readyMs===undefined?'':` ${sample.readyMs}ms`}`);
    }
    report.status=controller.signal.aborted?'interrupted':'complete';
    report.system.loadAverageEnd=loadavg();await saveReport(options.output,report);
    console.log(`Report: ${options.output}`);
    if (controller.signal.aborted) process.exitCode=130;
    else if (report.summary.failures || report.summary.timeouts) process.exitCode=1;
  } catch(error) {
    cleanupFailed=error.code==='CLEANUP_FAILED';
    if(cleanupFailed && report) {
      if(error.sample) report.samples.push(error.sample);
      report.status='cleanup_failed';report.retainedStateDirectory=root;
      report.system.loadAverageEnd=loadavg();
      await saveReport(options.output,report);
    }
    throw error;
  } finally {
    // A failed stop must not race a still-running gateway writing its state.
    if (!cleanupFailed) await rm(root,{recursive:true,force:true});
    process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(error=>{console.error(['INVALID_ARGUMENT','RUNTIME_REQUIRED','INVALID_CONTROL_UI','RUNTIME_NOT_FOUND','CLEANUP_FAILED'].includes(error.message)?error.message:'BENCHMARK_FAILED');process.exitCode=1;});
