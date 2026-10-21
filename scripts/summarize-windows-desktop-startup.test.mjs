import test from 'node:test'
import assert from 'node:assert/strict'
import {summarizeStartup} from './summarize-windows-desktop-startup.mjs'
const id=(pid=12,birth='2026-10-22T00:00:00.0000000Z')=>({pid,created_utc:birth})
const start={kind:'observer_start',observer_ms:0}
const end=(ms=1000,reason='terminal')=>({kind:'observer_end',observer_ms:ms,reason})
const event=(phase,ms,extra={})=>({kind:'app_event',observer_ms:ms,phase,outcome:phase==='startup_finished'?'connected':phase==='startup_requested'?'started':'completed',identity:id(),flight:1,attribution:'verified',...extra})
const app={kind:'process',observer_ms:1,identity:id(),role:'app',cpu_ms:null,rss_bytes:null,handles:null,read_bytes:null,write_bytes:null}
const success=[start,app,event('startup_requested',10),event('auth_ready',20),event('startup_finished',30),end()]
test('success requires a verified current flight authenticated terminal; HTTP alone never authenticates',()=>{
 assert.equal(summarizeStartup(success).result,'authenticated_connected')
 for(const rows of [ [start,{kind:'http',observer_ms:20,status:200},end()], [start,app,event('startup_requested',10),event('startup_finished',20),end()], [start,app,event('auth_ready',10),event('startup_finished',20),end()] ]) assert.equal(summarizeStartup(rows).result,'incomplete')
 for(const status of [200,301,401,503,null])assert.equal(summarizeStartup([start,{kind:'http',observer_ms:10,status},end()]).result,'incomplete')
})
test('timeout and interrupted captures are incomplete even after apparent success',()=>{
 assert.equal(summarizeStartup([...success.slice(0,-1),end(1000,'timeout')]).result,'incomplete')
 assert.equal(summarizeStartup(success.slice(0,-1)).result,'incomplete')
})
test('missing attribution, new requests, mismatched identities and stale flights cannot borrow authentication',()=>{
 for(const change of [{identity:null},{flight:null},{attribution:'unknown'},{identity:id(13)},{flight:2}])assert.equal(summarizeStartup([start,app,event('startup_requested',10),event('auth_ready',20,change),event('startup_finished',30),end()]).result,'incomplete')
 assert.equal(summarizeStartup([...success.slice(0,-1),event('startup_requested',40,{attribution:'unknown',flight:null,identity:null}),end()]).result,'incomplete')
 assert.equal(summarizeStartup([start,app,event('startup_requested',10),event('auth_ready',20),event('startup_requested',30,{flight:2}),event('startup_finished',40,{flight:2}),end()]).result,'incomplete')
})
test('duplicate requests are requests, not extra spawns or resets',()=>{
 const result=summarizeStartup([start,app,event('startup_requested',10),event('auth_ready',20),event('startup_requested',30),event('startup_finished',40),end()])
 assert.equal(result.requests,2);assert.equal(result.result,'authenticated_connected');assert.equal(result.processes.filter(p=>p.role==='gateway_candidate').length,0)
})
const process=(ms,identity,cpu,extra={})=>({kind:'process',observer_ms:ms,identity,role:'gateway_candidate',cpu_ms:cpu,rss_bytes:100,handles:5,read_bytes:cpu,write_bytes:cpu,...extra})
test('resource deltas use exact birth identity and actual monotonic intervals across PID reuse/recovery',()=>{
 const result=summarizeStartup([start,process(100,id(),100),process(2100,id(),1100),process(2200,id(12,'2026-10-22T00:01:00.0000000Z'),10000),process(2300,id(14),20000),end(2400)])
 assert.equal(result.processes.length,3);assert.equal(result.processes[0].cpu_core_percent,50);assert.equal(result.processes[1].cpu_core_percent,null);assert.equal(result.processes[2].cpu_delta_ms,null)
})
test('unavailable and reset counters remain null and break delta intervals',()=>{
 for(const counter of [null,undefined,-1,NaN]){
  const r=summarizeStartup([start,process(100,id(),100),process(200,id(),counter),process(300,id(),300),end()]);assert.equal(r.processes[0].cpu_delta_ms,null)
 }
 assert.equal(summarizeStartup([start,process(100,id(),1000),process(200,id(),1),end()]).processes[0].cpu_delta_ms,null)
})
test('UTC forward/backward jumps cannot change elapsed or rates; host receive batches are independent',()=>{
 const rows=[start,{...process(100,id(),100),utc:'2099-01-01'},{...process(1100,id(),200),utc:'1990-01-01'},end(1200)]
 const r=summarizeStartup([...rows,{kind:'host_receive',host_ms:500000},{kind:'host_receive',host_ms:510000}])
 assert.equal(r.observer_elapsed_ms,1200);assert.equal(r.processes[0].cpu_core_percent,10);assert.equal(r.host_receive_window_ms,10000)
})
test('nested spans are unions per trace origin, never added across clocks',()=>{
 const span=(clock,start_ms,duration_ms)=>({kind:'timeline_span',observer_ms:10,clock,phase:'loader',start_ms,duration_ms})
 const r=summarizeStartup([start,span(1,10000,100),span(1,10010,10),span(1,10090,50),span(2,0,20),end()])
 assert.deepEqual(r.timeline_clocks,[{capture:0,clock:1,covered_ms:140},{capture:0,clock:2,covered_ms:20}])
})
test('history, partial/invalid records, rotation and CIM lag remain explicit gaps',()=>{
 const r=summarizeStartup([event('auth_ready',0),start,null,{kind:'source_gap',observer_ms:10,reason:'rotation_or_truncation'},{kind:'sample_health',observer_ms:20,cim_timeout:true,lag_ms:300},event('startup_finished',30),end()])
 assert.equal(r.result,'incomplete');assert.equal(r.source_gaps,1);assert.equal(r.cim_timeouts,1);assert.equal(r.max_sample_lag_ms,300);assert.equal(r.invalid_records,2)
})
test('new observer captures cannot merge process rates or successful terminal evidence',()=>{
 const r=summarizeStartup([...success,start,process(10,id(),1),end(20,'timeout')]);assert.equal(r.result,'incomplete')
})
test('unknown strings, detail, profile, command line, env and tokens never survive summary',()=>{
 const secret='DO_NOT_SAVE_SECRET_PROFILE_TOKEN';const r=summarizeStartup([start,{kind:'app_event',observer_ms:1,phase:secret,detail:secret,profile:secret,env:secret},process(5,id(),1,{detail:secret,commandLine:secret}),end()])
 assert.ok(!JSON.stringify(r).includes(secret))
})
test('event rotation and terminal boundaries cannot hide a new flight or accept late authentication',()=>{
 assert.equal(summarizeStartup([start,app,event('startup_requested',10),event('auth_ready',20),{kind:'source_gap',observer_ms:25,source:'events'},event('startup_finished',30),end()]).result,'incomplete')
 const r=summarizeStartup([start,app,event('startup_requested',10),end(20),event('auth_ready',30),event('startup_finished',40)])
 assert.equal(r.result,'incomplete');assert.equal(r.invalid_records,2)
})

test('a verified tag without an observed matching app birth cannot authenticate',()=>{
 assert.equal(summarizeStartup(success.filter(row=>row!==app)).result,'incomplete')
})
