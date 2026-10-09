// Test current-executable taskbar metadata without changing user shortcuts or pins.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawn } = require('node:child_process')
const { build } = require('esbuild')
const { load } = require('js-yaml')
const { UUID } = require('builder-util-runtime')

const root = path.resolve(__dirname, '..')
const ownedParent = path.join(root, 'node_modules')
let temporary
let child

async function main() {
  const result = await build({
    entryPoints: [path.join(root, 'src/main/windows-branding.ts')],
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false
  })
  const code = result.outputFiles[0].text
  const executable = 'C:\\Program Files\\HAKOBI, チーム\\HAKOBI.exe'
  const appPath = 'D:\\開発フォルダ With Spaces\\ToDo'
  const developmentIcon = path.win32.join(appPath, 'build', 'icon.ico')
  const legacyShortcut = { appId: 'com.todo.app', executable: 'C:\\Users\\member\\AppData\\Local\\Programs\\todo-app\\ToDo.exe' }
  const shellId = 'com.hakobi.app'

  function metadata({ platform = 'win32', packaged = true, applicationPath = appPath, hasIcon = false } = {}) {
    const calls = []
    const iconProbes = []
    let appPathReads = 0
    const module = { exports: {} }
    vm.runInNewContext(code, {
      module, exports: module.exports,
      process: { platform, execPath: executable },
      require: (name) => name === 'electron'
        ? { app: { isPackaged: packaged, getAppPath: () => { appPathReads++; return applicationPath } } }
        : name === 'fs'
          ? { existsSync: (file) => { iconProbes.push(file); return hasIcon } }
          : name === 'path' ? path.win32 : require(name)
    })
    module.exports.applyWindowsTaskbarBranding({ setAppDetails: (details) => calls.push(JSON.parse(JSON.stringify(details))) })
    return { calls, iconProbes, appPathReads }
  }

  const packaged = metadata()
  assert.equal(packaged.calls.length, 1)
  assert.deepEqual(packaged.calls[0], {
    appId: shellId, appIconPath: executable, appIconIndex: 0,
    relaunchCommand: '"' + executable + '"', relaunchDisplayName: 'HAKOBI'
  })
  assert.notEqual(packaged.calls[0].appId, legacyShortcut.appId, 'old ToDo taskbar grouping must not be reused')
  assert.notEqual(packaged.calls[0].appIconPath, legacyShortcut.executable, 'an old shortcut with the same app ID must not supply the icon')
  assert.notEqual(packaged.calls[0].relaunchCommand, '"' + legacyShortcut.executable + '"', 'relaunch must use the current executable')
  assert.equal(packaged.appPathReads, 0)
  assert.deepEqual(packaged.iconProbes, [], 'packaged mode must use the embedded icon without probing development files')

  const development = metadata({ packaged: false, hasIcon: true })
  assert.deepEqual(development.iconProbes, [developmentIcon])
  assert.equal(development.calls[0].appIconPath, developmentIcon, 'pass the raw path; Electron adds the resource index')
  assert.equal(development.calls[0].appIconIndex, 0)
  assert.equal(development.calls[0].relaunchCommand, '"' + executable + '" "' + appPath + '"', 'development relaunch needs the application directory as a separate argument')
  assert.equal(metadata({ packaged: false }).calls[0].appIconPath, executable, 'missing development ICO must fall back to the current executable')
  assert.equal(metadata({ packaged: false, applicationPath: 'D:\\' }).calls[0].relaunchCommand,
    '"' + executable + '" "D:\\\\"', 'closing quotes must not be escaped by a trailing backslash')

  for (const platform of ['darwin', 'linux']) {
    const nonWindows = metadata({ platform, packaged: false })
    assert.equal(nonWindows.calls.length, 0)
    assert.equal(nonWindows.appPathReads, 0)
    assert.deepEqual(nonWindows.iconProbes, [])
  }
  const buildConfig = load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'))
  const legacyGuid = UUID.v5(legacyShortcut.appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'))
  assert.equal(buildConfig.appId, shellId, 'installer shortcuts must use the same new ID as the running window')
  assert.equal(buildConfig.nsis.guid, legacyGuid, 'new shell ID must retain the old NSIS upgrade identity')
  assert.equal(buildConfig.nsis.deleteAppDataOnUninstall, false)
  console.log('Windows branding metadata passed: distinct shell ID, matching shortcut ID, legacy NSIS upgrade GUID, current exe, dev ICO/fallback, quoting and other platforms')

  if (process.platform !== 'win32') return
  temporary = fs.mkdtempSync(path.join(ownedParent, '.windows-branding-test-'))
  fs.writeFileSync(path.join(temporary, 'branding.cjs'), code)
  const runner = path.join(temporary, 'run.cjs')
  fs.writeFileSync(runner, `
    const assert = require('node:assert/strict')
    const fs = require('node:fs')
    const path = require('node:path')
    const Module = require('node:module')
    const { spawn } = require('node:child_process')
    const electron = require('electron')
    const { app, BrowserWindow } = electron
    const temporary = ${JSON.stringify(temporary)}
    const root = ${JSON.stringify(root)}
    app.setPath('userData', path.join(temporary, 'user-data'))
    app.commandLine.appendSwitch('disable-gpu')
    app.on('window-all-closed', () => {})
    let window
    async function run() {
      await app.whenReady()
      // Never show this window or ask Windows to pin/create a shortcut.
      window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } })
      const applied = []
      const setAppDetails = window.setAppDetails.bind(window)
      window.setAppDetails = (options) => { setAppDetails(options); applied.push(options) }
      for (const packaged of [true, false]) {
        const branding = new Module(path.join(temporary, 'branding.cjs'), module)
        const actualRequire = branding.require.bind(branding)
        branding.require = (name) => name === 'electron'
          ? { ...electron, app: { isPackaged: packaged, getAppPath: () => root } }
          : actualRequire(name)
        branding._compile(fs.readFileSync(path.join(temporary, 'branding.cjs'), 'utf8'), path.join(temporary, 'branding.cjs'))
        branding.exports.applyWindowsTaskbarBranding(window)
        const details = applied.at(-1)
        assert.equal(details.appId, 'com.hakobi.app')
        assert.equal(details.appIconPath, packaged ? process.execPath : path.join(root, 'build', 'icon.ico'))
        assert.equal(details.appIconIndex, 0)
        assert.equal(details.relaunchDisplayName, 'HAKOBI')
        assert.equal(details.relaunchCommand, '"' + process.execPath + '"' + (packaged ? '' : ' "' + root + '"'))
        // Read the actual HWND property store in another process, beyond API acceptance.
        const nativeHandle = window.getNativeWindowHandle()
        const handle = Number(nativeHandle.length === 8 ? nativeHandle.readBigUInt64LE() : nativeHandle.readUInt32LE())
        const inspectionArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', path.join(root, 'tests', 'windows-shell-inspect.ps1'), '-ExecutablePath', process.execPath,
          '-OutputDirectory', temporary, '-ProcessId', String(process.pid)]
        // Keep Electron's UI loop responsive while the other process reads WM_GETICON.
        const inspection = await new Promise((resolve, reject) => {
          const probe = spawn('powershell.exe', inspectionArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
          let stdout = '', stderr = ''
          probe.stdout.on('data', chunk => { stdout += chunk })
          probe.stderr.on('data', chunk => { stderr += chunk })
          const deadline = setTimeout(() => probe.kill(), 15000)
          probe.once('error', error => { clearTimeout(deadline); reject(error) })
          probe.once('exit', status => { clearTimeout(deadline); resolve({ status, stdout, stderr }) })
        })
        assert.equal(inspection.status, 0, inspection.stdout + inspection.stderr)
        const nativeDetails = [].concat(JSON.parse(inspection.stdout)).find(value => value.Handle === handle)
        assert.ok(nativeDetails, 'own hidden HWND not found')
        assert.equal(nativeDetails.AppId, details.appId)
        assert.equal(nativeDetails.RelaunchIconResource, details.appIconPath + ',0')
        assert.equal(nativeDetails.RelaunchCommand, details.relaunchCommand)
        assert.equal(nativeDetails.RelaunchDisplayName, 'HAKOBI')
      }
      assert.equal(applied.length, 2)
      console.log('Windows branding real hidden BrowserWindow passed: packaged/development actual HWND AppId, icon resource, command and name verified')
      window.destroy(); app.exit(0)
    }
    run().catch(error => { console.error(error.stack || error); if (window && !window.isDestroyed()) window.destroy(); app.exit(1) })
  `)
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  child = spawn(require('electron'), [runner], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const timeout = setTimeout(() => child.kill(), 30000)
  const execution = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timeout)
  process.stdout.write(output)
  assert.equal(execution.code, 0, 'Branding Electron fixture failed: ' + (execution.code ?? execution.signal))
  assert.ok(output.includes('Windows branding real hidden BrowserWindow passed'), 'Electron exited before finishing branding checks')
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1 }).finally(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill()
  if (!temporary) return
  assert.equal(path.dirname(path.resolve(temporary)), ownedParent)
  assert.ok(path.basename(temporary).startsWith('.windows-branding-test-'))
  fs.rmSync(temporary, { recursive: true, force: true })
})
