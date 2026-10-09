const fs = require('fs')
const path = require('path')

const DEFAULT_SERVICE_NAME = 'TodoTeamServer'
const PASS_THROUGH_ENV = [
  'PORT', 'TODO_DATA_DIR', 'TODO_WEB_DIST', 'ADMIN_USERNAME', 'ADMIN_PASSWORD',
  'SESSION_COOKIE', 'SESSION_TTL_DAYS'
]

function readEnvFile(envPath, required) {
  if (!fs.existsSync(envPath)) {
    if (required) throw new Error(`設定ファイルが見つかりません: ${envPath}`)
    return {}
  }
  const values = {}
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const name = trimmed.slice(0, separator).trim()
    let value = trimmed.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[name] = value
  }
  return values
}

function getServiceConfiguration(environment = process.env, { requireGroupSettings = true } = {}) {
  const serverDir = path.resolve(__dirname, '..')
  const envPath = environment.TODO_ENV_FILE
    ? path.resolve(environment.TODO_ENV_FILE)
    : path.join(serverDir, '.env')
  const settings = { ...readEnvFile(envPath, Boolean(environment.TODO_ENV_FILE)), ...environment }
  const name = settings.TODO_SERVICE_NAME || DEFAULT_SERVICE_NAME
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
    throw new Error('TODO_SERVICE_NAME は英字で始まる英数字・アンダースコアで64文字以内にしてください')
  }
  const customInstance = name.toLowerCase() !== DEFAULT_SERVICE_NAME.toLowerCase()
  if (requireGroupSettings && customInstance && (!settings.PORT || !settings.TODO_DATA_DIR)) {
    throw new Error('独自名のサービスには PORT と TODO_DATA_DIR を設定してください（グループごとのDBとポートを分けます）')
  }
  const port = settings.PORT || '4577'
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('PORT は1〜65535の整数にしてください')
  }
  const directory = customInstance
    ? path.join(__dirname, 'instances', name.toLowerCase())
    : __dirname
  const env = PASS_THROUGH_ENV
    .filter((key) => environment[key] !== undefined)
    .map((key) => ({ name: key, value: environment[key] }))
  if (environment.TODO_ENV_FILE) env.push({ name: 'TODO_ENV_FILE', value: envPath })
  return {
    name,
    port,
    directory,
    logpath: customInstance ? path.join(directory, 'logs') : undefined,
    description: settings.TODO_SERVICE_DESCRIPTION || `HAKOBI チームサーバー（ポート ${port}）`,
    script: path.join(__dirname, 'run.cjs'),
    workingDirectory: serverDir,
    env,
    envPath
  }
}

module.exports = { getServiceConfiguration }
