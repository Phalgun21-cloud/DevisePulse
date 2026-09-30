# End-to-end check of slow-laptop diagnosis on THIS laptop (task 2 gate).
#
#   powershell -ExecutionPolicy Bypass -File chaos\e2e_diagnose.ps1
#
# Runs its own API on port 4100 with a throwaway database (your dev database is not touched),
# starts the real agent, runs an idle diagnosis, then for each scenario runs a chaos\*_hog.py script
# (answering "yes" for you) and diagnoses under that load. Writes logs and results.json to -OutDir and prints
# PASS / FAIL / N/A per check. N/A means this laptop cannot measure that rule (the rule was skipped, reading null).
# The hog scripts keep their own safety checks (time cap, battery, memory and disk-space limits).
#
#   -Scenarios cpu,memory,disk   (default: all three)

param(
  [string]$OutDir = (Join-Path $env:TEMP 'devicepulse-e2e'),
  [int]$Port = 4100,
  [int]$HogSeconds = 60,
  [string[]]$Scenarios = @('cpu', 'memory', 'disk'),
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$b = "http://localhost:$Port"
New-Item -ItemType Directory -Force $OutDir | Out-Null
Get-ChildItem $OutDir -File | Remove-Item -Force
$checks = New-Object System.Collections.ArrayList
$report = [ordered]@{ startedAt = (Get-Date).ToString('s'); machine = $env:COMPUTERNAME }

function Check($name, [bool]$ok, $detail) {
  [void]$checks.Add([pscustomobject]@{ Check = $name; Result = $(if ($ok) { 'PASS' } else { 'FAIL' }); Detail = "$detail" })
  Write-Host ("[{0}] {1}  {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
}

function Info($name, $detail) {
  [void]$checks.Add([pscustomobject]@{ Check = $name; Result = 'INFO'; Detail = "$detail" })
  Write-Host "[INFO] $name  $detail" -ForegroundColor Cyan
}

function NotMeasurable($name, $detail) {
  [void]$checks.Add([pscustomobject]@{ Check = $name; Result = 'N/A'; Detail = "$detail" })
  Write-Host "[N/A ] $name  $detail" -ForegroundColor Yellow
}

# Start a hog, wait until it says it is loaded, diagnose, stop it. Returns the diagnosis (or $null).
function UnderLoad($label, $script, $readyPattern, $h, $deviceId) {
  $log = Join-Path $OutDir "$label.log"
  $yes = Join-Path $OutDir "$label.stdin.txt"  # one per hog: worker processes inherit and hold it open
  Set-Content -Path $yes -Value 'yes' -Encoding ascii
  $p = Start-Process python -ArgumentList @('-u', $script, '--seconds', "$HogSeconds") -WorkingDirectory $root -PassThru -NoNewWindow `
    -RedirectStandardInput $yes -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $script:hogs += $p
  $ready = $false
  for ($i = 0; $i -lt 60 -and -not $ready -and -not $p.HasExited; $i++) {
    Start-Sleep 1
    $ready = [bool](Select-String -Path $log -Pattern $readyPattern -Quiet)
  }
  Check "${label}: hog started (safety checks passed)" $ready ((Get-Content $log -ErrorAction SilentlyContinue) -join ' / ')
  if (-not $ready) { if (-not $p.HasExited) { Stop-Process $p.Id -Force }; return $null }
  Start-Sleep 3
  $d = Diagnose $h $deviceId
  # Let the hog end on its own so it cleans up and the next scenario is not measured on top of it.
  Write-Host "   waiting for $label hog to finish its run..."
  if (-not $p.WaitForExit(($HogSeconds + 30) * 1000)) { Stop-Process $p.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep 3
  $report[$label] = $d
  Check "${label}: request completes" ($d.status -eq 'done') "$($d.statusTrail) in $($d.waitedSec)s"
  return $d
}

function Diagnose($h, $deviceId, [int]$timeoutSec = 75) {
  $req = Invoke-RestMethod -Method Post "$b/api/devices/$deviceId/diagnose" -Headers $h
  $t0 = Get-Date
  $seen = @($req.status)
  do {
    Start-Sleep 2
    $r = Invoke-RestMethod "$b/api/devices/$deviceId/diagnose/$($req.id)" -Headers $h
    if ($seen[-1] -ne $r.status) { $seen += $r.status }
  } until ($r.status -in 'done', 'expired' -or ((Get-Date) - $t0).TotalSeconds -gt $timeoutSec)
  $r | Add-Member -NotePropertyName statusTrail -NotePropertyValue ($seen -join ' -> ')
  $r | Add-Member -NotePropertyName waitedSec -NotePropertyValue ([math]::Round(((Get-Date) - $t0).TotalSeconds))
  return $r
}

$server = $agent = $null
$script:hogs = @()
try {
  # 1. unit and API tests
  if (-not $SkipTests) {
    Write-Host '== 1. npm test' -ForegroundColor Cyan
    Push-Location $root
    cmd /c "npm test > `"$OutDir\npm-test.log`" 2>&1"
    $testExit = $LASTEXITCODE
    Pop-Location
    $summary = (Select-String -Path "$OutDir\npm-test.log" -Pattern 'Tests\s+\d+|\d+ passed|failed' | ForEach-Object { $_.Line.Trim() }) -join ' | '
    Check 'npm test' ($testExit -eq 0) $summary
    if ($testExit -ne 0) { throw 'Tests failed; see npm-test.log' }
  }

  # 2. API with a throwaway database
  Write-Host '== 2. start API' -ForegroundColor Cyan
  $env:PORT = "$Port"
  $env:JWT_SECRET = "e2e-$([guid]::NewGuid().ToString('N'))"
  $env:DATABASE_FILE = Join-Path $OutDir 'e2e.db'
  $server = Start-Process node -ArgumentList 'src/index.js' -WorkingDirectory (Join-Path $root 'server') -PassThru -NoNewWindow `
    -RedirectStandardOutput "$OutDir\server.log" -RedirectStandardError "$OutDir\server.err.log"
  $up = $false
  for ($i = 0; $i -lt 20 -and -not $up; $i++) {
    Start-Sleep -Milliseconds 500
    try { $up = (Invoke-RestMethod "$b/api/health").ok } catch { }
  }
  Check 'API starts' $up "$b/api/health"
  if (-not $up) { throw 'API did not start; see server.err.log' }

  # 3. account + device
  $cred = '{"email":"e2e@example.com","password":"a-long-e2e-password"}'
  Invoke-RestMethod -Method Post "$b/api/auth/register" -ContentType application/json -Body $cred | Out-Null
  $jwt = (Invoke-RestMethod -Method Post "$b/api/auth/login" -ContentType application/json -Body $cred).token
  $h = @{ Authorization = "Bearer $jwt" }
  $dev = Invoke-RestMethod -Method Post "$b/api/devices" -ContentType application/json -Headers $h -Body '{"name":"e2e-laptop"}'
  Check 'account + device created' ([bool]$dev.deviceToken) "device id $($dev.id)"

  # 4. real agent
  Write-Host '== 4. start agent' -ForegroundColor Cyan
  $agent = Start-Process python -ArgumentList @('-u', 'agent\agent.py', '--server', $b, '--token', $dev.deviceToken, '--buffer', (Join-Path $OutDir 'buffer.jsonl')) `
    -WorkingDirectory $root -PassThru -NoNewWindow -RedirectStandardOutput "$OutDir\agent.log" -RedirectStandardError "$OutDir\agent.err.log"
  $cpu = @()
  for ($i = 0; $i -lt 15 -and $cpu.Count -eq 0; $i++) {
    Start-Sleep 1
    $cpu = @((Invoke-RestMethod "$b/api/devices/$($dev.id)/samples?kind=cpu" -Headers $h).samples)
  }
  Check 'agent uploads a real CPU sample' ($cpu.Count -gt 0) $(if ($cpu.Count) { $cpu[-1].values | ConvertTo-Json -Compress })
  $report.firstCpuSample = $cpu | Select-Object -Last 1

  # 5. idle diagnosis
  Write-Host '== 5. idle diagnosis' -ForegroundColor Cyan
  $idle = Diagnose $h $dev.id
  $report.idle = $idle
  Check 'idle: request completes' ($idle.status -eq 'done') "$($idle.statusTrail) in $($idle.waitedSec)s"
  $idleCpu = @($idle.result.causes | Where-Object rule -eq 'cpu_saturated').Count
  Check 'idle: no CPU cause' ($idleCpu -eq 0) "verdict=$($idle.result.verdict); causes=$(($idle.result.causes | ForEach-Object rule) -join ','); skipped=$($idle.result.skippedRules -join ',')"

  # 6. ownership: another user cannot read this diagnosis
  $cred2 = '{"email":"other@example.com","password":"another-long-password"}'
  Invoke-RestMethod -Method Post "$b/api/auth/register" -ContentType application/json -Body $cred2 | Out-Null
  $jwt2 = (Invoke-RestMethod -Method Post "$b/api/auth/login" -ContentType application/json -Body $cred2).token
  $code = 0
  try { Invoke-RestMethod "$b/api/devices/$($dev.id)/diagnose/$($idle.id)" -Headers @{ Authorization = "Bearer $jwt2" } | Out-Null; $code = 200 }
  catch { $code = [int]$_.Exception.Response.StatusCode }
  Check "other user gets 404" ($code -eq 404) "HTTP $code"

  $hedged = { param($t) ($t -match 'consistent with|may') -and ($t -notmatch 'will fail') }

  # 7. CPU (the task 2 gate)
  if ($Scenarios -contains 'cpu') {
    Write-Host "== 7. cpu_hog.py + diagnosis" -ForegroundColor Cyan
    $d = UnderLoad 'cpu' 'chaos\cpu_hog.py' 'Running\.' $h $dev.id  # "Running." is on the prompt line: input() prints no newline
    if ($d) {
      $c = $d.result.causes | Where-Object rule -eq 'cpu_saturated' | Select-Object -First 1
      Check 'cpu: CPU ranked first' ($d.result.causes[0].rule -eq 'cpu_saturated') "top=$($d.result.causes[0].rule) cpuPct=$($c.evidence.cpuPct)"
      Check 'cpu: names the hog, grouped' ($c.process -eq 'python.exe' -and $c.evidence.processCount -gt 1) "process=$($c.process) x$($c.evidence.processCount) = $($c.evidence.topProcessCpuPct)% of CPU"
      Check 'cpu: explanation hedged' (& $hedged $d.result.explanation) $d.result.explanation
    }
  }

  # 8. memory
  if ($Scenarios -contains 'memory') {
    Write-Host "== 8. mem_hog.py + diagnosis" -ForegroundColor Cyan
    $d = UnderLoad 'memory' 'chaos\mem_hog.py' 'Holding|Refusing' $h $dev.id
    if ($d) {
      $c = $d.result.causes | Where-Object rule -eq 'memory_pressure' | Select-Object -First 1
      if ($d.result.skippedRules -contains 'memory_pressure') { NotMeasurable 'memory: rule fires' 'memory readings were null' }
      else { Check 'memory: memory_pressure found' ([bool]$c) "sample memUsedPct=$($d.sample.memUsedPct) swap=$($d.sample.swapActivityBytes)" }
      if ($c) {
        Check 'memory: names the hog' ($c.process -eq 'python.exe') "process=$($c.process) x$($c.evidence.processCount) = $($c.evidence.topProcessMemMb) MB"
        Check 'memory: explanation hedged' (& $hedged $d.result.explanation) $d.result.explanation
      }
    }
  }

  # 9. disk
  if ($Scenarios -contains 'disk') {
    Write-Host "== 9. disk_hog.py + diagnosis" -ForegroundColor Cyan
    $d = UnderLoad 'disk' 'chaos\disk_hog.py' 'Running on|Refusing' $h $dev.id
    if ($d) {
      $c = $d.result.causes | Where-Object rule -eq 'disk_saturated' | Select-Object -First 1
      $s = $d.sample
      if ($d.result.skippedRules -contains 'disk_saturated') {
        NotMeasurable 'disk: busy/latency measured' 'disk busy % and latency were null'
      } else {
        Check 'disk: busy/latency measured' ($null -ne $s.diskBusyPct) "busy=$($s.diskBusyPct)% latency=$($s.diskLatencyMs) ms"
        $msg = if ($c) { "fired: busy=$($c.evidence.diskBusyPct)% latency=$($c.evidence.diskLatencyMs) ms" } else { "did not fire: busy $($s.diskBusyPct)% is under the 80% threshold and latency $($s.diskLatencyMs) ms is not 3x this device's baseline (baseline needs 3 earlier diagnoses)" }
        Info 'disk: disk_saturated' $msg
      }
    }
  }
} catch {
  Check 'script ran to the end' $false $_.Exception.Message
} finally {
  # Let hogs finish their own cleanup (disk_hog deletes its temp file); force-stop only if they overrun.
  foreach ($p in $script:hogs) {
    if ($p -and -not $p.HasExited -and -not $p.WaitForExit(($HogSeconds + 30) * 1000)) { Stop-Process $p.Id -Force -ErrorAction SilentlyContinue }
  }
  foreach ($p in @($agent, $server)) { if ($p -and -not $p.HasExited) { Stop-Process $p.Id -Force -ErrorAction SilentlyContinue } }
  foreach ($label in 'cpu', 'memory', 'disk') {
    $log = Join-Path $OutDir "$label.log"
    if (Test-Path $log) {
      $done = Select-String -Path $log -Pattern '^Done\..*' | Select-Object -Last 1
      Check "${label}: hog cleaned up" ([bool]$done -and ($label -ne 'disk' -or $done.Line -match 'deleted: True')) $(if ($done) { $done.Line } else { 'no Done line' })
    }
  }
  $left = @(Get-ChildItem $env:TEMP -Filter 'devicepulse-disk-hog-*.tmp' -ErrorAction SilentlyContinue)
  $left | Remove-Item -Force -ErrorAction SilentlyContinue
  if ($Scenarios -contains 'disk') { Check 'no disk_hog temp file left' ($left.Count -eq 0) "$($left.Count) found" }
  $report.finishedAt = (Get-Date).ToString('s')
  $report.checks = $checks
  $report | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 (Join-Path $OutDir 'results.json')
  Write-Host ''
  $checks | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host
  $failed = @($checks | Where-Object Result -eq 'FAIL').Count
  $na = @($checks | Where-Object Result -eq 'N/A').Count
  Write-Host "$(@($checks | Where-Object Result -eq 'PASS').Count) passed, $failed failed, $na not measurable on this laptop. Logs and results.json in $OutDir"
  if ($failed) { exit 1 }
}
