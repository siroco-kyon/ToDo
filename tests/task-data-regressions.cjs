const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const ownedParent = path.join(root, 'node_modules')
const dir = fs.mkdtempSync(path.join(ownedParent, '.task-data-test-'))
function run(executable, args, extraEnv) {
  const result = spawnSync(executable, args, { cwd: root, env: { ...process.env, ...extraEnv }, encoding: 'utf8', timeout: 60000 })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Task data test failed (${result.status})`)
}
try {
  const source = fs.readFileSync(path.join(root, 'src/main/db.ts'), 'utf8')
  const configImport = "import { getDataDir } from './config'"
  if (!source.includes(configImport)) throw new Error('Missing config import')
  buildSync({ stdin: { contents: source.replace(configImport, `const getDataDir = () => ${JSON.stringify(path.join(dir, 'local'))}`), resolveDir: path.join(root, 'src/main'), loader: 'ts', sourcefile: 'db.ts' }, outfile: path.join(dir, 'db.cjs'), platform: 'node', format: 'cjs', bundle: true, packages: 'external' })
  fs.writeFileSync(path.join(dir, 'local.cjs'), `
    const api=require('./db.cjs'); api.initDb();
    try { require(${JSON.stringify(path.join(__dirname, 'task-data-scenarios.cjs'))})({...api,getTodoById:(id)=>api.getAllTodos().find(t=>t.id===id)}); console.log('Local task data regressions passed'); }
    finally {api.getDb().close()}
  `)
  run(require('electron'), [path.join(dir, 'local.cjs')], { ELECTRON_RUN_AS_NODE: '1' })
  const importPath = (relative) => JSON.stringify(pathToFileURL(path.join(root, relative)).href)
  const envFile = path.join(dir, 'server.env'); fs.writeFileSync(envFile, '')
  fs.writeFileSync(path.join(dir, 'server.mts'), `
    import {createRequire} from 'node:module';
    const require=createRequire(import.meta.url);
    const conn=await import(${importPath('server/src/db/connection.ts')});
    const todos=await import(${importPath('server/src/db/todos.ts')});
    const subtasks=await import(${importPath('server/src/db/subtasks.ts')});
    const timer=await import(${importPath('server/src/db/timer.ts')});
    const logs=await import(${importPath('server/src/db/worklogs.ts')});
    conn.initDb();
    try {
      const now=new Date().toISOString();
      conn.getDb().prepare('INSERT INTO Users(id,username,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('test-user','test','Test','unused',now,now);
      require(${JSON.stringify(path.join(__dirname, 'task-data-scenarios.cjs'))})({...conn,...todos,...subtasks,...logs,startTimer:(id)=>timer.startTimer('test-user',id),stopTimer:()=>timer.stopTimer('test-user')});
      console.log('Server task data regressions passed');
    } finally {conn.getDb().close()}
  `)
  run(process.execPath, ['--import', pathToFileURL(path.join(root, 'server/node_modules/tsx/dist/loader.mjs')).href, path.join(dir, 'server.mts')], { TODO_ENV_FILE: envFile, TODO_DATA_DIR: path.join(dir, 'server') })
} finally {
  if (path.dirname(path.resolve(dir)) !== ownedParent || !path.basename(dir).startsWith('.task-data-test-')) throw new Error('Unsafe cleanup')
  fs.rmSync(dir, { recursive: true, force: true })
}
