[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$EditorSource = Join-Path $RepositoryRoot 'Edit-SharedVlmPrompt.ps1'
$Scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("shared-camera-editor-test-" + [guid]::NewGuid().ToString('N'))
$Token = 'x' * 43
$Timestamp = 1700000000000

function Get-FreeTcpPort([System.Net.IPAddress]$Address) {
    $Probe = New-Object System.Net.Sockets.TcpListener($Address, 0)
    try {
        $Probe.Start()
        return ([System.Net.IPEndPoint]$Probe.LocalEndpoint).Port
    } finally {
        $Probe.Stop()
    }
}

function Invoke-EditorLoopbackCase([string]$BindHost) {
    $Address = [System.Net.IPAddress]::Parse($BindHost)
    $Port = Get-FreeTcpPort $Address
    $CaseRoot = Join-Path $Scratch ($BindHost.Replace(':', '_').Replace('.', '_'))
    $ReadyPath = Join-Path $CaseRoot 'ready'
    New-Item -ItemType Directory -Path $CaseRoot -Force | Out-Null
    Copy-Item -LiteralPath $EditorSource -Destination (Join-Path $CaseRoot 'Edit-SharedVlmPrompt.ps1')

    $Config = [ordered]@{
        bindHost = $BindHost
        port = $Port
        operatorPrincipal = 'operator'
        tokens = [ordered]@{ operator = $Token }
    }
    $Config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $CaseRoot 'secrets.json') -Encoding UTF8

    $Sha = 'a' * 64
    $Payload = [ordered]@{
        revision = 0
        updatedAtMs = $Timestamp
        updatedBy = 'system'
        action = 'initial'
        chars = 700
        sha256 = $Sha
        history = @([ordered]@{
            revision = 0
            updatedAtMs = $Timestamp
            updatedBy = 'system'
            action = 'initial'
            chars = 700
            sha256 = $Sha
        })
    } | ConvertTo-Json -Compress -Depth 6

    $Server = Start-Job -ArgumentList $BindHost, $Port, $Token, $Payload, $ReadyPath -ScriptBlock {
        param($HostAddress, $ListenPort, $ExpectedToken, $ResponseJson, $ReadyFile)
        $ErrorActionPreference = 'Stop'
        $Listener = New-Object System.Net.Sockets.TcpListener(
            [System.Net.IPAddress]::Parse($HostAddress),
            [int]$ListenPort
        )
        try {
            $Listener.Start()
            [System.IO.File]::WriteAllText($ReadyFile, 'ready')
            $TcpClient = $Listener.AcceptTcpClient()
            try {
                $Stream = $TcpClient.GetStream()
                $RequestBytes = New-Object System.Collections.Generic.List[byte]
                $Tail = ''
                while ($RequestBytes.Count -lt 16384 -and $Tail -ne "`r`n`r`n") {
                    $Byte = $Stream.ReadByte()
                    if ($Byte -lt 0) { break }
                    $RequestBytes.Add([byte]$Byte)
                    $Tail = ($Tail + [char]$Byte)
                    if ($Tail.Length -gt 4) { $Tail = $Tail.Substring($Tail.Length - 4) }
                }
                $RequestText = [System.Text.Encoding]::ASCII.GetString($RequestBytes.ToArray())
                if ($RequestText -notmatch "(?im)^Authorization: Bearer $([regex]::Escape($ExpectedToken))`r?$") {
                    throw 'Editor did not send the configured bearer token.'
                }
                if ($RequestText -notmatch '(?m)^GET /v1/prompt/status HTTP/1\.[01]') {
                    throw 'Editor requested an unexpected route.'
                }
                $Body = [System.Text.Encoding]::UTF8.GetBytes($ResponseJson)
                $Header = [System.Text.Encoding]::ASCII.GetBytes(
                    "HTTP/1.1 200 OK`r`nContent-Type: application/json`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`n`r`n"
                )
                $Stream.Write($Header, 0, $Header.Length)
                $Stream.Write($Body, 0, $Body.Length)
                $Stream.Flush()
            } finally {
                $TcpClient.Dispose()
            }
        } finally {
            $Listener.Stop()
        }
    }

    try {
        $Deadline = [DateTime]::UtcNow.AddSeconds(10)
        while (-not (Test-Path -LiteralPath $ReadyPath)) {
            if ([DateTime]::UtcNow -ge $Deadline) { throw "Loopback test server failed to start for $BindHost." }
            if ($Server.State -eq 'Failed') {
                Receive-Job -Job $Server -ErrorAction Stop | Out-Null
                throw "Loopback test server failed for $BindHost."
            }
            Start-Sleep -Milliseconds 25
        }

        $EditorPath = Join-Path $CaseRoot 'Edit-SharedVlmPrompt.ps1'
        $Output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $EditorPath -StatusOnly 2>&1
        $ExitCode = $LASTEXITCODE
        Wait-Job -Job $Server -Timeout 10 | Out-Null
        Receive-Job -Job $Server -ErrorAction Stop | Out-Null
        if ($ExitCode -ne 0) {
            throw "Prompt editor failed for $BindHost with exit $ExitCode`: $($Output | Out-String)"
        }
        $JsonLine = @($Output | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^\{' })[-1]
        if ([string]::IsNullOrWhiteSpace($JsonLine)) { throw "Prompt editor returned no JSON for $BindHost." }
        $Result = $JsonLine | ConvertFrom-Json
        if ([decimal]$Result.updatedAtMs -ne [decimal]$Timestamp) {
            throw "Prompt editor changed the production-sized timestamp for $BindHost."
        }
    } finally {
        Stop-Job -Job $Server -ErrorAction SilentlyContinue
        Remove-Job -Job $Server -Force -ErrorAction SilentlyContinue
    }
}

try {
    New-Item -ItemType Directory -Path $Scratch -Force | Out-Null
    Invoke-EditorLoopbackCase '127.0.0.1'
    Invoke-EditorLoopbackCase '::1'
    'WINDOWS_EDITOR_INTEGRATION=PASS'
} finally {
    Remove-Item -LiteralPath $Scratch -Recurse -Force -ErrorAction SilentlyContinue
}
