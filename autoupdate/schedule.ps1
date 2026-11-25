# Registration runs once. Every scheduled action runs with a limited user token.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$request = ConvertFrom-Json $env:N2N_NEXUS_UPDATE_SCHEDULE
$component = $request.component
if ($component -notin 'host','client') { throw 'Invalid update component.' }
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$name = "n2n-nexus-update-$component-$userSid"
$dir = Join-Path $env:LOCALAPPDATA 'n2n-nexus\updates'
$file = Join-Path $dir "$component.ps1"
$pending = Join-Path $dir "$component-removal-pending"
if ($request.action -eq 'status') {
    if (-not [IO.File]::Exists($file)) { exit 3 }
    $task = Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -eq $name }
    if ($task -and $task.State -ne 'Disabled') { exit 0 }
    exit 3
}
if ($request.action -eq 'off') {
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    [IO.File]::WriteAllText($pending, '')
    [IO.File]::Delete($file)
    if (Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -eq $name }) {
        Unregister-ScheduledTask -TaskName $name -TaskPath '\' -Confirm:$false
    }
} elseif ($request.action -eq 'on') {
    $vars = @{}
    foreach ($key in 'PATH','NPM_CONFIG_PREFIX','NPM_CONFIG_USERCONFIG','CLAUDE_CONFIG_DIR','CODEX_HOME','PI_CODING_AGENT_DIR','SCOOP','SCOOP_GLOBAL') {
        $value = [Environment]::GetEnvironmentVariable($key)
        if ($value) { $vars[$key] = $value }
    }
    $json = ConvertTo-Json -Compress -Depth 4 @{ argv = $request.argv; environment = $vars }
    $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $body = @'
$ErrorActionPreference = 'Stop'
$data = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('PAYLOAD')))
foreach ($p in $data.environment.psobject.Properties) {
    [Environment]::SetEnvironmentVariable($p.Name, $p.Value, 'Process')
}
$exe, $arguments = $data.argv
& $exe @arguments
exit $LASTEXITCODE
'@.Replace('PAYLOAD', $payload)
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    $temp = Join-Path $dir ([IO.Path]::GetRandomFileName())
    try {
        [IO.File]::WriteAllText($temp, $body)
        if ([IO.File]::Exists($file)) { [IO.File]::Replace($temp, $file, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temp, $file) }
    } finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
    $program = Join-Path $PSHOME 'powershell.exe'
    if ($file.Contains('%')) { throw 'Task Scheduler expands percent signs in paths.' }
    $action = New-ScheduledTaskAction -Execute $program -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $file + '"')
    $trigger = New-ScheduledTaskTrigger -Daily -At 4:15AM
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
} else { throw 'Expected on or off.' }
[IO.File]::Delete($pending)
Write-Output "$name $($request.action)"
