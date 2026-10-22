#requires -Version 5.1
<#
.SYNOPSIS
Validates and copies a signed ClickOnce build to a local distribution directory.
.DESCRIPTION
Versions are immutable. Copies payloads first and atomically replaces HAKOBI.application last.
Does not remove previous versions, modify certificates, or contact a server.
.EXAMPLE
powershell -NoProfile -File scripts/publish-clickonce.ps1 -Source release/clickonce/1.0.5.0 -InstallUrl http://127.0.0.1:4577/clickonce/
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$InstallUrl,
  [string]$Destination,
  [string]$Version,
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = [IO.Path]::GetFullPath($Source)
if (-not $Destination) { $Destination = Join-Path $repoPath 'dist-clickonce' }
$destinationPath = [IO.Path]::GetFullPath($Destination)
$installUri = $null
if (-not [Uri]::TryCreate($InstallUrl, [UriKind]::Absolute, [ref]$installUri) -or
    $installUri.Scheme -notin @('http', 'https') -or $installUri.UserInfo -or $installUri.Query -or $installUri.Fragment) {
  throw 'InstallUrl must be an absolute HTTP(S) directory URL without credentials, query, or fragment.'
}
$InstallUrl = $installUri.AbsoluteUri.TrimEnd('/') + '/'
if ($installUri.Host -ieq 'localhost') {
  $loopbackUri = New-Object UriBuilder($installUri)
  $loopbackUri.Host = '127.0.0.1'
  $InstallUrl = $loopbackUri.Uri.AbsoluteUri.TrimEnd('/') + '/'
  Write-Warning "MSBuild rewrites localhost. The local trial install URL is normalized to $InstallUrl"
}

function Read-Manifest([string]$Path) {
  $document = New-Object Xml.XmlDocument
  $document.PreserveWhitespace = $true
  $document.XmlResolver = $null
  $settings = New-Object Xml.XmlReaderSettings
  $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $reader = [Xml.XmlReader]::Create($Path, $settings)
  try { $document.Load($reader) } finally { $reader.Dispose() }
  if (-not $document.SelectSingleNode("/*[local-name()='assembly']/*[local-name()='Signature' and namespace-uri()='http://www.w3.org/2000/09/xmldsig#']")) {
    throw "Unsigned ClickOnce manifest: $Path"
  }
  return ,$document
}

function Resolve-ContainedFile([string]$BasePath, [string]$RelativePath) {
  $decoded = [Uri]::UnescapeDataString($RelativePath).Replace('/', '\')
  if ([IO.Path]::IsPathRooted($decoded) -or $decoded -match '[:?*]' -or ($decoded.Split('\') -contains '..')) { throw "Unsafe manifest path: $RelativePath" }
  $baseFull = [IO.Path]::GetFullPath($BasePath).TrimEnd('\') + '\'
  $fullPath = [IO.Path]::GetFullPath((Join-Path $BasePath $decoded))
  if (-not $fullPath.StartsWith($baseFull, [StringComparison]::OrdinalIgnoreCase)) { throw "Manifest path escaped the distribution: $RelativePath" }
  return $fullPath
}

function Assert-ManifestFile([Xml.XmlElement]$Element, [string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing ClickOnce file: $Path" }
  $expectedSize = $Element.GetAttribute('size')
  if (-not $expectedSize -or (Get-Item -LiteralPath $Path).Length -ne [long]$expectedSize) { throw "File size differs from the signed manifest: $Path" }
  $hashNode = $Element.SelectSingleNode("*[local-name()='hash']")
  if (-not $hashNode) { throw "Missing signed file hash: $Path" }
  $digestNode = $hashNode.SelectSingleNode("*[local-name()='DigestValue']")
  $methodNode = $hashNode.SelectSingleNode("*[local-name()='DigestMethod']")
  if (-not $digestNode -or -not $methodNode) { throw "Missing signed file hash: $Path" }
  $algorithm = switch ($methodNode.GetAttribute('Algorithm')) {
    'http://www.w3.org/2000/09/xmldsig#sha1' { 'SHA1' }
    'http://www.w3.org/2001/04/xmlenc#sha256' { 'SHA256' }
    'http://www.w3.org/2000/09/xmldsig#sha256' { 'SHA256' }
    default { throw "Unsupported ClickOnce file hash: $Path" }
  }
  $actualHash = (Get-FileHash -LiteralPath $Path -Algorithm $algorithm).Hash
  $digest = [Convert]::FromBase64String($digestNode.InnerText)
  $expectedHash = [BitConverter]::ToString($digest).Replace('-', '')
  if ($actualHash -cne $expectedHash) { throw "File hash differs from the signed manifest: $Path" }
}

function Assert-NoReparsePoint([string]$Path) {
  $entry = Get-Item -LiteralPath $Path -Force
  while ($null -ne $entry) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Symbolic links and junctions are not allowed: $($entry.FullName)" }
    $entry = $entry.Parent
  }
}

if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) { throw "Build directory does not exist: $sourcePath" }
Assert-NoReparsePoint $sourcePath
$sourceEntries = @(Get-ChildItem -LiteralPath $sourcePath -Force -Recurse)
foreach ($entry in $sourceEntries) {
  if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Symbolic links and junctions are not allowed: $($entry.FullName)" }
}
$manifestPath = Join-Path $sourcePath 'HAKOBI.application'
$manifest = Read-Manifest $manifestPath
$identity = $manifest.SelectSingleNode("/*[local-name()='assembly']/*[local-name()='assemblyIdentity']")
$manifestVersion = $identity.GetAttribute('version')
if ($manifestVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'The deployment manifest has an invalid four-part version.' }
foreach ($part in $manifestVersion.Split('.')) {
  if ($part.Length -gt 5 -or [int]$part -gt 65535) { throw 'The deployment version component exceeds 65535.' }
}
if ($Version -and $Version -cne $manifestVersion) { throw 'The requested Version differs from the signed deployment manifest.' }
$Version = $manifestVersion
$provider = $manifest.SelectSingleNode("/*[local-name()='assembly']/*[local-name()='deployment']/*[local-name()='deploymentProvider']")
if (-not $provider -or $provider.GetAttribute('codebase') -cne ($InstallUrl + 'HAKOBI.application')) { throw 'The signed deployment provider does not match InstallUrl + HAKOBI.application. Rebuild for the intended URL.' }
$appReference = $manifest.SelectSingleNode("/*[local-name()='assembly']/*[local-name()='dependency']/*[local-name()='dependentAssembly' and @dependencyType='install']")
if (-not $appReference) { throw 'No application manifest reference was found.' }
$appManifestPath = Resolve-ContainedFile $sourcePath $appReference.GetAttribute('codebase')
$appFolder = Split-Path -Parent $appManifestPath
$appFilesPath = Join-Path $sourcePath 'Application Files'
if ((Split-Path -Parent $appFolder) -ine $appFilesPath -or (Split-Path -Leaf $appFolder) -notmatch '^[A-Za-z0-9_.-]+$') { throw 'The application must occupy one safe version directory under Application Files.' }
Assert-ManifestFile $appReference $appManifestPath
$appManifest = Read-Manifest $appManifestPath
$appIdentity = $appManifest.SelectSingleNode("/*[local-name()='assembly']/*[local-name()='assemblyIdentity']")
if ($appIdentity.GetAttribute('version') -cne $Version) { throw 'Application and deployment manifest versions differ.' }
$allowedFiles = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($path in @($manifestPath, $appManifestPath, (Join-Path $sourcePath 'index.html'), (Join-Path $sourcePath 'clickonce-release.json'))) { [void]$allowedFiles.Add($path) }
$mapFileExtensions = $manifest.SelectSingleNode("/*[local-name()='assembly']/*[local-name()='deployment']").GetAttribute('mapFileExtensions') -eq 'true'
$references = @($appManifest.SelectNodes("/*[local-name()='assembly']/*[local-name()='file'] | /*[local-name()='assembly']/*[local-name()='dependency']/*[local-name()='dependentAssembly' and @dependencyType='install' and @codebase]"))
if ($references.Count -eq 0) { throw 'The application manifest has no payload.' }
foreach ($reference in $references) {
  $relative = if ($reference.LocalName -eq 'file') { $reference.GetAttribute('name') } else { $reference.GetAttribute('codebase') }
  if ($relative -match '(?i)(^|[\\/])\.env($|\.)|\.(pfx|p12|pem|key|snk|sqlite|sqlite3|db)$') { throw "Potential private key or local data in payload: $relative" }
  $relativeFile = if ($mapFileExtensions) { $relative + '.deploy' } else { $relative }
  $filePath = Resolve-ContainedFile $appFolder $relativeFile
  Assert-ManifestFile $reference $filePath
  [void]$allowedFiles.Add($filePath)
}
foreach ($entry in $sourceEntries | Where-Object { -not $_.PSIsContainer }) {
  if (-not $allowedFiles.Contains($entry.FullName)) { throw "Unexpected file in distribution (will not publish): $($entry.FullName)" }
}
foreach ($path in $allowedFiles) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing distribution file: $path" } }
$metadata = Get-Content -LiteralPath (Join-Path $sourcePath 'clickonce-release.json') -Raw | ConvertFrom-Json
if ($metadata.version -cne $Version -or $metadata.applicationUrl -cne '/clickonce/HAKOBI.application') { throw 'Release metadata differs from the signed manifest or built-in server URL.' }
$publishedAt = [DateTimeOffset]::MinValue
if (-not [DateTimeOffset]::TryParse($metadata.publishedAt, [ref]$publishedAt)) { throw 'Release metadata publishedAt is invalid.' }

$mageCommand = Get-Command mage.exe -ErrorAction SilentlyContinue
$magePath = if ($mageCommand) { $mageCommand.Source } else { $null }
if (-not $magePath) {
  $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Microsoft SDKs\Windows'
  if (Test-Path -LiteralPath $sdkRoot) {
    $magePath = Get-ChildItem -LiteralPath $sdkRoot -Filter mage.exe -Recurse -File | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
  }
}
if (-not $magePath) { throw 'mage.exe is required to verify manifest signatures. Install the Windows SDK .NET Framework tools.' }
foreach ($path in @($appManifestPath, $manifestPath)) {
  & $magePath -Verify $path
  if ($LASTEXITCODE -ne 0) { throw "Manifest signature verification failed: $path" }
}
Write-Host "Validated signed ClickOnce $Version ($($allowedFiles.Count) files)."
if ($ValidateOnly) { return }

if ($destinationPath -ieq $repoPath -or $destinationPath -ieq $sourcePath -or
    ($destinationPath.TrimEnd('\') + '\').StartsWith($sourcePath.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    ($sourcePath.TrimEnd('\') + '\').StartsWith($destinationPath.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Destination must be a dedicated distribution directory outside the source build.'
}
$existingAncestor = $destinationPath
while (-not (Test-Path -LiteralPath $existingAncestor)) { $existingAncestor = Split-Path -Parent $existingAncestor }
Assert-NoReparsePoint $existingAncestor
$versionFolder = Split-Path -Leaf $appFolder
$destinationAppFiles = Join-Path $destinationPath 'Application Files'
$destinationVersion = Join-Path $destinationAppFiles $versionFolder
if (Test-Path -LiteralPath $destinationAppFiles) { Assert-NoReparsePoint $destinationAppFiles }
if (Test-Path -LiteralPath $destinationVersion) { throw "Version already published: $destinationVersion. Publish a new version; existing payloads are immutable." }
New-Item -ItemType Directory -Path $destinationAppFiles -Force | Out-Null
$copyStage = Join-Path $destinationAppFiles ('.staging-' + [Guid]::NewGuid().ToString('N'))
Copy-Item -LiteralPath $appFolder -Destination $copyStage -Recurse
# Both move targets are verified children of the explicitly selected distribution directory.
$distributionRoot = [IO.Path]::GetFullPath($destinationPath).TrimEnd('\') + '\'
foreach ($candidate in @($copyStage, $destinationVersion)) {
  if (-not [IO.Path]::GetFullPath($candidate).StartsWith($distributionRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Publish path escaped the distribution directory.' }
}
[IO.Directory]::Move($copyStage, $destinationVersion)
function Copy-RootFileAtomically([string]$Name) {
  $target = Join-Path $destinationPath $Name
  $temporary = Join-Path $destinationPath ('.' + $Name + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
  Copy-Item -LiteralPath (Join-Path $sourcePath $Name) -Destination $temporary
  if (Test-Path -LiteralPath $target) { [IO.File]::Replace($temporary, $target, [NullString]::Value) }
  else { [IO.File]::Move($temporary, $target) }
}
Copy-RootFileAtomically 'index.html'
Copy-RootFileAtomically 'clickonce-release.json'
Copy-RootFileAtomically 'HAKOBI.application'
Write-Host "Published ClickOnce $Version to $destinationPath (deployment manifest replaced last)."
