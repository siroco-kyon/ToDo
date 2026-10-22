#requires -Version 5.1
<#!
.SYNOPSIS
Builds a signed, self-contained HAKOBI ClickOnce trial. Does not publish to a server.
.EXAMPLE
powershell -NoProfile -File scripts/build-clickonce.ps1 -InstallUrl http://127.0.0.1:4577/clickonce/ -CreateTestCertificate
.EXAMPLE
powershell -NoProfile -File scripts/build-clickonce.ps1 -InstallUrl https://hakobi.example.local/clickonce/ -CertificateThumbprint ABCDEF... -Version 1.0.5.1
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallUrl,
  [string]$Version,
  [string]$CertificateThumbprint,
  [switch]$CreateTestCertificate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$utf8 = New-Object Text.UTF8Encoding($false)

function Invoke-BuildCommand([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Command" }
}

$installUri = $null
if (-not [Uri]::TryCreate($InstallUrl, [UriKind]::Absolute, [ref]$installUri) -or
    $installUri.Scheme -notin @('http', 'https') -or $installUri.UserInfo -or
    $installUri.Query -or $installUri.Fragment) {
  throw 'InstallUrl must be an absolute HTTP(S) directory URL without credentials, query, or fragment.'
}
$InstallUrl = $installUri.AbsoluteUri.TrimEnd('/') + '/'
if ($installUri.Host -ieq 'localhost') {
  # MSBuild FormatUrl rewrites localhost to the computer name. Keep local tests reproducible.
  $loopbackUri = New-Object UriBuilder($installUri)
  $loopbackUri.Host = '127.0.0.1'
  $InstallUrl = $loopbackUri.Uri.AbsoluteUri.TrimEnd('/') + '/'
  Write-Warning "MSBuild rewrites localhost. The local trial install URL is normalized to $InstallUrl"
}
$package = Get-Content -LiteralPath (Join-Path $repoPath 'package.json') -Raw | ConvertFrom-Json
if (-not $Version) {
  if ($package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Prerelease npm versions require an explicit four-part ClickOnce Version.' }
  $Version = "$($package.version).0"
}
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'Version must have exactly four numeric components (for example 1.0.5.0).' }
foreach ($part in $Version.Split('.')) {
  if ($part.Length -gt 5 -or [int]$part -gt 65535) { throw 'Every Version component must be between 0 and 65535.' }
}
$Version = ($Version.Split('.') | ForEach-Object { [int]$_ }) -join '.'
$releasePath = Join-Path $repoPath 'release\clickonce'
$outputPath = Join-Path $releasePath $Version
if (Test-Path -LiteralPath $outputPath) { throw "Version already built: $outputPath. Use a new Version; existing releases are immutable." }
if ($CertificateThumbprint -and $CreateTestCertificate) { throw 'Choose CertificateThumbprint or CreateTestCertificate, not both.' }
if (-not $CertificateThumbprint -and -not $CreateTestCertificate) { throw 'A code-signing CertificateThumbprint or explicit CreateTestCertificate is required.' }

$dotnet = (Get-Command dotnet.exe -ErrorAction Stop).Source
$sdks = @(& $dotnet --list-sdks)
if ($LASTEXITCODE -ne 0 -or -not ($sdks -match '^10\.')) { throw 'Install the .NET 10 SDK before building ClickOnce.' }
$vswherePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswherePath)) { throw 'Visual Studio Installer / vswhere.exe is required (MSBuild with ClickOnce publishing tools).' }
$msbuildPaths = @(& $vswherePath -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe')
if ($LASTEXITCODE -ne 0 -or $msbuildPaths.Count -eq 0) { throw 'Visual Studio MSBuild was not found. Install the .NET desktop build tools and ClickOnce publishing tools.' }
$msbuildPath = $msbuildPaths[0]
$npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
$electronBuilderPath = Join-Path $repoPath 'node_modules\.bin\electron-builder.cmd'
if (-not (Test-Path -LiteralPath $electronBuilderPath)) { throw 'Run npm install in the repository before building.' }

if ($CreateTestCertificate) {
  $testSubject = 'CN=HAKOBI ClickOnce Test Publisher'
  $testFriendlyName = 'HAKOBI ClickOnce test only'
  $certificate = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object {
    $_.Subject -eq $testSubject -and $_.FriendlyName -eq $testFriendlyName -and
    $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(30)
  } | Sort-Object NotAfter -Descending | Select-Object -First 1
  if (-not $certificate) {
    $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject $testSubject `
      -FriendlyName $testFriendlyName -CertStoreLocation 'Cert:\CurrentUser\My' `
      -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable `
      -NotAfter (Get-Date).AddYears(2)
  }
  $CertificateThumbprint = $certificate.Thumbprint
  Write-Warning 'Using a local self-signed TEST publisher. This does not grant company trust or guarantee that SmartScreen allows installation.'
}
$CertificateThumbprint = ($CertificateThumbprint -replace '\s', '').ToUpperInvariant()
if ($CertificateThumbprint -notmatch '^[A-F0-9]{40}$') { throw 'CertificateThumbprint must be a 40-character certificate thumbprint.' }
$certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$CertificateThumbprint" -ErrorAction Stop
if (-not $certificate.HasPrivateKey -or $certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -le (Get-Date)) {
  throw 'The signing certificate must have an accessible private key and be within its validity period.'
}
$codeSigningUsages = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | ForEach-Object {
  $_.EnhancedKeyUsages | ForEach-Object { $_.Value }
})
if ($codeSigningUsages -notcontains '1.3.6.1.5.5.7.3.3') { throw 'The certificate must allow code signing.' }
Write-Host "ClickOnce version: $Version; certificate: $CertificateThumbprint; install URL: $InstallUrl"

Push-Location -LiteralPath $repoPath
try {
  Invoke-BuildCommand $npmPath @('run', 'generate:icons')
  Invoke-BuildCommand $npmPath @('run', 'build')
  Invoke-BuildCommand $electronBuilderPath @('--win', '--x64', '--dir', '--publish', 'never', '-c.directories.output=release/clickonce-electron')
  $payloadPath = Join-Path $repoPath 'release\clickonce-electron\win-unpacked'
  if (-not (Test-Path -LiteralPath (Join-Path $payloadPath 'HAKOBI.exe') -PathType Leaf)) { throw 'Electron did not produce win-unpacked/HAKOBI.exe.' }
  # This marker is packaged before ClickOnce computes its file hashes. Never edit a signed payload.
  $distribution = @{ distribution = 'clickonce'; version = $Version; installUrl = $InstallUrl } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $payloadPath 'resources\hakobi-distribution.json'), $distribution, $utf8)
  $stagePath = Join-Path $releasePath ('.staging-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stagePath -Force | Out-Null
  $rawRoot = Join-Path $repoPath 'release\clickonce-build'
  $rawPublishPath = Join-Path $rawRoot ([Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $rawPublishPath -Force | Out-Null
  $publishPath = $rawPublishPath.TrimEnd('\') + '\'
  $projectPath = Join-Path $repoPath 'desktop\clickonce\HAKOBI.ClickOnce.csproj'
  Invoke-BuildCommand $msbuildPath @($projectPath, '/restore', '/t:Publish', '/nologo', '/m', '/v:minimal', '/clp:Summary',
    '/p:Configuration=Release', '/p:PublishProfile=ClickOnce', '/p:RuntimeIdentifier=win-x64', '/p:SelfContained=true',
    "/p:PayloadDirectory=$payloadPath", "/p:ClickOnceInstallUrl=$InstallUrl", "/p:ClickOnceVersion=$Version",
    "/p:ManifestCertificateThumbprint=$CertificateThumbprint", "/p:PublishDir=$publishPath", "/p:PublishUrl=$publishPath")
  # The .NET SDK also writes its ordinary flat publish files to PublishDir. Only the
  # ClickOnce manifest and its version directory belong in the served distribution.
  Copy-Item -LiteralPath (Join-Path $rawPublishPath 'HAKOBI.application') -Destination $stagePath
  Copy-Item -LiteralPath (Join-Path $rawPublishPath 'Application Files') -Destination $stagePath -Recurse

  $publisherText = [Net.WebUtility]::HtmlEncode($certificate.Subject)
  $encodedVersion = [Net.WebUtility]::HtmlEncode($Version)
  $testDisclosure = if ($certificate.Subject -eq $certificate.Issuer) {
    '<p class="notice">この配布物は自己署名証明書による試験版です。発行元の信頼は会社で確認してください。SmartScreen や社内ポリシーで許可されることを保証するものではありません。</p>'
  } else {
    '<p class="notice">ClickOnce を使う試験配布です。発行元と配布先を確認してください。SmartScreen や社内ポリシーで許可されることを保証するものではありません。</p>'
  }
  $html = @"
<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HAKOBI ClickOnce 試験版</title>
<style>body{font-family:system-ui,sans-serif;line-height:1.8;background:#f4f7fa;color:#243047;max-width:740px;margin:60px auto;padding:24px}main{background:white;border-radius:16px;padding:32px}a.install{display:inline-block;background:#2463d6;color:white;text-decoration:none;padding:12px 24px;border-radius:8px}.notice{background:#fff5db;padding:16px;border-radius:8px}small{overflow-wrap:anywhere}</style></head>
<body><main><h1>HAKOBI ClickOnce 試験版</h1><p>Windows 用・バージョン $encodedVersion</p><p><a class="install" href="HAKOBI.application">インストール・更新する</a></p>
<p>Microsoft Edge で開いて、ClickOnce の案内に従ってインストールしてください。通常の exe 版と区別するため、スタートメニューには「HAKOBI（ClickOnce 試験版）」と表示されます。</p>
<p>更新するときは、先に通知領域の HAKOBI アイコンから「終了」を選び、起動中の HAKOBI を完全に終了してください。その後、このリンクまたはスタートメニューから起動すると更新を確認します。</p>
<p>通常の exe 版が入っている場合は、両方を同時に起動せず、試験版の動作を確認してください。タスクの保存先とチーム接続の設定は既存版と共通です。</p>
$testDisclosure<p><small>署名証明書: $publisherText</small></p></main></body></html>
"@
  [IO.File]::WriteAllText((Join-Path $stagePath 'index.html'), $html, $utf8)
  $metadata = @{ version = $Version; applicationUrl = '/clickonce/HAKOBI.application'; publishedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $stagePath 'clickonce-release.json'), $metadata, $utf8)
  & (Join-Path $PSScriptRoot 'publish-clickonce.ps1') -Source $stagePath -InstallUrl $InstallUrl -Version $Version -ValidateOnly
  # Both targets are resolved absolute children of our dedicated release directory.
  $releaseFull = [IO.Path]::GetFullPath($releasePath).TrimEnd('\') + '\'
  foreach ($candidate in @($stagePath, $outputPath)) {
    if (-not [IO.Path]::GetFullPath($candidate).StartsWith($releaseFull, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release path escaped its output directory.' }
  }
  if (Test-Path -LiteralPath $outputPath) { throw 'Another build already created this version.' }
  [IO.Directory]::Move($stagePath, $outputPath)
  $rawFull = [IO.Path]::GetFullPath($rawPublishPath)
  if ($rawFull.StartsWith([IO.Path]::GetFullPath($rawRoot).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Parent $rawFull) -ieq [IO.Path]::GetFullPath($rawRoot) -and
      (Split-Path -Leaf $rawFull) -match '^[a-f0-9]{32}$') {
    Remove-Item -LiteralPath $rawFull -Recurse -Force
  }
  Write-Host "Signed ClickOnce files are ready at $outputPath"
  Write-Host 'No server files were changed. Review the output, then run publish-clickonce.ps1 explicitly to publish.'
} finally {
  Pop-Location
}
