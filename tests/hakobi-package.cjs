const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const asar = require('@electron/asar')
const yaml = require('js-yaml')
const { UUID } = require('builder-util-runtime')

// Distribution to members must contain the client, never the server's data/config.
const archive = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../dist/win-unpacked/resources/app.asar')
const expected = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'))
const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
assert.equal(packaged.name, expected.name)
assert.equal(packaged.version, expected.version, 'The distribution must match the current release version')
const buildConfigPath = path.resolve(__dirname, '../electron-builder.yml')
const buildConfig = yaml.load(fs.readFileSync(buildConfigPath, 'utf8'))
assert.equal(buildConfig.appId, 'com.hakobi.app', 'HAKOBI must have its own Windows shortcut/taskbar identity')
assert.equal(buildConfig.nsis.guid, UUID.v5('com.todo.app', UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')),
  'The installer must still upgrade the original ToDo installation')
assert.equal(buildConfig.nsis.include, 'build/hakobi-installer.nsh', 'Kept same-name shortcuts must be migrated to the new Shell identity')
const files = asar.listPackage(archive).map((name) => name.split(path.sep).join('/').replace(/^\//, ''))
for (const file of files) {
  assert.ok(file === 'package.json' || file === 'out' || file.startsWith('out/') || file === 'node_modules' || file.startsWith('node_modules/'), `Unexpected distribution file: ${file}`)
}
for (const required of [
  'out/main/index.js', 'out/preload/index.js', 'out/preload/desktop.js',
  'out/preload/launcher.js', 'out/renderer/index.html',
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
]) assert.ok(files.includes(required), `Missing distribution file: ${required}`)

// Version alone cannot detect an older build made with the same version number.
const output = path.resolve(__dirname, '../out')
function compareDirectory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) compareDirectory(file)
    else {
      const relative = path.relative(output, file)
      assert.deepEqual(asar.extractFile(archive, path.join('out', relative)), fs.readFileSync(file), `Stale packaged build: ${relative}`)
    }
  }
}
compareDirectory(output)

// Load the packaged SQLite module using Electron's ABI, without opening the app.
const smoke = `const Database = require(${JSON.stringify(path.join(archive, 'node_modules', 'better-sqlite3'))});
const db = new Database(':memory:');
try { db.exec('CREATE TABLE ReleaseSmoke(value INTEGER); INSERT INTO ReleaseSmoke VALUES (1)');
if (db.prepare('SELECT value FROM ReleaseSmoke').get().value !== 1) throw new Error('SQLite release smoke failed');
console.log('Packaged SQLite runtime passed'); } finally { db.close(); }`
const result = spawnSync(require('electron'), ['-e', smoke], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 15000 })
assert.equal(result.error, undefined, result.error?.message)
assert.equal(result.status, 0, result.stdout + result.stderr)
assert.match(result.stdout, /Packaged SQLite runtime passed/)
console.log('HAKOBI package matches the latest client build; new Shell identity, original installer upgrade identity and SQLite runtime pass; server data/config/source are excluded')
