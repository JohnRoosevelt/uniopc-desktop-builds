#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$OutputJsonl,
  [ValidateRange(1,7200)][int]$BudgetSeconds=1500,
  [ValidateRange(250,10000)][int]$IntervalMs=2000,
  [ValidateRange(100,5000)][int]$HttpTimeoutMs=1000,
  [ValidateRange(50,3000)][int]$CimTimeoutMs=500,
  [string]$EventsPath=(Join-Path $env:APPDATA 'Uniopc\diagnostics\engine-startup-events.jsonl'),
  [string]$TimelinePath,
  [string]$ReadyUrl='http://127.0.0.1:28790/readyz'
)
$ErrorActionPreference='Stop'
if($ReadyUrl -cne 'http://127.0.0.1:28790/readyz'){throw 'Only the fixed loopback readiness URL is allowed'}
if([IO.Path]::GetExtension($OutputJsonl) -ine '.jsonl'){throw 'Output must be a new .jsonl diagnostic file'}
$OutputJsonl=[IO.Path]::GetFullPath($OutputJsonl)
foreach($root in @($env:APPDATA,$env:LOCALAPPDATA)){
  if($root -and $OutputJsonl.StartsWith(([IO.Path]::GetFullPath((Join-Path $root 'Uniopc'))+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Diagnostic output must be outside application data'}
}
# Define two read-only P/Invoke signatures in memory. Add-Type is avoided:
# Windows PowerShell 5.1 can otherwise spawn an external C# compiler.
$assemblyName=New-Object Reflection.AssemblyName('UniopcStartupObserverNative')
$assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run)
$module=$assembly.DefineDynamicModule('Native')
$type=$module.DefineType('StartupObserverNative',[Reflection.TypeAttributes]'Public, Sealed, Abstract')
foreach($methodName in @('GetFileInformationByHandle','GetProcessIoCounters')){
  $method=$type.DefinePInvokeMethod($methodName,'kernel32.dll',[Reflection.MethodAttributes]'Public, Static, PinvokeImpl',
    [Reflection.CallingConventions]::Standard,[bool],[Type[]]@([IntPtr],[IntPtr]),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Auto)
  $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
}
$native=$type.CreateType()
function File-Key($File){
  $buffer=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  try{
    if(-not $native.GetMethod('GetFileInformationByHandle').Invoke($null,@($File.SafeFileHandle.DangerousGetHandle(),$buffer))){throw 'File identity unavailable'}
    return ([Runtime.InteropServices.Marshal]::ReadInt32($buffer,28).ToString()+'/'+[Runtime.InteropServices.Marshal]::ReadInt32($buffer,44).ToString()+'/'+[Runtime.InteropServices.Marshal]::ReadInt32($buffer,48).ToString())
  }finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)}
}
$clock=[Diagnostics.Stopwatch]::StartNew()
$stream=[IO.File]::Open($OutputJsonl,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
$writer=New-Object IO.StreamWriter($stream,(New-Object Text.UTF8Encoding($false)))
$writer.AutoFlush=$true
function Emit([hashtable]$Value){
  if($Value.kind -eq 'source_gap' -and $Value.source -eq 'events'){$script:activeRun=$null;$script:authSeen=$false}
  $Value.schema=1;$Value.observer_ms=[math]::Round($clock.Elapsed.TotalMilliseconds,3)
  $Value.utc=[DateTime]::UtcNow.ToString('o')
  $writer.WriteLine(($Value|ConvertTo-Json -Compress -Depth 5))
}
function NumberOrNull($Value){if($null -ne $Value){try{$n=[double]$Value;if($n -ge 0 -and $n -le 9007199254740991 -and -not [double]::IsInfinity($n)){return $n}}catch{}};return $null}
$allowedPhases=@('startup_requested','runtime_preparation','gateway_spawn','http_ready','auth_ready','startup_finished')
$allowedOutcomes=@('started','completed','ready','failed','connected')
$runMap=New-Object 'Collections.Generic.Dictionary[string,int]' ([StringComparer]::Ordinal);$runApps=New-Object 'Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal);$nextFlight=0;$activeRun=$null;$authSeen=$false;$terminal=$false
$traceMap=New-Object 'Collections.Generic.Dictionary[string,int]' ([StringComparer]::Ordinal);$nextTrace=0;$identities=@{};$lastIdentities=@{}
function Open-Source([string]$Path,[string]$Source){
  $state=@{path=$Path;source=$Source;key=$null;offset=0L;pending='';drop=$false;seen=$false;decoder=(New-Object Text.UTF8Encoding($false,$true)).GetDecoder()}
  if($Path -and [IO.File]::Exists($Path)){
    $f=[IO.File]::Open($Path,'Open','Read',([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try{$state.key=File-Key $f;$state.offset=$f.Length;$state.seen=$true
      if($f.Length -gt 0){$f.Position=$f.Length-1;$state.drop=($f.ReadByte() -ne 10)}
    }finally{$f.Dispose()}
  };return $state
}
function Event-Line([string]$Line,[string]$Source){
  if($Line.Length -gt 16384){Emit @{kind='source_gap';source=$Source;reason='oversized_line'};return}
  if($Source -eq 'gateway'){
    if(-not $Line.StartsWith('UNIOPC_GATEWAY_STARTUP ')){return}
    $Line=$Line.Substring(23)
  }
  try{$v=$Line|ConvertFrom-Json -ErrorAction Stop}catch{return}
  if($Source -eq 'events'){
    if($allowedPhases -cnotcontains $v.phase -or $allowedOutcomes -cnotcontains $v.outcome){return}
    $id=$null;$flight=$null;$attribution='unknown'
    # Current candidate lacks these fields. Order, profile and wall-clock time
    # never substitute for a verified app birth identity plus explicit run ID.
    $identityKey="$($v.appPid)/$($v.appCreatedUtc)"
    if($identities.ContainsKey($identityKey)){try{$live=Get-Process -Id ([int]$v.appPid) -ErrorAction Stop;if($live.StartTime.ToUniversalTime().ToString('o') -cne $v.appCreatedUtc){$identities.Remove($identityKey)}}catch{$identities.Remove($identityKey)}finally{if($null -ne $live){$live.Dispose();$live=$null}}}
    if($v.runId -is [string] -and $v.runId.Length -ge 1 -and $v.runId.Length -le 128 -and $identities.ContainsKey($identityKey) -and $identities[$identityKey].role -eq 'app'){
      if($v.phase -eq 'startup_requested'){
        if(-not $runMap.ContainsKey($v.runId)){$script:nextFlight++;$runMap[$v.runId]=$nextFlight;$runApps[$v.runId]=$identityKey}
        if($runMap[$v.runId] -eq $nextFlight -and $runApps[$v.runId] -ceq $identityKey){if($activeRun -cne $v.runId){$script:authSeen=$false};$script:activeRun=$v.runId}
        else{$script:activeRun=$null;$script:authSeen=$false}
      }
      if($runMap.ContainsKey($v.runId) -and $activeRun -ceq $v.runId -and $runApps[$v.runId] -ceq $identityKey){$flight=$runMap[$v.runId];$id=$identities[$identityKey].identity;$attribution='verified'}
    }
    if($v.phase -eq 'startup_requested' -and $attribution -ne 'verified'){$script:activeRun=$null;$script:authSeen=$false}
    if($attribution -eq 'verified' -and $v.phase -eq 'auth_ready' -and @('completed','ready') -contains $v.outcome){$script:authSeen=$true}
    Emit @{kind='app_event';phase=$v.phase;outcome=$v.outcome;identity=$id;flight=$flight;attribution=$attribution;phase_elapsed_ms=(NumberOrNull $v.elapsedMs)}
    if($attribution -eq 'verified' -and $v.phase -eq 'startup_finished' -and ($v.outcome -eq 'failed' -or ($v.outcome -eq 'connected' -and $authSeen))){$script:terminal=$true}
  }elseif($Source -eq 'gateway'){
    if(@('node_preload','http_listen_requested','listening','heartbeat') -cnotcontains $v.event){return}
    Emit @{kind='gateway_progress';event=$v.event;attribution='unknown';port=(NumberOrNull $v.port);uptime_ms=(NumberOrNull $v.uptime_ms);rss_bytes=(NumberOrNull $v.rss_bytes);lateness_ms=(NumberOrNull $v.lateness_ms)}
  }elseif($Source -eq 'timeline'){
    if(@('runtime','loader','sdk','plugins','gateway') -cnotcontains $v.phase -or -not ($v.clockId -is [string]) -or $v.clockId.Length -gt 128){return}
    $start=NumberOrNull $v.startMs;$duration=NumberOrNull $v.durationMs
    if($null -eq $start -or $null -eq $duration){return}
    if(-not $traceMap.ContainsKey($v.clockId)){$script:nextTrace++;$traceMap[$v.clockId]=$nextTrace}
    Emit @{kind='timeline_span';clock=$traceMap[$v.clockId];phase=$v.phase;start_ms=$start;duration_ms=$duration}
  }
}
function Read-NewLines($State){
  if(-not $State.path -or -not [IO.File]::Exists($State.path)){return}
  $f=$null
  try{
    $f=[IO.File]::Open($State.path,'Open','Read',([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $currentKey=File-Key $f
    if($State.seen -and ($State.key -ne $currentKey -or $f.Length -lt $State.offset)){
      Emit @{kind='source_gap';source=$State.source;reason='rotation_or_truncation'}
      $State.offset=$f.Length;$State.pending='';$State.drop=$false
      if($f.Length -gt 0){$f.Position=$f.Length-1;$State.drop=($f.ReadByte() -ne 10)}
      $State.decoder.Reset()
    }
    $State.key=$currentKey;$State.seen=$true;$f.Position=$State.offset
    $buffer=New-Object byte[] 65536;$chars=New-Object char[] 65536
    # A bounded read per tick avoids an unbounded catch-up queue.
    $count=$f.Read($buffer,0,$buffer.Length);$State.offset+=$count
    if($count -eq 0){return}
    $charCount=$State.decoder.GetChars($buffer,0,$count,$chars,0,$false)
    $text=$State.pending+(New-Object string($chars,0,$charCount));$State.pending=''
    $lines=$text.Split([char]10)
    for($lineIndex=0;$lineIndex -lt $lines.Length-1;$lineIndex++){
      if($State.drop){$State.drop=$false;continue}
      Event-Line $lines[$lineIndex].TrimEnd([char]13) $State.source
    }
    $State.pending=$lines[$lines.Length-1]
    if($State.pending.Length -gt 16384){$State.pending='';$State.drop=$true;Emit @{kind='source_gap';source=$State.source;reason='oversized_partial'}}
  }catch{
    $State.pending='';$State.drop=$true;$State.decoder.Reset();Emit @{kind='source_gap';source=$State.source;reason='read_or_decode_unavailable'}
  }finally{if($null -ne $f){$f.Dispose()}}
}
function Probe-Ready {
  $request=[Net.HttpWebRequest]::Create($ReadyUrl);$request.Proxy=$null;$request.AllowAutoRedirect=$false;$request.KeepAlive=$false
  $remaining=[math]::Max(1,[math]::Min($HttpTimeoutMs,$BudgetSeconds*1000-$clock.Elapsed.TotalMilliseconds))
  $request.Timeout=[int]$remaining;$request.ReadWriteTimeout=[int]$remaining
  $response=$null;$body=$null;$status=$null;$length=0;$truncated=$false;$probe=[Diagnostics.Stopwatch]::StartNew()
  try{
    try{$response=$request.GetResponse()}catch [Net.WebException]{if($null -ne $_.Exception.Response){$response=$_.Exception.Response}else{throw}}
    $status=[int]$response.StatusCode;$body=$response.GetResponseStream();$buffer=New-Object byte[] 512
    while($length -le 8192 -and $probe.Elapsed.TotalMilliseconds -lt $remaining){
      if($body.CanTimeout){$body.ReadTimeout=[int][math]::Max(1,$remaining-$probe.Elapsed.TotalMilliseconds)}
      $read=$body.Read($buffer,0,[math]::Min(512,8193-$length));if($read -eq 0){break};$length+=$read
    }
    $truncated=($length -gt 8192 -or $probe.Elapsed.TotalMilliseconds -ge $remaining)
  }catch{}finally{if($null -ne $body){$body.Dispose()};if($null -ne $response){$response.Dispose()};$request.Abort()}
  Emit @{kind='http';status=$status;duration_ms=[math]::Round($probe.Elapsed.TotalMilliseconds,3);body_bytes=[math]::Min($length,8192);truncated=$truncated}
}
# One in-process CIM operation at a time. Timed-out work is retained and polled,
# never piled up as background jobs or external PowerShell processes.
$pendingCim=$null;$pendingHandle=$null
function Sample-Processes {
  $timeout=$false;$cimError=$false
  if($null -eq $script:pendingCim){
    $script:pendingCim=[PowerShell]::Create()
    [void]$script:pendingCim.AddScript('Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate -OperationTimeoutSec 1 | Select-Object ProcessId,ParentProcessId,Name,CreationDate')
    $script:pendingHandle=$script:pendingCim.BeginInvoke()
  }
  $waitMs=[int][math]::Max(0,[math]::Min($CimTimeoutMs,$BudgetSeconds*1000-$clock.Elapsed.TotalMilliseconds))
  if(-not $pendingHandle.AsyncWaitHandle.WaitOne($waitMs)){
    $timeout=$true;$script:identities=@{}
    foreach($known in $lastIdentities.Values){Emit @{kind='process';identity=$known.identity;role=$known.role;cpu_ms=$null;rss_bytes=$null;handles=$null;read_bytes=$null;write_bytes=$null}}
  }
  else{
    $rows=$pendingCim.EndInvoke($pendingHandle);$cimError=$pendingCim.HadErrors;$pendingCim.Dispose();$script:pendingCim=$null;$script:pendingHandle=$null
    $current=@{};$accepted=@{}
    foreach($row in $rows){
      if($row.Name -notin @('Uniopc.exe','node.exe')){continue}
      try{
        $p=Get-Process -Id ([int]$row.ProcessId) -ErrorAction Stop;$birth=$p.StartTime.ToUniversalTime()
        # CIM birth precision is microseconds. Reject a recycled PID snapshot.
        if($birth.ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') -cne $row.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ')){$p.Dispose();continue}
        $id=@{pid=[int]$p.Id;created_utc=$birth.ToString('o')}
        $current[[int]$p.Id]=@{process=$p;identity=$id;parent=[int]$row.ParentProcessId;name=$row.Name;birth=$birth}
      }catch{}
    }
    foreach($item in $current.Values){if($item.name -ieq 'Uniopc.exe'){$accepted[$item.identity.pid]='app'}}
    for($pass=0;$pass -lt 16;$pass++){
      $changed=$false
      foreach($item in $current.Values){
        if($item.name -ieq 'node.exe' -and -not $accepted.ContainsKey($item.identity.pid) -and $accepted.ContainsKey($item.parent) -and $current[$item.parent].birth -le $item.birth){$accepted[$item.identity.pid]='gateway_candidate';$changed=$true}
      };if(-not $changed){break}
    }
    $script:identities=@{}
    foreach($processId in $accepted.Keys){
      $item=$current[$processId];$id=$item.identity;$role=$accepted[$processId];$identityKey="$($id.pid)/$($id.created_utc)"
      $script:identities[$identityKey]=@{identity=$id;role=$role}
      $cpu=$null;$rss=$null;$handles=$null;$readBytes=$null;$writeBytes=$null
      try{$item.process.Refresh();if($item.process.StartTime.ToUniversalTime().ToString('o') -cne $id.created_utc){continue};$cpu=NumberOrNull $item.process.TotalProcessorTime.TotalMilliseconds;$rss=NumberOrNull $item.process.WorkingSet64;$handles=NumberOrNull $item.process.HandleCount
        $io=[Runtime.InteropServices.Marshal]::AllocHGlobal(48)
        try{if($native.GetMethod('GetProcessIoCounters').Invoke($null,@($item.process.Handle,$io))){$readBytes=NumberOrNull ([Runtime.InteropServices.Marshal]::ReadInt64($io,24));$writeBytes=NumberOrNull ([Runtime.InteropServices.Marshal]::ReadInt64($io,32))}}
        finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($io)}
      }catch{}
      Emit @{kind='process';identity=$id;role=$role;cpu_ms=$cpu;rss_bytes=$rss;handles=$handles;read_bytes=$readBytes;write_bytes=$writeBytes}
    }
    $script:lastIdentities=$identities.Clone()
    foreach($item in $current.Values){$item.process.Dispose()}
  }
  Emit @{kind='sample_health';cim_timeout=$timeout;cim_error=$cimError;lag_ms=$script:sampleLag}
}
$endReason='timeout'
try{
  $gatewayPath=$null
  try{
    $marker=Get-Content -LiteralPath (Join-Path $env:APPDATA 'Uniopc\active-profile.json') -Raw|ConvertFrom-Json
    if($marker.profileKey -is [string] -and $marker.profileKey -match '^[A-Za-z0-9_-]{1,128}$'){$gatewayPath=Join-Path $env:APPDATA ('Uniopc\logs\uniopc-engine-gateway-'+$marker.profileKey+'.log')}
  }catch{}
  $sources=@((Open-Source $EventsPath 'events'),(Open-Source $gatewayPath 'gateway'))
  if($TimelinePath){$sources+=(Open-Source $TimelinePath 'timeline')}
  Emit @{kind='observer_start';budget_ms=$BudgetSeconds*1000;interval_ms=$IntervalMs}
  $nextSample=0.0
  while($clock.Elapsed.TotalSeconds -lt $BudgetSeconds){
    $sampleStartMs=$clock.Elapsed.TotalMilliseconds
    $script:sampleLag=[math]::Max(0,$sampleStartMs-$nextSample)
    Sample-Processes
    foreach($source in $sources){Read-NewLines $source}
    if($terminal){$endReason='terminal';break}
    if($clock.Elapsed.TotalSeconds -lt $BudgetSeconds){Probe-Ready}
    $nextSample=$sampleStartMs+$IntervalMs
    $sleepMs=[math]::Min([math]::Max(0,$nextSample-$clock.Elapsed.TotalMilliseconds),[math]::Max(0,$BudgetSeconds*1000-$clock.Elapsed.TotalMilliseconds))
    if($sleepMs -gt 0){Start-Sleep -Milliseconds ([int]$sleepMs)}
  }
}catch{$endReason='error'}finally{
  if($null -ne $pendingCim){try{[void]$pendingCim.BeginStop($null,$null)}catch{}}
  Emit @{kind='observer_end';reason=$endReason}
  $writer.Dispose();$clock.Stop()
}
