import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

/**
 * チームサーバーが配布する HAKOBI デスクトップ版（Windows インストーラー）の確認。
 * electron-builder が出力する latest.yml と、そこに書かれたインストーラー1つだけを配布する。
 * 配布するファイル名はリクエストからは決めず、このパターンに合う latest.yml の記載だけを使う。
 */
export const DESKTOP_INSTALLER_PATTERN = /^HAKOBI-(\d{1,4}\.\d{1,4}\.\d{1,6})-setup\.exe$/

export interface DesktopRelease {
  version: string
  fileName: string
  size: number
  /** 配布ページに表示して、ダウンロードしたファイルを確かめてもらうためのハッシュ（16進） */
  sha256: string
  /** latest.yml に書かれたハッシュ（base64）。インストーラーの中身と一致を確認済み */
  sha512: string
  releaseDate: string | null
}

/** reason は管理者向けの日本語の説明（フォルダのパスを含むので、管理者以外には返さない） */
export type DesktopReleaseResult = { ok: true; release: DesktopRelease } | { ok: false; reason: string }

export interface LatestYmlFile {
  url: string | null
  sha512: string | null
  size: number | null
}

export interface LatestYml {
  version: string | null
  path: string | null
  sha512: string | null
  releaseDate: string | null
  files: LatestYmlFile[]
}

export interface DesktopReleaseReader {
  read(): Promise<DesktopReleaseResult>
}

const LATEST_YML = 'latest.yml'
/** electron-builder の latest.yml は数百バイト。これより大きいものは読まない */
const MAX_LATEST_YML_BYTES = 64 * 1024
const HASH_CHUNK_BYTES = 1024 * 1024

/** 配布できない理由が分かったときのエラー（I/O の失敗とは分けて扱う） */
class ReleaseProblem extends Error {}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code) return code
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  return value
}

function keyValue(text: string): [string, string] | null {
  const match = /^([A-Za-z0-9_]+):(?:\s+(.*))?$/.exec(text)
  return match ? [match[1], unquote(match[2] ?? '')] : null
}

function parseSize(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const size = Number(value)
  return Number.isSafeInteger(size) ? size : null
}

/**
 * electron-builder が書く latest.yml を読む最小限のパーサー（YAML ライブラリは使わない）。
 * 1行1つの `key: value` と、`files:` の下の `- url: ...` の並びだけを扱う。
 * 値の引用符は外し、知らないキー（sha2、isAdminRightsRequired など）は無視する。
 */
export function parseLatestYml(text: string): LatestYml {
  const result: LatestYml = { version: null, path: null, sha512: null, releaseDate: null, files: [] }
  let inFiles = false
  let entry: LatestYmlFile | null = null
  let entryIndent = -1

  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const body = line.trim()
    if (!body || body.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const startsItem = body === '-' || body.startsWith('- ')

    // `files:` の直下は字下げなしの `- url: ...` でもよい（YAML ではどちらも同じ意味）
    if (indent === 0 && !(inFiles && startsItem)) {
      entry = null
      const pair = keyValue(body)
      inFiles = pair !== null && pair[0] === 'files' && pair[1] === ''
      if (!pair) continue
      const [key, value] = pair
      if (key === 'version') result.version = value || null
      else if (key === 'path') result.path = value || null
      else if (key === 'sha512') result.sha512 = value || null
      else if (key === 'releaseDate') result.releaseDate = value || null
      continue
    }
    if (!inFiles) continue

    let rest = body
    if (startsItem) {
      entry = { url: null, sha512: null, size: null }
      result.files.push(entry)
      rest = body.slice(1).trimStart()
      entryIndent = indent + (body.length - rest.length)
      if (!rest) continue
    } else if (indent !== entryIndent) {
      // 項目より深い入れ子や、形の崩れた行は読まない
      continue
    }
    if (!entry) continue
    const pair = keyValue(rest)
    if (!pair) continue
    const [key, value] = pair
    if (key === 'url') entry.url = value || null
    else if (key === 'sha512') entry.sha512 = value || null
    else if (key === 'size') entry.size = parseSize(value)
  }
  return result
}

async function readLatestYml(ymlPath: string): Promise<string> {
  const stat = await fs.promises.lstat(ymlPath)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ReleaseProblem(`${ymlPath} は通常のファイルではありません（シンボリックリンクやフォルダは使えません）`)
  }
  if (stat.size > MAX_LATEST_YML_BYTES) {
    throw new ReleaseProblem(`${ymlPath} が大きすぎます。electron-builder が出力した latest.yml を置いてください`)
  }
  return fs.promises.readFile(ymlPath, 'utf8')
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(dir)).isDirectory()
  } catch (error) {
    return !isMissing(error)
  }
}

/** インストーラーを1回読み、sha512（base64）と sha256（16進）を同時に求める */
async function hashInstaller(filePath: string, expected: fs.Stats): Promise<{ sha256: string; sha512: string }> {
  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW ?? 0
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== expected.ino || opened.size !== expected.size) {
      throw new Error('確認中にファイルが置き換わりました')
    }
    const sha256 = crypto.createHash('sha256')
    const sha512 = crypto.createHash('sha512')
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
    let total = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      sha256.update(chunk)
      sha512.update(chunk)
      total += bytesRead
    }
    if (total !== expected.size) {
      throw new Error('確認中にファイルの大きさが変わりました')
    }
    return { sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
  } finally {
    await handle.close()
  }
}

interface Inspection {
  result: DesktopReleaseResult
  /** latest.yml に書かれ、パターンに合ったインストーラー名（キャッシュの鍵に使う） */
  fileName: string | null
  installerStat: fs.Stats | null
  /** コピー中などの一時的な読み込みエラー。結果を覚えず、次回また確かめる */
  transient: boolean
}

async function inspectDesktopRelease(dir: string): Promise<Inspection> {
  let fileName: string | null = null
  let installerStat: fs.Stats | null = null
  const unavailable = (reason: string, transient = false): Inspection =>
    ({ result: { ok: false, reason }, fileName, installerStat, transient })

  let text: string
  try {
    text = await readLatestYml(path.join(dir, LATEST_YML))
  } catch (error) {
    if (error instanceof ReleaseProblem) return unavailable(error.message)
    if (isMissing(error)) {
      return unavailable(await directoryExists(dir)
        ? `配布フォルダ ${dir} に latest.yml がありません`
        : `配布フォルダ ${dir} がありません`)
    }
    return unavailable(`配布フォルダ ${dir} の latest.yml を読み込めませんでした（${errorCode(error)}）`, true)
  }

  const yml = parseLatestYml(text)
  if (!yml.version) return unavailable('latest.yml に version がありません')
  if (yml.files.length !== 1) {
    return unavailable(`latest.yml の files にはインストーラーを1つだけ書いてください（${yml.files.length}件あります）`)
  }
  const entry = yml.files[0]
  const url = entry.url ?? ''
  const match = url === path.basename(url) ? DESKTOP_INSTALLER_PATTERN.exec(url) : null
  if (!match) {
    return unavailable(`latest.yml のファイル名「${url}」は配布できる形式（HAKOBI-x.y.z-setup.exe）ではありません`)
  }
  if (match[1] !== yml.version) {
    return unavailable(`latest.yml の version（${yml.version}）とファイル名 ${url} のバージョンが一致しません`)
  }
  if (yml.path !== null && yml.path !== url) {
    return unavailable(`latest.yml の path（${yml.path}）が files のファイル名（${url}）と一致しません`)
  }
  if (!entry.sha512) return unavailable('latest.yml に sha512 がありません')
  if (yml.sha512 !== null && yml.sha512 !== entry.sha512) {
    return unavailable('latest.yml の sha512 が files の sha512 と一致しません')
  }
  if (entry.size === null || entry.size <= 0) return unavailable('latest.yml に size がありません')
  fileName = url

  const installerPath = path.join(dir, url)
  try {
    installerStat = await fs.promises.lstat(installerPath)
  } catch (error) {
    if (isMissing(error)) return unavailable(`latest.yml に書かれたインストーラー ${url} が配布フォルダ ${dir} にありません`)
    return unavailable(`インストーラー ${url} を確認できませんでした（${errorCode(error)}）`, true)
  }
  if (installerStat.isSymbolicLink()) {
    return unavailable(`インストーラー ${url} はシンボリックリンクのため配布しません。ファイルそのものを置いてください`)
  }
  if (!installerStat.isFile()) return unavailable(`${url} はファイルではありません`)
  if (installerStat.size !== entry.size) {
    return unavailable(`インストーラー ${url} の大きさ（${installerStat.size} バイト）が latest.yml の size（${entry.size} バイト）と一致しません。コピーが終わっていない可能性があります`)
  }

  let digests: { sha256: string; sha512: string }
  try {
    digests = await hashInstaller(installerPath, installerStat)
  } catch (error) {
    return unavailable(`インストーラー ${url} を読み込めませんでした（${errorCode(error)}）。コピー中であれば、終わると配布を始めます`, true)
  }
  if (digests.sha512 !== entry.sha512) return unavailable(`latest.yml の sha512 がインストーラー ${url} と一致しません`)

  const releaseDate = yml.releaseDate && Number.isFinite(Date.parse(yml.releaseDate)) ? yml.releaseDate : null
  return {
    result: {
      ok: true,
      release: { version: yml.version, fileName: url, size: installerStat.size, sha256: digests.sha256, sha512: entry.sha512, releaseDate }
    },
    fileName,
    installerStat,
    transient: false
  }
}

/**
 * dir/latest.yml と、そこに書かれたインストーラーを確かめる。
 * 1件だけ・ファイル名の形式・バージョン・大きさ・sha512 がすべて合うときだけ配布できる。
 */
export async function verifyDesktopRelease(dir: string): Promise<DesktopReleaseResult> {
  return (await inspectDesktopRelease(dir)).result
}

/** 変更の検出に使う、ファイルの状態の要約（無いときは 'missing'） */
function stampOf(stat: fs.Stats | null): string {
  if (!stat) return 'missing'
  const kind = stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : 'other'
  return `${kind}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`
}

/** 読めないときは null（キャッシュを使わずに確かめ直す） */
async function stamp(target: string): Promise<string | null> {
  try {
    return stampOf(await fs.promises.lstat(target))
  } catch (error) {
    return isMissing(error) ? 'missing' : null
  }
}

/**
 * 配布フォルダを確かめる読み手。latest.yml とインストーラーの状態（更新日時・大きさなど）が
 * 前回と同じなら結果を使い回し、ファイルが差し替わればサーバーを再起動しなくても読み直す。
 * 同時に来た確認は1回の読み込みを共有する。一時的な読み込みエラーの結果は覚えない。
 */
export function createDesktopReleaseReader(dir: string): DesktopReleaseReader {
  const ymlPath = path.join(dir, LATEST_YML)
  let cached: { ymlStamp: string; fileName: string | null; installerStamp: string; result: DesktopReleaseResult } | null = null
  let pending: Promise<DesktopReleaseResult> | null = null
  let lastLogged: string | null = null

  function report(result: DesktopReleaseResult): void {
    const key = result.ok ? `ok:${result.release.version}:${result.release.sha256}` : `ng:${result.reason}`
    if (key === lastLogged) return
    lastLogged = key
    if (result.ok) {
      console.log(`[desktop] デスクトップ版 ${result.release.version} を配布しています（${result.release.fileName}）`)
    } else {
      console.log(`[desktop] デスクトップ版のインストーラーは配布していません: ${result.reason}`)
    }
  }

  async function load(): Promise<DesktopReleaseResult> {
    let ymlStamp = await stamp(ymlPath)
    if (ymlStamp === 'missing') ymlStamp += (await directoryExists(dir)) ? ':dir' : ':no-dir'
    if (cached && ymlStamp !== null && cached.ymlStamp === ymlStamp) {
      const installerStamp = cached.fileName ? await stamp(path.join(dir, cached.fileName)) : ''
      if (installerStamp !== null && installerStamp === cached.installerStamp) return cached.result
    }

    const inspection = await inspectDesktopRelease(dir)
    cached = !inspection.transient && ymlStamp !== null
      ? {
          ymlStamp,
          fileName: inspection.fileName,
          installerStamp: inspection.fileName ? stampOf(inspection.installerStat) : '',
          result: inspection.result
        }
      : null
    report(inspection.result)
    return inspection.result
  }

  return {
    read() {
      if (!pending) {
        pending = load()
          .catch((error): DesktopReleaseResult => {
            cached = null
            const result: DesktopReleaseResult = { ok: false, reason: `配布フォルダ ${dir} を確認できませんでした（${errorCode(error)}）` }
            report(result)
            return result
          })
          .finally(() => { pending = null })
      }
      return pending
    }
  }
}
