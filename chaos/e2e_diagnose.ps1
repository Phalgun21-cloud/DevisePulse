# End-to-end check of slow-laptop diagnosis on THIS laptop (task 2 gate).
#
#   powershell -ExecutionPolicy Bypass -File chaos\e2e_diagnose.ps1
#
# Runs its own API on port 4100 with a throwaway database (your dev database is not touched),
# starts the real agent, runs an idle diagnosis, then runs chaos\cpu_hog.py (answering "yes" for you)
# and diagnoses under load. Writes logs and results.json to -OutDir, and prints PASS/FAIL per check.
# cpu_hog.py keeps its own safety checks: 120 s cap, refuses on battery below 30% when unplugged.

param(
  [string]$OutDir = (Join-Path $env:TEMP 'devicepulse-e2e'),
  [int]$Port = 4100,
  [int]$HogSeconds = 90,
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

$server = $agent = $hog = $null
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

  # 7. under load (the gate)
  Write-Host "== 7. cpu_hog.py for $HogSeconds s + diagnosis" -ForegroundColor Cyan
  $yes = Join-Path $OutDir 'yes.txt'
  Set-Content -Path $yes -Value 'yes' -Encoding ascii
  $hog = Start-Process python -ArgumentList @('-u', 'chaos\cpu_hog.py', '--seconds', "$HogSeconds") -WorkingDirectory $root -PassThru -NoNewWindow `
    -RedirectStandardInput $yes -RedirectStandardOutput "$OutDir\cpu_hog.log" -RedirectStandardError "$OutDir\cpu_hog.err.log"
  $running = $false
  for ($i = 0; $i -lt 20 -and -not $running -and -not $hog.HasExited; $i++) {
    Start-Sleep 1
    $running = [bool](Select-String -Path "$OutDir\cpu_hog.log" -Pattern 'Running\.' -Quiet)  # same line as the prompt: input() prints no newline
  }
  Check 'cpu_hog started (safety checks passed)' $running ((Get-Content "$OutDir\cpu_hog.log" -ErrorAction SilentlyContinue) -join ' / ')
  if ($running) {
    Start-Sleep 3
    $load = Diagnose $h $dev.id
    $report.underLoad = $load
    $top = $load.result.causes | Select-Object -First 1
    Check 'load: request completes' ($load.status -eq 'done') "$($load.statusTrail) in $($load.waitedSec)s"
    Check 'load: CPU ranked first' ($top.rule -eq 'cpu_saturated') "top=$($top.rule) cpuPct=$($top.evidence.cpuPct)"
    Check 'load: names the hog process' ($top.process -eq 'python.exe') "process=$($top.process) ($($top.evidence.topProcessCpuPct)% of CPU)"
    Check 'load: explanation names it, hedged' (($load.result.explanation -match 'python\.exe') -and ($load.result.explanation -match 'consistent with|may') -and ($load.result.explanation -notmatch 'will fail')) $load.result.explanation
  }
} catch {
  Check 'script ran to the end' $false $_.Exception.Message
} finally {
  foreach ($p in @($hog, $agent, $server)) { if ($p -and -not $p.HasExited) { Stop-Process $p.Id -Force -ErrorAction SilentlyContinue } }
  # cpu_hog workers are child processes; make sure none outlive the test
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'multiprocessing' -and $hog -and $_.ParentProcessId -eq $hog.Id } |
    ForEach-Object { Stop-Process $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $report.finishedAt = (Get-Date).ToString('s')
  $report.checks = $checks
  $report | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 (Join-Path $OutDir 'results.json')
  Write-Host ''
  $checks | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host
  $failed = @($checks | Where-Object Result -eq 'FAIL').Count
  Write-Host "$($checks.Count - $failed)/$($checks.Count) checks passed. Logs and results.json in $OutDir"
  if ($failed) { exit 1 }
}
