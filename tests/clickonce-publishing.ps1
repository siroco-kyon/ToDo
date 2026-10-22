#requires -Version 5.1
<#
.SYNOPSIS
Exercises real signed build validation and local publication, without installing or contacting a server.
.EXAMPLE
powershell -NoProfile -File tests/clickonce-publishing.ps1 -Source release/clickonce/1.0.5.0 -InstallUrl http://localhost:4577/clickonce/
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$InstallUrl
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$publisher = Join-Path $repoPath 'scripts\publish-clickonce.ps1'
$sourcePath = [IO.Path]::GetFullPath($Source)
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$testPath = Join-Path $temporaryRoot ('hakobi-clickonce-test-' + [Guid]::NewGuid().ToString('N'))
$fixturePath = Join-Path $testPath 'build'
$destinationPath = Join-Path $testPath 'published'
$script:assertionCount = 0
function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
  $script:assertionCount++
}
function Assert-Rejected([scriptblock]$Action, [string]$Expected) {
  $failure = $null
  try { & $Action } catch { $failure = $_.Exception.Message }
  Assert-True ([bool]$failure -and $failure -like "*$Expected*") "Expected rejection containing '$Expected'; got '$failure'."
}
try {
  New-Item -ItemType Directory -Path $testPath | Out-Null
  Copy-Item -LiteralPath $sourcePath -Destination $fixturePath -Recurse
  $originalManifestHash = (Get-FileHash -LiteralPath (Join-Path $fixturePath 'HAKOBI.application') -Algorithm SHA256).Hash
  & $publisher -Source $fixturePath -InstallUrl $InstallUrl -ValidateOnly
  Assert-True (-not (Test-Path -LiteralPath $destinationPath)) 'Validation must not publish files.'
  Assert-Rejected { & $publisher -Source $fixturePath -InstallUrl 'http://different.invalid/clickonce/' -ValidateOnly } 'provider does not match'

  $payload = Get-ChildItem -LiteralPath (Join-Path $fixturePath 'Application Files') -Recurse -File -Filter '*.deploy' |
    Where-Object { $_.Length -gt 0 } | Sort-Object Length | Select-Object -First 1
  $fileStream = [IO.File]::Open($payload.FullName, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    $originalByte = $fileStream.ReadByte()
    $fileStream.Position = 0
    $fileStream.WriteByte([byte]($originalByte -bxor 1))
  } finally { $fileStream.Dispose() }
  Assert-Rejected { & $publisher -Source $fixturePath -InstallUrl $InstallUrl -ValidateOnly } 'hash differs'
  $fileStream = [IO.File]::OpenWrite($payload.FullName)
  try { $fileStream.WriteByte([byte]$originalByte) } finally { $fileStream.Dispose() }

  $extraPath = Join-Path $fixturePath 'private-key.pfx'
  [IO.File]::WriteAllText($extraPath, 'not a real private key')
  Assert-Rejected { & $publisher -Source $fixturePath -InstallUrl $InstallUrl -ValidateOnly } 'Unexpected file'
  Remove-Item -LiteralPath $extraPath

  $oldVersionPath = Join-Path $destinationPath 'Application Files\preserved-old-version'
  New-Item -ItemType Directory -Path $oldVersionPath -Force | Out-Null
  $oldVersionFile = Join-Path $oldVersionPath 'old.deploy'
  [IO.File]::WriteAllText($oldVersionFile, 'preserve')
  # Exercise replacement of an existing release, including the atomic File.Replace branch.
  foreach ($rootFile in @('HAKOBI.application', 'index.html', 'clickonce-release.json')) {
    [IO.File]::WriteAllText((Join-Path $destinationPath $rootFile), 'previous release')
  }
  & $publisher -Source $fixturePath -InstallUrl $InstallUrl -Destination $destinationPath
  Assert-True ((Get-FileHash -LiteralPath (Join-Path $destinationPath 'HAKOBI.application') -Algorithm SHA256).Hash -ceq $originalManifestHash) 'Published deployment manifest changed.'
  Assert-True ((Get-Content -LiteralPath $oldVersionFile -Raw) -ceq 'preserve') 'Publication must retain old versions.'
  Assert-Rejected { & $publisher -Source $fixturePath -InstallUrl $InstallUrl -Destination $destinationPath } 'Version already published'
  Assert-True ((Get-FileHash -LiteralPath (Join-Path $fixturePath 'HAKOBI.application') -Algorithm SHA256).Hash -ceq $originalManifestHash) 'Publication must not mutate the source.'
  Write-Host "ClickOnce publication: $script:assertionCount assertions passed."
} finally {
  # Remove only the unique directory created above, after checking its resolved absolute parent.
  $resolvedTestPath = [IO.Path]::GetFullPath($testPath)
  if ($resolvedTestPath.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Parent $resolvedTestPath).TrimEnd('\') -ieq $temporaryRoot.TrimEnd('\') -and
      (Split-Path -Leaf $resolvedTestPath) -match '^hakobi-clickonce-test-[a-f0-9]{32}$' -and
      (Test-Path -LiteralPath $resolvedTestPath)) {
    Remove-Item -LiteralPath $resolvedTestPath -Recurse -Force
  }
}
