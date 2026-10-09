const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { getServiceConfiguration } = require('../server/service/config.cjs')
const { Service } = require('../server/node_modules/node-windows')

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobi-service-test-'))
try {
  const emptyFile = path.join(tempDir, 'empty.env')
  fs.writeFileSync(emptyFile, '')
  const legacy = getServiceConfiguration({ TODO_ENV_FILE: emptyFile })
  assert.equal(legacy.name, 'TodoTeamServer')
  const legacyService = new Service(legacy)
  legacyService.directory(legacy.directory)
  assert.equal(legacyService.root, path.resolve(__dirname, '../server/service/daemon'))

  const groupFile = path.join(tempDir, 'group-a.env')
  fs.writeFileSync(groupFile, [
    'TODO_SERVICE_NAME=HakobiGroupA',
    'TODO_SERVICE_DESCRIPTION="HAKOBI Aグループ"',
    'PORT=4577',
    `TODO_DATA_DIR=${path.join(tempDir, 'group-a-data')}`,
    'SESSION_COOKIE=hakobi_group_a'
  ].join('\n'))
  const groupA = getServiceConfiguration({ TODO_ENV_FILE: groupFile })
  const groupB = getServiceConfiguration({
    TODO_ENV_FILE: groupFile,
    TODO_SERVICE_NAME: 'HakobiGroupB',
    PORT: '4578',
    TODO_DATA_DIR: path.join(tempDir, 'group-b-data'),
    SESSION_COOKIE: 'hakobi_group_b'
  })
  assert.equal(groupA.description, 'HAKOBI Aグループ')
  assert.equal(groupA.port, '4577')
  assert.equal(groupB.port, '4578')
  assert.notEqual(groupA.directory, groupB.directory)
  assert.notEqual(groupA.logpath, groupB.logpath)
  assert.equal(groupA.env.find((entry) => entry.name === 'TODO_ENV_FILE').value, groupFile)
  assert.equal(groupB.env.find((entry) => entry.name === 'SESSION_COOKIE').value, 'hakobi_group_b')
  for (const config of [groupA, groupB]) {
    const service = new Service(config)
    service.directory(config.directory)
    assert.equal(service.root, path.join(config.directory, 'daemon'))
    assert.equal(path.dirname(config.logpath), config.directory)
  }

  assert.throws(() => getServiceConfiguration({ TODO_ENV_FILE: emptyFile, TODO_SERVICE_NAME: 'HakobiGroupA' }), /PORT と TODO_DATA_DIR/)
  assert.throws(() => getServiceConfiguration({ TODO_ENV_FILE: emptyFile, TODO_SERVICE_NAME: '../GroupA' }), /TODO_SERVICE_NAME/)
  assert.throws(() => getServiceConfiguration({ TODO_ENV_FILE: emptyFile, PORT: '99999' }), /PORT/)
  assert.throws(() => getServiceConfiguration({ TODO_ENV_FILE: path.join(tempDir, 'missing.env') }), /見つかりません/)
  assert.equal(getServiceConfiguration({ TODO_ENV_FILE: emptyFile, TODO_SERVICE_NAME: 'HakobiGroupA' }, { requireGroupSettings: false }).name, 'HakobiGroupA')

  const tsx = path.resolve(__dirname, '../server/node_modules/tsx/dist/cli.mjs')
  const serverDir = path.resolve(__dirname, '../server')
  const valid = spawnSync(process.execPath, [tsx, '-e', "import { SESSION_COOKIE } from './src/config'; console.log(SESSION_COOKIE)"], {
    cwd: serverDir,
    env: { ...process.env, TODO_ENV_FILE: groupFile, SESSION_COOKIE: 'hakobi_group_a' },
    encoding: 'utf8'
  })
  assert.equal(valid.status, 0, valid.stderr)
  assert.match(valid.stdout, /hakobi_group_a/)
  const invalid = spawnSync(process.execPath, [tsx, '-e', "import './src/config'"], {
    cwd: serverDir,
    env: { ...process.env, TODO_ENV_FILE: emptyFile, SESSION_COOKIE: 'bad;cookie' },
    encoding: 'utf8'
  })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /SESSION_COOKIE/)
  console.log('HAKOBI service configuration tests passed (no services installed)')
} finally {
  // mkdtemp でこのテストが作った、OS一時フォルダ直下のディレクトリだけを削除する。
  assert.equal(path.dirname(path.resolve(tempDir)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(tempDir).startsWith('hakobi-service-test-'))
  fs.rmSync(tempDir, { recursive: true, force: true })
}
