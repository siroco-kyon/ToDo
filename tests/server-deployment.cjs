const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// The documented server deployment contains server/ and dist-web/ only.
// Import its actual modules from an isolated layout without the desktop src/.
const repo = path.resolve(__dirname, '..')
const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobi-server-deployment-'))
const deployedServer = path.join(owned, 'server')
const dependencies = path.join(deployedServer, 'node_modules')
const realDependencies = path.join(repo, 'server', 'node_modules')
let linked = false
try {
  fs.mkdirSync(deployedServer)
  fs.cpSync(path.join(repo, 'server', 'src'), path.join(deployedServer, 'src'), { recursive: true })
  fs.copyFileSync(path.join(repo, 'server', 'package.json'), path.join(deployedServer, 'package.json'))
  fs.symlinkSync(realDependencies, dependencies, process.platform === 'win32' ? 'junction' : 'dir')
  linked = true
  const envFile = path.join(owned, 'empty.env')
  fs.writeFileSync(envFile, '')
  const probe = path.join(deployedServer, 'probe.ts')
  fs.writeFileSync(probe, `
import assert from 'node:assert/strict'
import { createTodo } from './src/db/todos'
import { createSubTask } from './src/db/subtasks'
import { importDesktopDb } from './src/import/import-desktop-db'
assert.equal(typeof createTodo, 'function')
assert.equal(typeof createSubTask, 'function')
assert.equal(typeof importDesktopDb, 'function')
console.log('[PASS] standalone server imports')
`)
  const child = spawnSync(process.execPath, [path.join(realDependencies, 'tsx', 'dist', 'cli.mjs'), probe], {
    cwd: deployedServer,
    env: {
      ...process.env,
      TODO_ENV_FILE: envFile,
      TODO_DATA_DIR: path.join(owned, 'unused-data'),
      TODO_WEB_DIST: path.join(owned, 'dist-web'),
      SESSION_COOKIE: 'isolated_deployment_test'
    },
    encoding: 'utf8',
    timeout: 15000
  })
  assert.equal(child.error, undefined, child.error?.message)
  assert.equal(child.status, 0, child.stdout + child.stderr)
  assert.match(child.stdout, /\[PASS\] standalone server imports/)
  assert.equal(fs.existsSync(path.join(owned, 'unused-data')), false, 'the import probe never initializes a database')
  assert.equal(fs.existsSync(path.join(owned, 'src')), false, 'no desktop sources were deployed')
  console.log('[PASS] documented server/ + dist-web/ deployment imports without desktop sources')
} finally {
  if (linked) {
    assert.equal(fs.lstatSync(dependencies).isSymbolicLink(), true)
    assert.equal(fs.realpathSync(dependencies).toLowerCase(), fs.realpathSync(realDependencies).toLowerCase())
    fs.unlinkSync(dependencies)
  }
  assert.equal(path.dirname(owned), path.resolve(os.tmpdir()))
  assert.ok(path.basename(owned).startsWith('hakobi-server-deployment-'))
  fs.rmSync(owned, { recursive: true, force: true })
}
