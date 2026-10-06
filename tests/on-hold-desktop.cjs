const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(root, 'node_modules', '.on-hold-test-'))
try {
  const dbPath = path.join(dir, 'db.cjs')
  const source = fs.readFileSync(path.join(root, 'src/main/db.ts'), 'utf8')
  const configImport = "import { getDataDir } from './config'"
  if (!source.includes(configImport)) throw new Error('テスト用の保存先を設定できません')
  buildSync({
    stdin: {
      contents: source.replace(
        configImport,
        `const getDataDir = () => ${JSON.stringify(path.join(dir, 'data'))}`
      ),
      resolveDir: path.join(root, 'src/main'), loader: 'ts', sourcefile: 'db.ts'
    }, outfile: dbPath,
    platform: 'node', format: 'cjs', bundle: true, packages: 'external',
  })
  const runner = path.join(dir, 'run.cjs')
  fs.writeFileSync(runner, `
    const db = require('./db.cjs')
    db.initDb()
    try {
      require(${JSON.stringify(path.join(__dirname, 'on-hold-scenarios.cjs'))})({
        ...db,
        getTodoById: (id) => db.getAllTodos().find((todo) => todo.id === id),
        createSubTask: db.createSubTask,
        addPlan: (id, date) => db.addDailyPlanItem(date, id),
        getPlan: db.getDailyPlanItems,
        reopen: () => { db.getDb().close(); db.initDb() }
      })
      console.log('Desktop on-hold checks passed')
    } finally { db.getDb().close() }
  `)
  // Electron用のbetter-sqlite3を、実際のElectron ABIで検証する。
  const result = spawnSync(require('electron'), [runner], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8'
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  // このテスト自身が作った一時ディレクトリだけを削除する。
  fs.rmSync(dir, { recursive: true, force: true })
}
