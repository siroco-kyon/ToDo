// Compile the real customInstall macro against cached NSIS/WinShell. All links,
// output and executions stay within an owned node_modules fixture directory.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const ownedParent = path.join(root, 'node_modules')
const macro = path.join(root, 'build', 'hakobi-installer.nsh')
let temporary

function findFile(directory, filename, accepts = () => true) {
  if (!fs.existsSync(directory)) return undefined
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase() && accepts(candidate)) return candidate
    if (entry.isDirectory()) {
      const found = findFile(candidate, filename, accepts)
      if (found) return found
    }
  }
}

function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: temporary, windowsHide: true, encoding: 'utf8', timeout: 20000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.stdout
}

// NSIS directives quote dollars and quotes independently of shell escaping.
const nsisPath = (value) => value.replaceAll('$', '$$').replaceAll('"', '$\\"')

function main() {
  const source = fs.readFileSync(macro, 'utf8')
  assert.ok(source.includes('WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"'))
  assert.ok(source.includes('WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"'))
  if (process.platform !== 'win32') {
    console.log('HAKOBI installer macro source checked; real NSIS shortcut test requires Windows')
    return
  }
  const cache = path.join(process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache'), 'nsis')
  const compiler = findFile(cache, 'makensis.exe')
  const plugin = findFile(cache, 'WinShell.dll', (file) => path.basename(path.dirname(file)) === 'x86-unicode')
  assert.ok(compiler && plugin, 'Build an installer first to populate the cached NSIS compiler and WinShell plugin')
  temporary = fs.mkdtempSync(path.join(ownedParent, '.hakobi-installer-test-'))
  const executable = path.join(temporary, 'shortcut-fixture.exe')
  const script = path.join(temporary, 'fixture.nsi')
  fs.writeFileSync(script, `
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "HAKOBI owned shortcut fixture"
OutFile "${nsisPath(executable)}"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!addplugindir /x86-unicode "${nsisPath(path.dirname(plugin))}"
!define APP_ID "com.hakobi.app"
!include "${nsisPath(macro)}"
Var newStartMenuLink
Var newDesktopLink
Section
  StrCpy $newStartMenuLink "$EXEDIR\\Start Menu\\HAKOBI.lnk"
  StrCpy $newDesktopLink "$EXEDIR\\Desktop\\HAKOBI.lnk"
  \${GetParameters} $0
  ClearErrors
  \${GetOptions} $0 "/seed" $1
  \${IfNot} \${Errors}
    CreateDirectory "$EXEDIR\\Start Menu"
    CreateDirectory "$EXEDIR\\Desktop"
    CreateShortCut "$newStartMenuLink" "${nsisPath(process.execPath)}" "--owned-start-menu" "${nsisPath(path.join(root, 'build', 'icon.ico'))}" 0
    CreateShortCut "$newDesktopLink" "${nsisPath(process.execPath)}" "--owned-desktop" "${nsisPath(path.join(root, 'build', 'icon.ico'))}" 0
    WinShell::SetLnkAUMI "$newStartMenuLink" "com.todo.app"
    WinShell::SetLnkAUMI "$newDesktopLink" "com.todo.app"
  \${Else}
    !insertmacro customInstall
  \${EndIf}
SectionEnd
`)
  const inspector = path.join(temporary, 'inspect.ps1')
  fs.writeFileSync(inspector, `
param([string]$FixtureDirectory)
$ErrorActionPreference = 'Stop'
$shellApp = New-Object -ComObject Shell.Application
$shortcutShell = New-Object -ComObject WScript.Shell
$values = foreach ($folderName in @('Start Menu', 'Desktop')) {
  $folderPath = Join-Path $FixtureDirectory $folderName
  $shortcutPath = Join-Path $folderPath 'HAKOBI.lnk'
  $folder = $shellApp.NameSpace($folderPath)
  $item = $folder.ParseName('HAKOBI.lnk')
  $link = $shortcutShell.CreateShortcut($shortcutPath)
  [pscustomobject]@{
    Folder = $folderName
    AppId = $item.ExtendedProperty('System.AppUserModel.ID')
    TargetPath = $link.TargetPath
    Arguments = $link.Arguments
    IconLocation = $link.IconLocation
    WorkingDirectory = $link.WorkingDirectory
  }
}
$values | ConvertTo-Json -Compress
`)
  const inspect = () => JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', inspector, '-FixtureDirectory', temporary]))
  run(compiler, ['/V2', script])
  run(executable, ['/seed'])
  const before = inspect()
  assert.equal(before.length, 2)
  for (const link of before) assert.equal(link.AppId, 'com.todo.app')
  run(executable, [])
  const after = inspect()
  for (const [index, link] of after.entries()) {
    assert.equal(link.AppId, 'com.hakobi.app', 'same-name existing shortcut must receive the new shell ID')
    assert.deepEqual({ ...link, AppId: 'com.todo.app' }, before[index], 'refresh must preserve target, arguments, icon and working directory')
  }
  const shortcutPaths = ['Start Menu', 'Desktop'].map(folder => path.join(temporary, folder, 'HAKOBI.lnk'))
  fs.unlinkSync(shortcutPaths[0])
  run(executable, [])
  assert.equal(fs.existsSync(shortcutPaths[0]), false, 'a deleted Start Menu link must not be recreated')
  assert.equal(fs.existsSync(shortcutPaths[1]), true)
  fs.unlinkSync(shortcutPaths[1])
  run(executable, [])
  assert.ok(shortcutPaths.every(file => !fs.existsSync(file)), 'deleted shortcuts must remain absent')
  console.log('HAKOBI installer real NSIS macro passed: same-name shortcut IDs refreshed, target/icon/arguments preserved, deleted links remain absent')
}

try { main() } catch (error) { console.error(error.stack || error); process.exitCode = 1 } finally {
  if (temporary) {
    assert.equal(path.dirname(path.resolve(temporary)), ownedParent)
    assert.ok(path.basename(temporary).startsWith('.hakobi-installer-test-'))
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}
