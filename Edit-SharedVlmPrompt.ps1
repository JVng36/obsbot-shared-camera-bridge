[CmdletBinding()]
param(
    [switch]$StatusOnly
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http

$Root = $PSScriptRoot
$ConfigPath = Join-Path $Root 'secrets.json'
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Missing private bridge configuration: $ConfigPath"
}

$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$PrincipalIds = @($Config.tokens.PSObject.Properties.Name)
if ($PrincipalIds.Count -lt 1 -or $PrincipalIds.Count -gt 8) {
    throw 'Configure 1 to 8 prompt-editor principals.'
}
foreach ($PrincipalId in $PrincipalIds) {
    if ($PrincipalId -notmatch '^[a-z][a-z0-9_-]{0,31}$' -or $PrincipalId -eq 'system') {
        throw 'Principal IDs must match ^[a-z][a-z0-9_-]{0,31}$ and must not use reserved names.'
    }
}
$AllowedPromptActors = @('system') + $PrincipalIds
$EditorPrincipal = [string]$Config.operatorPrincipal
if ($PrincipalIds -notcontains $EditorPrincipal) {
    throw 'operatorPrincipal must name one configured prompt-editor principal.'
}
$Token = [string]$Config.tokens.$EditorPrincipal
if ($Token -notmatch '^[A-Za-z0-9_-]{43,128}$') {
    throw 'Prompt-editor token is missing or invalid.'
}

$BindAddress = $null
if (-not [System.Net.IPAddress]::TryParse([string]$Config.bindHost, [ref]$BindAddress)) {
    throw 'Camera bridge destination must be a literal private IP address.'
}
$IsPrivateAddress = [System.Net.IPAddress]::IsLoopback($BindAddress)
if (-not $IsPrivateAddress -and $BindAddress.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
    $Octets = $BindAddress.GetAddressBytes()
    $IsPrivateAddress = $Octets[0] -eq 100 -and $Octets[1] -ge 64 -and $Octets[1] -le 127
}
if (-not $IsPrivateAddress) {
    throw 'Camera bridge destination must be loopback or inside Tailscale 100.64.0.0/10.'
}
if (-not [System.Net.IPAddress]::IsLoopback($BindAddress)) {
    $LocalAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | ForEach-Object IPAddress)
    if ($LocalAddresses -notcontains $BindAddress.IPAddressToString) {
        throw 'Camera bridge destination must be assigned to this host.'
    }
}
$Port = 0
if (-not [int]::TryParse([string]$Config.port, [ref]$Port) -or $Port -lt 1024 -or $Port -gt 65535) {
    throw 'Camera bridge port must be an integer from 1024 through 65535.'
}
$UriBuilder = New-Object System.UriBuilder('http', $BindAddress.IPAddressToString, $Port)
$BaseUri = $UriBuilder.Uri.AbsoluteUri.TrimEnd('/')
$MaxResponseBytes = 131072
$AllowedPaths = @(
    '/v1/status',
    '/v1/prompt/status',
    '/v1/prompt/get',
    '/v1/prompt/replace',
    '/v1/prompt/append',
    '/v1/prompt/reset'
)

$Handler = New-Object System.Net.Http.HttpClientHandler
$Handler.UseProxy = $false
$Handler.AllowAutoRedirect = $false
$Client = New-Object System.Net.Http.HttpClient($Handler)
$Client.Timeout = [TimeSpan]::FromSeconds(30)
$Client.DefaultRequestHeaders.Authorization = `
    New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $Token)

function Assert-ExactProperties {
    param([object]$Value, [string[]]$Expected)
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType]) {
        throw 'Camera bridge returned an invalid response object.'
    }
    $Actual = @($Value.PSObject.Properties.Name)
    if ($Actual.Count -ne $Expected.Count) {
        throw 'Camera bridge returned unexpected response fields.'
    }
    foreach ($Name in $Expected) {
        if ($Actual -notcontains $Name) {
            throw 'Camera bridge response is missing required fields.'
        }
    }
}

function Assert-IntegerRange {
    param([object]$Value, [long]$Minimum, [long]$Maximum)
    if ($null -eq $Value -or $Value -is [bool] -or $Value -is [string]) {
        throw 'Camera bridge returned an invalid integer field.'
    }
    try {
        $Number = [decimal]$Value
    } catch {
        throw 'Camera bridge returned an invalid integer field.'
    }
    if (
        $Number -ne [decimal]::Truncate($Number) -or
        $Number -lt [decimal]$Minimum -or
        $Number -gt [decimal]$Maximum
    ) {
        throw 'Camera bridge returned an invalid integer field.'
    }
}

function Assert-PromptActor([object]$Value) {
    if ($AllowedPromptActors -notcontains $Value) {
        throw 'Camera bridge returned an invalid prompt actor.'
    }
}

function Assert-PromptAction([object]$Value) {
    if (@('initial', 'replace', 'append', 'reset') -notcontains $Value) {
        throw 'Camera bridge returned an invalid prompt action.'
    }
}

function Get-PromptSha256([string]$Prompt) {
    $Sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Prompt)
        return ([BitConverter]::ToString($Sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $Sha.Dispose()
    }
}

function Assert-PromptMetadata {
    param([object]$Value, [switch]$IncludesPrompt)
    $MetadataNames = @('revision', 'updatedAtMs', 'updatedBy', 'action', 'chars', 'sha256', 'history')
    $ExpectedNames = if ($IncludesPrompt) { @($MetadataNames + 'prompt') } else { $MetadataNames }
    Assert-ExactProperties $Value $ExpectedNames
    Assert-IntegerRange $Value.revision 0 9007199254740991
    Assert-IntegerRange $Value.updatedAtMs 0 9007199254740991
    Assert-PromptActor $Value.updatedBy
    Assert-PromptAction $Value.action
    Assert-IntegerRange $Value.chars 1 16000
    if ([string]$Value.sha256 -notmatch '^[a-f0-9]{64}$') {
        throw 'Camera bridge returned an invalid prompt digest.'
    }
    $History = @($Value.history)
    if ($History.Count -lt 1 -or $History.Count -gt 20) {
        throw 'Camera bridge returned invalid prompt history.'
    }
    $PreviousRevision = -1L
    $PreviousTime = -1L
    foreach ($Entry in $History) {
        Assert-ExactProperties $Entry @('revision', 'updatedAtMs', 'updatedBy', 'action', 'chars', 'sha256')
        Assert-IntegerRange $Entry.revision 0 9007199254740991
        Assert-IntegerRange $Entry.updatedAtMs 0 9007199254740991
        Assert-PromptActor $Entry.updatedBy
        Assert-PromptAction $Entry.action
        Assert-IntegerRange $Entry.chars 1 16000
        if ([string]$Entry.sha256 -notmatch '^[a-f0-9]{64}$') {
            throw 'Camera bridge returned an invalid history digest.'
        }
        if ([long]$Entry.revision -le $PreviousRevision -or [long]$Entry.updatedAtMs -lt $PreviousTime) {
            throw 'Camera bridge returned unordered prompt history.'
        }
        $PreviousRevision = [long]$Entry.revision
        $PreviousTime = [long]$Entry.updatedAtMs
    }
    $Latest = $History[-1]
    foreach ($Name in @('revision', 'updatedAtMs', 'updatedBy', 'action', 'chars', 'sha256')) {
        if ($Value.$Name -ne $Latest.$Name) {
            throw 'Camera bridge returned inconsistent prompt metadata.'
        }
    }
    if ($IncludesPrompt) {
        if ($Value.prompt -isnot [string] -or [string]::IsNullOrWhiteSpace($Value.prompt) -or $Value.prompt.Length -gt 16000) {
            throw 'Camera bridge returned an invalid prompt.'
        }
        if ([long]$Value.chars -ne $Value.prompt.Length -or [string]$Value.sha256 -ne (Get-PromptSha256 $Value.prompt)) {
            throw 'Camera bridge returned prompt metadata that does not match the prompt.'
        }
    }
}

function Assert-CameraStatus([object]$Value) {
    Assert-ExactProperties $Value @(
        'active', 'expiresAtMs', 'reason', 'ptzLeaseHolder', 'ptzLeaseExpiresAtMs',
        'promptRevision', 'promptUpdatedAtMs', 'promptUpdatedBy', 'promptAction',
        'promptChars', 'promptSha256'
    )
    if ($Value.active -isnot [bool]) { throw 'Camera bridge returned an invalid active flag.' }
    Assert-IntegerRange $Value.expiresAtMs 0 9007199254740991
    Assert-IntegerRange $Value.promptRevision 0 9007199254740991
    Assert-IntegerRange $Value.promptUpdatedAtMs 0 9007199254740991
    Assert-PromptActor $Value.promptUpdatedBy
    Assert-PromptAction $Value.promptAction
    Assert-IntegerRange $Value.promptChars 1 16000
    if ([string]$Value.promptSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid prompt digest.' }
    if ($Value.active -and $null -ne $Value.reason) { throw 'Active session returned a terminal reason.' }
    if (-not $Value.active -and @('stopped', 'expired', 'operator', 'failure') -notcontains $Value.reason) {
        throw 'Inactive session returned an invalid terminal reason.'
    }
    if ($null -ne $Value.ptzLeaseHolder -and $PrincipalIds -notcontains $Value.ptzLeaseHolder) {
        throw 'Camera bridge returned an invalid PTZ holder.'
    }
    if ($null -ne $Value.ptzLeaseExpiresAtMs) {
        Assert-IntegerRange $Value.ptzLeaseExpiresAtMs 0 9007199254740991
    }
}

function Assert-CameraResponse([string]$Path, [object]$Value) {
    switch ($Path) {
        '/v1/status' { Assert-CameraStatus $Value; break }
        '/v1/prompt/get' { Assert-PromptMetadata $Value -IncludesPrompt; break }
        '/v1/prompt/status' { Assert-PromptMetadata $Value; break }
        '/v1/prompt/replace' { Assert-PromptMetadata $Value; break }
        '/v1/prompt/append' { Assert-PromptMetadata $Value; break }
        '/v1/prompt/reset' { Assert-PromptMetadata $Value; break }
        default { throw 'Prompt editor route is not allowlisted.' }
    }
}

function Read-BoundedJsonText([System.Net.Http.HttpResponseMessage]$Response) {
    $ContentType = [string]$Response.Content.Headers.ContentType.MediaType
    if ($ContentType -ne 'application/json') { throw 'Camera bridge returned an invalid content type.' }
    $Declared = $Response.Content.Headers.ContentLength
    if ($null -ne $Declared -and [long]$Declared -gt $MaxResponseBytes) {
        throw 'Camera bridge response exceeded the text-only limit.'
    }
    $Stream = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $Memory = New-Object System.IO.MemoryStream
    $Buffer = New-Object byte[] 4096
    $Total = 0
    try {
        while (($Read = $Stream.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
            $Total += $Read
            if ($Total -gt $MaxResponseBytes) { throw 'Camera bridge response exceeded the text-only limit.' }
            $Memory.Write($Buffer, 0, $Read)
        }
        $StrictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
        return $StrictUtf8.GetString($Memory.ToArray())
    } finally {
        $Memory.Dispose()
        $Stream.Dispose()
    }
}

function Invoke-CameraApi {
    param(
        [Parameter(Mandatory)] [ValidateSet('GET', 'POST')] [string] $Method,
        [Parameter(Mandatory)] [string] $Path,
        [object] $Body = $null
    )
    if ($AllowedPaths -notcontains $Path) { throw 'Prompt editor route is not allowlisted.' }
    $HttpMethod = if ($Method -eq 'GET') { [System.Net.Http.HttpMethod]::Get } else { [System.Net.Http.HttpMethod]::Post }
    $Request = New-Object System.Net.Http.HttpRequestMessage($HttpMethod, "$BaseUri$Path")
    try {
        if ($null -ne $Body) {
            $Json = $Body | ConvertTo-Json -Compress -Depth 6
            if ([System.Text.Encoding]::UTF8.GetByteCount($Json) -gt 131072) { throw 'Prompt request exceeded the byte limit.' }
            $Request.Content = New-Object System.Net.Http.StringContent($Json, [System.Text.Encoding]::UTF8, 'application/json')
        }
        $Response = $Client.SendAsync(
            $Request,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
        ).GetAwaiter().GetResult()
        try {
            if (-not $Response.IsSuccessStatusCode) {
                throw "Camera bridge HTTP $([int]$Response.StatusCode): request rejected"
            }
            $Text = Read-BoundedJsonText $Response
            if ([string]::IsNullOrWhiteSpace($Text)) { throw 'Camera bridge returned an empty response.' }
            try { $Value = $Text | ConvertFrom-Json } catch { throw 'Camera bridge returned invalid JSON.' }
            Assert-CameraResponse $Path $Value
            return $Value
        } finally {
            $Response.Dispose()
        }
    } finally {
        $Request.Dispose()
    }
}

if ($StatusOnly) {
    try {
        $State = Invoke-CameraApi -Method GET -Path '/v1/prompt/status'
        [pscustomobject]@{
            revision = $State.revision
            updatedAtMs = $State.updatedAtMs
            updatedBy = $State.updatedBy
            action = $State.action
            chars = $State.chars
            sha256 = $State.sha256
            historyCount = @($State.history).Count
        } | ConvertTo-Json -Compress
    } finally {
        $Client.Dispose()
        $Handler.Dispose()
    }
    exit 0
}

$Form = New-Object System.Windows.Forms.Form
$Form.Text = 'Shared VLM Prompt Editor'
$Form.Size = New-Object System.Drawing.Size(1000, 780)
$Form.StartPosition = 'CenterScreen'
$Form.MinimumSize = New-Object System.Drawing.Size(850, 650)

$StatusLabel = New-Object System.Windows.Forms.Label
$StatusLabel.Location = New-Object System.Drawing.Point(12, 12)
$StatusLabel.Size = New-Object System.Drawing.Size(955, 44)
$StatusLabel.Text = 'Connecting to active camera session...'
$Form.Controls.Add($StatusLabel)

$RefreshButton = New-Object System.Windows.Forms.Button
$RefreshButton.Location = New-Object System.Drawing.Point(12, 60)
$RefreshButton.Size = New-Object System.Drawing.Size(100, 30)
$RefreshButton.Text = 'Reload'
$Form.Controls.Add($RefreshButton)

$ReplaceButton = New-Object System.Windows.Forms.Button
$ReplaceButton.Location = New-Object System.Drawing.Point(120, 60)
$ReplaceButton.Size = New-Object System.Drawing.Size(140, 30)
$ReplaceButton.Text = 'Replace complete'
$Form.Controls.Add($ReplaceButton)

$ResetButton = New-Object System.Windows.Forms.Button
$ResetButton.Location = New-Object System.Drawing.Point(268, 60)
$ResetButton.Size = New-Object System.Drawing.Size(120, 30)
$ResetButton.Text = 'Reset default'
$Form.Controls.Add($ResetButton)

$PromptLabel = New-Object System.Windows.Forms.Label
$PromptLabel.Location = New-Object System.Drawing.Point(12, 100)
$PromptLabel.Size = New-Object System.Drawing.Size(300, 20)
$PromptLabel.Text = 'Complete active VLM system prompt'
$Form.Controls.Add($PromptLabel)

$PromptBox = New-Object System.Windows.Forms.TextBox
$PromptBox.Location = New-Object System.Drawing.Point(12, 124)
$PromptBox.Size = New-Object System.Drawing.Size(700, 420)
$PromptBox.Multiline = $true
$PromptBox.ScrollBars = 'Both'
$PromptBox.AcceptsReturn = $true
$PromptBox.AcceptsTab = $true
$PromptBox.WordWrap = $false
$PromptBox.Font = New-Object System.Drawing.Font('Consolas', 10)
$PromptBox.Anchor = 'Top,Bottom,Left,Right'
$Form.Controls.Add($PromptBox)

$HistoryLabel = New-Object System.Windows.Forms.Label
$HistoryLabel.Location = New-Object System.Drawing.Point(725, 100)
$HistoryLabel.Size = New-Object System.Drawing.Size(240, 20)
$HistoryLabel.Text = 'Recent revision metadata'
$HistoryLabel.Anchor = 'Top,Right'
$Form.Controls.Add($HistoryLabel)

$HistoryList = New-Object System.Windows.Forms.ListBox
$HistoryList.Location = New-Object System.Drawing.Point(725, 124)
$HistoryList.Size = New-Object System.Drawing.Size(240, 420)
$HistoryList.Anchor = 'Top,Bottom,Right'
$Form.Controls.Add($HistoryList)

$AppendLabel = New-Object System.Windows.Forms.Label
$AppendLabel.Location = New-Object System.Drawing.Point(12, 556)
$AppendLabel.Size = New-Object System.Drawing.Size(300, 20)
$AppendLabel.Text = 'Append experimental instructions'
$AppendLabel.Anchor = 'Bottom,Left'
$Form.Controls.Add($AppendLabel)

$AppendBox = New-Object System.Windows.Forms.TextBox
$AppendBox.Location = New-Object System.Drawing.Point(12, 580)
$AppendBox.Size = New-Object System.Drawing.Size(815, 110)
$AppendBox.Multiline = $true
$AppendBox.ScrollBars = 'Vertical'
$AppendBox.Anchor = 'Bottom,Left,Right'
$Form.Controls.Add($AppendBox)

$AppendButton = New-Object System.Windows.Forms.Button
$AppendButton.Location = New-Object System.Drawing.Point(840, 580)
$AppendButton.Size = New-Object System.Drawing.Size(125, 38)
$AppendButton.Text = 'Append'
$AppendButton.Anchor = 'Bottom,Right'
$Form.Controls.Add($AppendButton)

$script:Revision = $null

function Show-EditorError([string] $Message) {
    [System.Windows.Forms.MessageBox]::Show(
        $Message,
        'Shared VLM Prompt Editor',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
}

function Update-PromptView {
    $PromptState = Invoke-CameraApi -Method GET -Path '/v1/prompt/get'
    $CameraState = Invoke-CameraApi -Method GET -Path '/v1/status'
    $script:Revision = [int]$PromptState.revision
    $PromptBox.Text = [string]$PromptState.prompt
    $Expires = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$CameraState.expiresAtMs).ToLocalTime()
    $StatusLabel.Text = (
        "ACTIVE until {0} | revision {1} | {2} by {3} | {4} chars | sha256 {5}" -f
        $Expires.ToString('yyyy-MM-dd HH:mm:ss'),
        $PromptState.revision,
        $PromptState.action,
        $PromptState.updatedBy,
        $PromptState.chars,
        ([string]$PromptState.sha256).Substring(0, 12)
    )
    $HistoryList.Items.Clear()
    foreach ($Entry in $PromptState.history) {
        $When = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$Entry.updatedAtMs).ToLocalTime()
        [void]$HistoryList.Items.Add(
            ("r{0} {1} {2} by {3} ({4} chars)" -f
                $Entry.revision,
                $When.ToString('HH:mm:ss'),
                $Entry.action,
                $Entry.updatedBy,
                $Entry.chars)
        )
    }
}

$RefreshButton.Add_Click({
    try { Update-PromptView } catch { Show-EditorError $_.Exception.Message }
})

$ReplaceButton.Add_Click({
    if ($null -eq $script:Revision) { Show-EditorError 'Reload the active prompt first.'; return }
    if ([string]::IsNullOrWhiteSpace($PromptBox.Text) -or $PromptBox.Text.Length -gt 16000) {
        Show-EditorError 'The complete prompt must contain 1 to 16000 characters.'
        return
    }
    $Answer = [System.Windows.Forms.MessageBox]::Show(
        "Replace the complete shared prompt at revision $script:Revision?",
        'Confirm live prompt replacement',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    )
    if ($Answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    try {
        [void](Invoke-CameraApi -Method POST -Path '/v1/prompt/replace' -Body ([ordered]@{
            prompt = $PromptBox.Text
            expectedRevision = $script:Revision
        }))
        Update-PromptView
    } catch { Show-EditorError $_.Exception.Message }
})

$AppendButton.Add_Click({
    if ($null -eq $script:Revision) { Show-EditorError 'Reload the active prompt first.'; return }
    if ([string]::IsNullOrWhiteSpace($AppendBox.Text)) {
        Show-EditorError 'Append text cannot be empty.'
        return
    }
    try {
        [void](Invoke-CameraApi -Method POST -Path '/v1/prompt/append' -Body ([ordered]@{
            text = $AppendBox.Text
            expectedRevision = $script:Revision
        }))
        $AppendBox.Clear()
        Update-PromptView
    } catch { Show-EditorError $_.Exception.Message }
})

$ResetButton.Add_Click({
    if ($null -eq $script:Revision) { Show-EditorError 'Reload the active prompt first.'; return }
    $Answer = [System.Windows.Forms.MessageBox]::Show(
        "Reset the shared prompt to the original default from revision $script:Revision?",
        'Confirm prompt reset',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question
    )
    if ($Answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    try {
        [void](Invoke-CameraApi -Method POST -Path '/v1/prompt/reset' -Body ([ordered]@{
            expectedRevision = $script:Revision
        }))
        Update-PromptView
    } catch { Show-EditorError $_.Exception.Message }
})

$Form.Add_Shown({
    try { Update-PromptView } catch { Show-EditorError $_.Exception.Message }
})
$Form.Add_FormClosed({ $Client.Dispose(); $Handler.Dispose() })

[void]$Form.ShowDialog()
