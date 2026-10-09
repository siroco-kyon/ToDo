// Actual desktop SQLite ABI, isolated bootstrap/userData and copied files only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { build } = require('esbuild')

const root = path.resolve(__dirname, '..')
const modules = path.join(root, 'node_modules')
const temporary = fs.mkdtempSync(path.join(modules, '.local-data-regressions-'))

async function main() {
  await build({
    stdin: { contents: "export * from './db'; export * from './archive'; export * from './config'; export * from './data-migration'; export { registerIpcHandlers } from './ipc'", resolveDir: path.join(root, 'src/main'), loader: 'ts' },
    outfile: path.join(temporary, 'local.cjs'), platform: 'node', format: 'cjs', bundle: true, packages: 'external',
    plugins: [{ name: 'isolated-electron-api', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'module.exports = globalThis.__localData.electron', loader: 'js' }))
    } }]
  })
  const runner = path.join(temporary, 'run.cjs')
  fs.writeFileSync(runner, `
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')
const temporary = ${JSON.stringify(temporary)}
const profile = path.join(temporary, 'profile')
const bootstrap = path.join(profile, 'config.json')
fs.mkdirSync(profile)
const handlers = new Map()
const dialogs = []
globalThis.__localData = { electron: {
  app: { isPackaged: false, getPath: (name) => name === 'userData' ? profile : path.join(temporary, 'app-data') },
  ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: async (_window, options) => { dialogs.push(options); return { response: 0 } } }
} }
let api = require('./local.cjs')
function reload() {
  if (api.getDb()?.open) api.getDb().close()
  delete require.cache[require.resolve('./local.cjs')]
  api = require('./local.cjs')
}
let serial = 0
function reset() {
  const data = path.join(temporary, 'source-' + (++serial))
  api.setDataDir(data)
  api.initDb()
  api.setSetting('archiveRetentionDays', '90')
  api.setSetting('workLogRetentionDays', '0')
  return data
}
function archived(title, withChild = false) {
  const todo = api.createTodo({ title })
  if (withChild) {
    api.createSubTask(todo.id, { title: 'Child' })
    api.createProgressNote(todo.id, 'Progress history')
    api.addDailyPlanItem('2000-01-03', todo.id)
  }
  api.startTimer(todo.id)
  api.stopTimer('Original work history')
  api.archiveTodo(todo.id)
  api.getDb().prepare("UPDATE Todos SET archived_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(todo.id)
  return todo
}
function count(table) { return api.getDb().prepare('SELECT COUNT(*) AS n FROM ' + table).get().n }
function emptyMigrationDestination(directory) {
  assert.deepEqual(fs.existsSync(directory) ? fs.readdirSync(directory) : [], [], 'failure left staged DB, icons or SQLite sidecars')
}
try {
  reset()
  const disabled = archived('Retain indefinitely', true)
  api.setSetting('archiveRetentionDays', '0')
  api.runArchiveCleanup()
  assert.ok(api.getAllTodos().some((todo) => todo.id === disabled.id))
  assert.equal(api.getWorkLogsByTodo(disabled.id).length, 1)
  assert.equal(count('SubTasks'), 1)
  console.log('PASS R1: retention 0 preserves archived tasks and related history')

  api.setSetting('archiveRetentionDays', '90')
  api.runArchiveCleanup()
  for (const table of ['Todos', 'SubTasks', 'WorkLogs', 'DailyPlanItems', 'ProgressNotes', 'TodoChangeLogs']) assert.equal(count(table), 0, table)
  console.log('PASS R2: expired task with subtasks, logs, plan and progress is deleted without FK failure')

  reset()
  const first = archived('First cleanup candidate', true)
  const blocked = archived('Second cleanup candidate', true)
  api.getDb().exec("CREATE TRIGGER reject_cleanup BEFORE DELETE ON Todos WHEN OLD.id = '" + blocked.id + "' BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END")
  assert.throws(() => api.runArchiveCleanup(), /injected cleanup failure/)
  assert.equal(count('Todos'), 2)
  assert.equal(count('SubTasks'), 2)
  assert.equal(api.getWorkLogsByTodo(first.id).length, 1)
  assert.equal(api.getWorkLogsByTodo(blocked.id).length, 1)
  const originalError = console.error
  let warning
  try { console.error = () => {}; warning = api.runArchiveCleanupSafely() } finally { console.error = originalError }
  assert.match(warning, /データは変更せず/)
  assert.equal(api.getAllTodos().length, 2)
  assert.equal(count('WorkLogs'), 2)
  api.getDb().exec('DROP TRIGGER reject_cleanup')
  console.log('PASS R2: an injected deletion failure rolls back the whole cleanup and safe startup wrapper remains usable')

  const source = reset()
  api.registerIpcHandlers({}, () => {}, () => {}, () => {}, () => {})
  api.createTodo({ title: 'Baseline before checkpoint' })
  api.getDb().pragma('wal_checkpoint(TRUNCATE)')
  const walTask = api.createTodo({ title: 'New task still in WAL' })
  const running = api.startTimer(walTask.id)
  api.createProgressNote(walTask.id, 'Recent WAL progress')
  const icons = path.join(source, 'icons')
  fs.mkdirSync(icons)
  const originalIcon = path.join(icons, 'custom.png')
  fs.writeFileSync(originalIcon, Buffer.from([1, 2, 3, 4]))
  api.setSetting('customIconPath', originalIcon)
  assert.ok(fs.statSync(path.join(source, 'todo.db-wal')).size > 0)
  const oldConnection = api.getDb()
  const destination = path.join(temporary, 'destination')
  assert.deepEqual(handlers.get('data:changeDir')({}, destination), { moved: true })
  assert.equal(oldConnection.open, false)
  assert.equal(path.resolve(api.getDb().name), path.join(destination, 'todo.db'))
  assert.equal(api.getAllTodos().length, 2)
  assert.equal(api.getProgressNotesByTodo(walTask.id).length, 1)
  assert.equal(api.getRunningState().start_time, running.start_time)
  assert.equal(api.getSetting('customIconPath'), path.join(destination, 'icons', 'custom.png'))
  assert.deepEqual(fs.readFileSync(api.getSetting('customIconPath')), Buffer.from([1, 2, 3, 4]))
  assert.equal(api.getDataDir(), destination)
  api.createTodo({ title: 'New task immediately after Apply' })
  const oldSnapshot = new Database(path.join(source, 'todo.db'), { readonly: true })
  assert.equal(oldSnapshot.prepare('SELECT COUNT(*) AS n FROM Todos').get().n, 2)
  assert.equal(oldSnapshot.prepare("SELECT value FROM Settings WHERE key = 'customIconPath'").get().value, originalIcon)
  oldSnapshot.close()
  assert.equal(api.getAllTodos().length, 3)
  assert.equal(api.stopTimer('Stopped after live migration').todo_id, walTask.id)
  assert.equal(fs.readdirSync(destination).some((name) => name.startsWith('.hakobi-migration-')), false)
  console.log('PASS R3: WAL task/progress/timer/icon copied consistently; writes after Apply use the live new DB and old snapshot stays intact')

  const live = api.getDb()
  assert.deepEqual(api.changeLocalDataDirectory(path.join(destination, '.')), { moved: false })
  const alias = path.join(temporary, 'destination-alias')
  fs.symlinkSync(destination, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual(api.changeLocalDataDirectory(alias), { moved: false })
  assert.equal(api.getDb(), live)
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const occupied = path.join(temporary, 'occupied-' + (suffix || 'db'))
    fs.mkdirSync(occupied)
    const file = path.join(occupied, 'todo.db' + suffix)
    fs.writeFileSync(file, 'Untouched pre-existing data')
    assert.throws(() => api.changeLocalDataDirectory(occupied), /上書きせず/)
    assert.equal(fs.readFileSync(file, 'utf8'), 'Untouched pre-existing data')
    assert.equal(api.getDb(), live)
  }
  const existingIcons = path.join(temporary, 'existing-icons')
  fs.mkdirSync(path.join(existingIcons, 'icons'), { recursive: true })
  fs.writeFileSync(path.join(existingIcons, 'icons', 'keep.png'), 'Keep')
  assert.throws(() => api.changeLocalDataDirectory(existingIcons), /上書きせず/)
  assert.equal(fs.readFileSync(path.join(existingIcons, 'icons', 'keep.png'), 'utf8'), 'Keep')
  console.log('PASS R3: same real directory/junction is unchanged; existing target DB/sidecars/icons are never overwritten')

  const originalBootstrap = fs.readFileSync(bootstrap, 'utf8')
  const configFailureDestination = path.join(temporary, 'config-failure')
  const originalRename = fs.renameSync
  try {
    fs.renameSync = (from, to) => { if (to === bootstrap) throw new Error('injected config commit failure'); return originalRename(from, to) }
    assert.throws(() => api.changeLocalDataDirectory(configFailureDestination), /injected config commit failure/)
  } finally { fs.renameSync = originalRename }
  assert.equal(api.getDb(), live)
  assert.equal(live.open, true)
  assert.equal(fs.readFileSync(bootstrap, 'utf8'), originalBootstrap)
  assert.deepEqual(fs.readdirSync(profile), ['config.json'])
  emptyMigrationDestination(configFailureDestination)
  api.createTodo({ title: 'Write after config rollback' })

  const validationFailureDestination = path.join(temporary, 'candidate-failure')
  live.exec("CREATE TRIGGER reject_candidate BEFORE INSERT ON Settings BEGIN SELECT RAISE(ABORT, 'injected candidate validation failure'); END")
  assert.throws(() => api.changeLocalDataDirectory(validationFailureDestination), /injected candidate validation failure/)
  live.exec('DROP TRIGGER reject_candidate')
  assert.equal(api.getDb(), live)
  assert.equal(live.open, true)
  assert.equal(fs.readFileSync(bootstrap, 'utf8'), originalBootstrap)
  emptyMigrationDestination(validationFailureDestination)

  const copyFailureDestination = path.join(temporary, 'partial-copy-failure')
  const originalRead = fs.readSync
  try {
    fs.readSync = () => { throw new Error('injected partial snapshot copy failure') }
    assert.throws(() => api.changeLocalDataDirectory(copyFailureDestination), /injected partial snapshot copy failure/)
  } finally { fs.readSync = originalRead }
  assert.equal(api.getDb(), live)
  emptyMigrationDestination(copyFailureDestination)

  const transactionFailureDestination = path.join(temporary, 'transaction-failure')
  assert.throws(() => live.transaction(() => api.changeLocalDataDirectory(transactionFailureDestination))(), /transaction/)
  emptyMigrationDestination(transactionFailureDestination)
  assert.equal(api.getDb(), live)
  assert.equal(fs.readFileSync(bootstrap, 'utf8'), originalBootstrap)
  console.log('PASS R3: config/candidate/partial copy/snapshot failures restore original config+live connection and remove owned artifacts')

  const cleanupFailureDestination = path.join(temporary, 'cleanup-failure-after-commit')
  const originalRm = fs.rmSync
  const previousError = console.error
  const cleanupErrors = []
  try {
    fs.rmSync = (target, options) => { if (path.basename(target).startsWith('.hakobi-migration-')) throw new Error('injected staging cleanup failure'); return originalRm(target, options) }
    console.error = (...args) => cleanupErrors.push(args)
    assert.deepEqual(api.changeLocalDataDirectory(cleanupFailureDestination), { moved: true })
  } finally { fs.rmSync = originalRm; console.error = previousError }
  assert.equal(api.getDataDir(), cleanupFailureDestination)
  assert.equal(path.dirname(api.getDb().name), cleanupFailureDestination)
  assert.equal(cleanupErrors.length, 1)
  const retainedStaging = fs.readdirSync(cleanupFailureDestination).filter((name) => name.startsWith('.hakobi-migration-'))
  assert.equal(retainedStaging.length, 1)
  for (const name of retainedStaging) {
    const owned = path.join(cleanupFailureDestination, name)
    assert.equal(path.dirname(path.resolve(owned)), cleanupFailureDestination)
    fs.rmSync(owned, { recursive: true, force: true })
  }
  console.log('PASS R3: cleanup failure after a committed live switch is logged without falsely reporting migration failure')

  const legacy = path.join(temporary, 'app-data', 'ToDo', 'data')
  fs.mkdirSync(legacy, { recursive: true })
  fs.copyFileSync(path.join(source, 'todo.db'), path.join(legacy, 'todo.db'))
  for (const todo of api.getAllTodos()) api.deleteTodo(todo.id)
  assert.equal(api.getAllTodos().length, 0)
  globalThis.__localData.electron.app.isPackaged = true
  assert.equal(api.getDataDir(), cleanupFailureDestination)
  reload()
  api.initDb()
  assert.equal(api.getAllTodos().length, 0, 'a deliberately empty migrated DB must not resurrect a legacy backup on restart')
  assert.equal(JSON.parse(fs.readFileSync(bootstrap, 'utf8')).skipLegacyRecovery, true)
  const retainedOld = new Database(path.join(legacy, 'todo.db'), { readonly: true })
  assert.equal(retainedOld.prepare('SELECT COUNT(*) AS n FROM Todos').get().n, 2)
  retainedOld.close()
  globalThis.__localData.electron.app.isPackaged = false
  console.log('PASS R3: deleting all migrated tasks stays empty across settings reads and restart; old backup is not restored automatically')

  // A crashed empty target retains a WAL from its last deletion. Copying a
  // closed source main file over that target without retiring WAL loses data.
  const legacySource = reset()
  api.createTodo({ title: 'Closed main-only legacy task' })
  assert.equal(path.dirname(path.resolve(legacy)), path.join(temporary, 'app-data', 'ToDo'))
  fs.rmSync(legacy, { recursive: true, force: true })
  const legacyIcons = path.join(legacy, 'icons')
  fs.mkdirSync(legacyIcons, { recursive: true })
  const legacyIcon = path.join(legacyIcons, 'custom.png')
  fs.writeFileSync(legacyIcon, 'Source icon')
  api.setSetting('customIconPath', legacyIcon)
  api.getDb().close()
  fs.copyFileSync(path.join(legacySource, 'todo.db'), path.join(legacy, 'todo.db'))
  const sourceBytes = fs.readFileSync(path.join(legacy, 'todo.db'))
  assert.equal(fs.existsSync(path.join(legacy, 'todo.db-wal')), false)
  const crash = path.join(temporary, 'leave-target-wal.cjs')
  fs.writeFileSync(crash, "const Database=require('better-sqlite3');const db=new Database(process.argv[2]);db.pragma('journal_mode=WAL');db.pragma('wal_autocheckpoint=0');db.prepare('DELETE FROM Todos').run();process.exit(0)")
  function crashedEmptyTarget(name) {
    const directory = path.join(temporary, name)
    fs.mkdirSync(directory)
    fs.mkdirSync(path.join(directory, 'icons'))
    fs.writeFileSync(path.join(directory, 'icons', 'custom.png'), 'Old target icon')
    fs.writeFileSync(path.join(directory, 'icons', 'other.png'), 'Keep other target icon')
    fs.copyFileSync(path.join(legacy, 'todo.db'), path.join(directory, 'todo.db'))
    const crashed = require('node:child_process').spawnSync(process.execPath, [crash, path.join(directory, 'todo.db')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 10000
    })
    assert.equal(crashed.status, 0, crashed.stderr)
    assert.ok(fs.statSync(path.join(directory, 'todo.db-wal')).size > 0)
    return directory
  }
  function selectUnmarked(directory) {
    fs.writeFileSync(bootstrap, JSON.stringify({ dataDir: directory }))
    globalThis.__localData.electron.app.isPackaged = true
    reload()
  }
  const recoverTarget = crashedEmptyTarget('legacy-recovery-stale-wal')
  selectUnmarked(recoverTarget)
  assert.equal(api.getDataDir(), recoverTarget)
  assert.equal(fs.existsSync(path.join(recoverTarget, 'todo.db-wal')), false)
  assert.equal(fs.existsSync(path.join(recoverTarget, 'todo.db-shm')), false)
  const recovered = new Database(path.join(recoverTarget, 'todo.db'), { readonly: true })
  assert.equal(recovered.prepare('SELECT COUNT(*) AS n FROM Todos').get().n, 1)
  recovered.close()
  assert.deepEqual(fs.readFileSync(path.join(legacy, 'todo.db')), sourceBytes)
  assert.equal(fs.readdirSync(recoverTarget).some((name) => name.startsWith('.hakobi-legacy-')), false)
  api.initDb()
  assert.equal(api.getSetting('customIconPath'), path.join(recoverTarget, 'icons', 'custom.png'))
  assert.equal(fs.readFileSync(api.getSetting('customIconPath'), 'utf8'), 'Source icon')
  assert.equal(fs.readFileSync(path.join(recoverTarget, 'icons', 'other.png'), 'utf8'), 'Keep other target icon')
  for (const todo of api.getAllTodos()) api.deleteTodo(todo.id)
  const recoveredLive = api.getDb()
  for (let i = 0; i < 5; i += 1) assert.equal(api.getDataDir(), recoverTarget)
  assert.equal(api.getDb(), recoveredLive)
  assert.equal(api.getAllTodos().length, 0)
  reload()
  api.initDb()
  assert.equal(api.getAllTodos().length, 0)
  console.log('PASS legacy recovery: main-only source replaces stale target WAL consistently; original source preserved and empty live/restarted DB stays empty')

  for (const phase of ['publish', 'config']) {
    const failedTarget = crashedEmptyTarget('legacy-failure-' + phase)
    selectUnmarked(failedTarget)
    const mainBefore = fs.readFileSync(path.join(failedTarget, 'todo.db'))
    const walBefore = fs.readFileSync(path.join(failedTarget, 'todo.db-wal'))
    const bootstrapBefore = fs.readFileSync(bootstrap)
    const original = fs.renameSync
    try {
      fs.renameSync = (from, to) => {
        if ((phase === 'config' && to === bootstrap) || (phase === 'publish' && to === path.join(failedTarget, 'todo.db') && path.basename(path.dirname(from)).startsWith('.hakobi-legacy-') && path.basename(from) === 'todo.db')) throw new Error('injected legacy ' + phase + ' failure')
        return original(from, to)
      }
      assert.equal(api.getDataDir(), failedTarget)
    } finally { fs.renameSync = original }
    assert.deepEqual(fs.readFileSync(path.join(failedTarget, 'todo.db')), mainBefore)
    assert.deepEqual(fs.readFileSync(path.join(failedTarget, 'todo.db-wal')), walBefore)
    assert.deepEqual(fs.readFileSync(bootstrap), bootstrapBefore)
    assert.equal(fs.readFileSync(path.join(failedTarget, 'icons', 'custom.png'), 'utf8'), 'Old target icon')
    assert.equal(fs.readFileSync(path.join(failedTarget, 'icons', 'other.png'), 'utf8'), 'Keep other target icon')
    const preserved = new Database(path.join(failedTarget, 'todo.db'), { readonly: true })
    assert.equal(preserved.prepare('SELECT COUNT(*) AS n FROM Todos').get().n, 0)
    preserved.close()
    assert.equal(fs.readdirSync(failedTarget).some((name) => name.startsWith('.hakobi-legacy-')), false)
    assert.deepEqual(fs.readFileSync(path.join(legacy, 'todo.db')), sourceBytes)
    assert.equal(fs.readFileSync(legacyIcon, 'utf8'), 'Source icon')
  }
  console.log('PASS legacy recovery: snapshot publication/config failure restores original target DB+WAL and bootstrap without touching source')

  const unmarkedPopulated = path.join(temporary, 'legacy-selected-existing')
  fs.mkdirSync(unmarkedPopulated)
  fs.copyFileSync(path.join(legacy, 'todo.db'), path.join(unmarkedPopulated, 'todo.db'))
  selectUnmarked(unmarkedPopulated)
  api.initDb()
  assert.equal(JSON.parse(fs.readFileSync(bootstrap, 'utf8')).skipLegacyRecovery, true)
  for (const todo of api.getAllTodos()) api.deleteTodo(todo.id)
  const selectedLive = api.getDb()
  assert.equal(api.getDataDir(), unmarkedPopulated)
  assert.equal(api.getDb(), selectedLive)
  assert.equal(api.getAllTodos().length, 0)
  reload()
  api.initDb()
  assert.equal(api.getAllTodos().length, 0)
  globalThis.__localData.electron.app.isPackaged = false
  console.log('PASS legacy selection: existing DB resolution is cached before opening and persisted, so deleting its last task does not restore older data')
  console.log('Local data regression checks passed')
} finally { if (api.getDb()?.open) api.getDb().close() }
`)
  const result = spawnSync(require('electron'), [runner], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 60000 })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error) throw result.error
  assert.equal(result.status, 0)
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(modules))
  assert.ok(path.basename(temporary).startsWith('.local-data-regressions-'))
  fs.rmSync(temporary, { recursive: true, force: true })
})
