#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const phases = new Set(['startup_requested','runtime_preparation','gateway_spawn','http_ready','auth_ready','startup_finished'])
const outcomes = new Set(['started','completed','ready','failed','connected'])
const spanPhases = new Set(['runtime','loader','sdk','plugins','gateway'])
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
const identity = value => value && Number.isInteger(value.pid) && value.pid > 0 && value.pid <= 4294967295
  && typeof value.created_utc === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(value.created_utc)
  ? {pid:value.pid,created_utc:value.created_utc} : null
const key = value => `${value.pid}/${value.created_utc}`
const union = intervals => {
  const sorted=intervals.toSorted((a,b)=>a[0]-b[0]);let total=0,end=-1
  for(const [start,stop] of sorted){if(stop>end){total+=stop-Math.max(start,end);end=stop}}
  return total
}

// Input is treated as untrusted. Only fixed enums, numbers and process birth
// identities can survive into the report; unknown strings never get echoed.
export function summarizeStartup(records) {
  let capture=0,started=false,ended=false,lastMs=0,invalid=0,requests=0,unknown=0,readyResponses=0,gaps=0,cimTimeouts=0,cimFailures=0,maxLag=0
  const processes=new Map(),flights=new Map(),traces=new Map(),observedApps=new Set();let hostMin=null,hostMax=null
  let lastEventMs=-1,activeFlightKey=null,endReason=null,maxFlight=0
  for(const row of records){
    if(!row||typeof row!=='object'){invalid++;continue}
    if(row.kind==='host_receive' && finite(row.host_ms)){hostMin=Math.min(hostMin??row.host_ms,row.host_ms);hostMax=Math.max(hostMax??row.host_ms,row.host_ms);continue}
    if(!finite(row.observer_ms)){invalid++;continue}
    if(ended&&row.kind!=='observer_start'){invalid++;continue}
    if(row.kind==='observer_start'){
      if(started){capture++;processes.forEach(p=>{p.previous=null})}
      started=true;ended=false;lastEventMs=-1;activeFlightKey=null;endReason=null;maxFlight=0
    }
    if(!started||row.observer_ms<lastEventMs){invalid++;continue}
    lastEventMs=row.observer_ms;lastMs=row.observer_ms
    if(row.kind==='observer_end'){ended=true;endReason=['terminal','timeout','cancelled','error'].includes(row.reason)?row.reason:null;continue}
    if(row.kind==='source_gap'){gaps++;if(!['timeline','gateway'].includes(row.source))activeFlightKey=null;continue}
    if(row.kind==='sample_health'){
      if(row.cim_timeout===true)cimTimeouts++
      if(row.cim_error===true)cimFailures++
      if(finite(row.lag_ms))maxLag=Math.max(maxLag,row.lag_ms)
      continue
    }
    if(row.kind==='http'){
      if(Number.isInteger(row.status)&&row.status>=100&&row.status<=599){if(row.status===200)readyResponses++}
      continue
    }
    if(row.kind==='process'){
      const id=identity(row.identity)
      if(!id||!['app','gateway_candidate'].includes(row.role)){invalid++;continue}
      const processKey=`${capture}/${key(id)}`
      if(row.role==='app')observedApps.add(processKey)
      let p=processes.get(processKey)
      if(!p){p={capture,identity:id,role:row.role,samples:0,max_rss_bytes:null,max_handles:null,cpu_ms:0,cpu_interval_ms:0,read_bytes:0,write_bytes:0,io_interval_ms:0,previous:null};processes.set(processKey,p)}
      p.samples++
      if(finite(row.rss_bytes))p.max_rss_bytes=Math.max(p.max_rss_bytes??0,row.rss_bytes)
      if(finite(row.handles))p.max_handles=Math.max(p.max_handles??0,row.handles)
      const prev=p.previous,dt=prev?row.observer_ms-prev.observer_ms:0
      if(prev&&dt>0){
        if(finite(row.cpu_ms)&&finite(prev.cpu_ms)&&row.cpu_ms>=prev.cpu_ms){p.cpu_ms+=row.cpu_ms-prev.cpu_ms;p.cpu_interval_ms+=dt}
        if(finite(row.read_bytes)&&finite(prev.read_bytes)&&finite(row.write_bytes)&&finite(prev.write_bytes)
          &&row.read_bytes>=prev.read_bytes&&row.write_bytes>=prev.write_bytes){p.read_bytes+=row.read_bytes-prev.read_bytes;p.write_bytes+=row.write_bytes-prev.write_bytes;p.io_interval_ms+=dt}
      }
      // A null counter breaks the interval; it must never become a fabricated 0.
      p.previous={observer_ms:row.observer_ms,cpu_ms:row.cpu_ms,read_bytes:row.read_bytes,write_bytes:row.write_bytes}
      continue
    }
    if(row.kind==='app_event'){
      if(!phases.has(row.phase)||!outcomes.has(row.outcome)){invalid++;continue}
      if(row.phase==='startup_requested'){requests++;if(row.attribution!=='verified')activeFlightKey=null}
      const id=identity(row.identity)
      if(!Number.isInteger(row.flight)||row.flight<1||row.attribution!=='verified'||!id||!observedApps.has(`${capture}/${key(id)}`)||row.flight<maxFlight){unknown++;if(row.phase==='startup_requested')activeFlightKey=null;continue}
      const flightKey=`${capture}/${row.flight}/${key(id)}`
      let f=flights.get(flightKey)
      if(!f){f={flight:row.flight,identity:id,requested:false,auth:false,connected:false,failed:false};flights.set(flightKey,f)}
      if(row.phase==='startup_requested'){maxFlight=Math.max(maxFlight,row.flight);activeFlightKey=flightKey;f.requested=true}
      if(flightKey!==activeFlightKey)continue
      if(f.requested&&row.phase==='auth_ready'&&['completed','ready'].includes(row.outcome))f.auth=true
      if(f.requested&&row.phase==='startup_finished'){
        if(row.outcome==='connected'&&f.auth)f.connected=true
        if(row.outcome==='failed')f.failed=true
      }
      continue
    }
    if(row.kind==='timeline_span'){
      if(!Number.isInteger(row.clock)||row.clock<1||!spanPhases.has(row.phase)||!finite(row.start_ms)||!finite(row.duration_ms)||!finite(row.start_ms+row.duration_ms)){invalid++;continue}
      const traceKey=`${capture}/${row.clock}`
      if(!traces.has(traceKey))traces.set(traceKey,[])
      traces.get(traceKey).push([row.start_ms,row.start_ms+row.duration_ms])
    }
  }
  const finalFlight=flights.get(activeFlightKey)
  const success=ended&&endReason==='terminal'&&!!finalFlight?.requested&&finalFlight.auth&&finalFlight.connected&&!finalFlight.failed
  return {
    schema:1,result:success?'authenticated_connected':ended&&endReason==='terminal'&&finalFlight?.failed?'failed':'incomplete',
    reason:success?'current_flight_authenticated':unknown?'unknown_attribution':!ended?'observer_interrupted':'no_authenticated_terminal',
    observer_elapsed_ms:started?lastMs:null,
    host_receive_window_ms:hostMin!==null?hostMax-hostMin:null,
    requests,ready_http_200:readyResponses,unattributed_events:unknown,source_gaps:gaps,cim_timeouts:cimTimeouts,cim_failures:cimFailures,max_sample_lag_ms:maxLag,invalid_records:invalid,
    processes:[...processes.values()].map(({previous,cpu_ms,cpu_interval_ms,read_bytes,write_bytes,io_interval_ms,...p})=>({...p,
      cpu_core_percent:cpu_interval_ms?100*cpu_ms/cpu_interval_ms:null,
      cpu_delta_ms:cpu_interval_ms?cpu_ms:null,
      read_bytes_per_second:io_interval_ms?read_bytes*1000/io_interval_ms:null,
      write_bytes_per_second:io_interval_ms?write_bytes*1000/io_interval_ms:null})),
    // Unions remove nested/overlapping spans only inside a single trace clock.
    // Different trace origins are deliberately never added or aligned to UTC.
    timeline_clocks:[...traces.entries()].map(([traceKey,intervals])=>({capture:Number(traceKey.split('/')[0]),clock:Number(traceKey.split('/')[1]),covered_ms:union(intervals)})),
    limitations:['HTTP readiness does not prove authentication','Unidentified app events cannot establish a flight','First extraction requires a separate observation'],
  }
}

export async function summarizeFile(path) {
  if((await stat(path)).size>32*1024*1024)throw new Error('Diagnostic input exceeds 32 MiB')
  const records=(await readFile(path,'utf8')).split(/\r?\n/).filter(Boolean).map(line=>{
    if(line.length>16384)return null
    try{return JSON.parse(line)}catch{return null}
  })
  return summarizeStartup(records)
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length!==3)throw new Error('Usage: node scripts/summarize-windows-desktop-startup.mjs capture.jsonl');console.log(JSON.stringify(await summarizeFile(process.argv[2]),null,2))}
  catch{console.error('Unable to summarize diagnostic input');process.exitCode=1}
}
