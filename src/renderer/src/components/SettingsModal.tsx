import React, { useState, useEffect, useRef } from 'react'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { toCsv, downloadCsv, dateStamp } from '../lib/csv'
import type { AdminBackupInfo, Todo } from '../types'
import type { DesktopContext, DesktopPreferences } from '../../../shared/desktop'
import { desktopDownloadPageUrl, fetchDesktopRelease, isLoopbackOrigin, isNewerDesktopRelease, type DesktopReleaseStatus } from '../lib/desktopRelease'
import { LegacyDraftRecoveryModal } from './LegacyDraftRecoveryModal'
import { FONT_PRESETS, FONT_SCALE_PRESETS } from '../lib/fontSettings'
import { todoRecurrenceLabel } from '../lib/recurrence'
import { handleTablistKeyDown } from '../lib/tablistKeys'

interface Props {
  onClose: () => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
  themeMode: ThemeMode
  onThemeChange: (mode: ThemeMode) => Promise<void>
  fontFamily: string
  onFontFamilyChange: (value: string) => Promise<void>
  fontScale: string
  onFontScaleChange: (value: string) => Promise<void>
  canManageUsers?: boolean
  serverManaged?: boolean
  onManageUsers?: () => void
  onProgressReport?: () => void
  onDesktopImport?: () => void
  onMySummary?: () => void
  onExportClipboard: () => Promise<void>
  onExportFile: () => Promise<void>
}

const STATUS_LABEL: Record<Todo['status'], string> = {
  not_started: '未着手',
  active: '進行中',
  on_hold: '保留中',
  done: '完了',
  archived: 'アーカイブ'
}


function formatLocal(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

type ThemeMode = 'dark' | 'light' | 'system'

const THEME_LABELS: Record<ThemeMode, string> = { dark: 'ダーク', light: 'ライト', system: 'OS に合わせる' }

interface ShortcutConfig {
  key: string       // Settings DBのキー
  label: string     // 表示名
  value: string     // 現在値 (Electron accelerator形式)
  editing: boolean
}

interface MdTemplates {
  mdHeaderTpl: string
  mdTaskTpl: string
  mdEntryTpl: string
  mdFooterTpl: string
}

function toDisplay(accelerator: string): string {
  return accelerator
    .replace('CommandOrControl', 'Ctrl')
    .replace('Control', 'Ctrl')
}

function captureKeyEvent(e: React.KeyboardEvent): string | null {
  if (e.nativeEvent.isComposing) return null
  const modifiers: string[] = []
  if (e.ctrlKey || e.metaKey) modifiers.push('CommandOrControl')
  if (e.altKey) modifiers.push('Alt')
  if (e.shiftKey) modifiers.push('Shift')

  const ignored = ['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'Tab']
  if (ignored.includes(e.key)) return null

  e.preventDefault()
  let key = e.key
  if (key.length === 1) key = key.toUpperCase()
  // ファンクションキーはそのまま (F1-F12)
  modifiers.push(key)
  return modifiers.join('+')
}

const MEETING_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
// サーバーと同じ最小の長さ（server/src/routes/users.ts）
const MIN_PASSWORD_LENGTH = 6

type SettingsTab = 'personal' | 'team' | 'data'

function settingsTabStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 14px',
    borderRadius: 999,
    border: `1px solid ${active ? 'var(--indigo-500)' : 'var(--slate-700)'}`,
    background: active ? 'var(--indigo-900)' : 'transparent',
    color: active ? 'var(--indigo-100)' : 'var(--slate-400)',
    cursor: 'pointer',
    fontSize: '0.82rem',
    fontWeight: active ? 700 : 500
  }
}

export function SettingsModal({ onClose, onShowToast, themeMode, onThemeChange, fontFamily, onFontFamilyChange, fontScale, onFontScaleChange, canManageUsers = false, serverManaged = false, onManageUsers, onProgressReport, onDesktopImport, onMySummary, onExportClipboard, onExportFile }: Props): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)
  const [exporting, setExporting] = useState(false)
  // 定例の曜日（サーバー版の管理者だけ）。前日の17時に、報告がまだのタスクがある人へ知らせる
  const [meetingWeekday, setMeetingWeekday] = useState<string>('')
  useEffect(() => {
    if (!serverManaged || !canManageUsers) return
    let disposed = false
    void window.api.settingsGet('reportMeetingWeekday').then((value) => { if (!disposed) setMeetingWeekday(value ?? '') }).catch(() => undefined)
    return () => { disposed = true }
  }, [canManageUsers, serverManaged])
  const changeMeetingWeekday = (value: string): void => {
    const previous = meetingWeekday
    setMeetingWeekday(value)
    void window.api.settingsSet('reportMeetingWeekday', value)
      .then(() => onShowToast(value === '' ? '報告のリマインドを止めました' : `定例を${MEETING_WEEKDAYS[Number(value)]}曜日にしました。前日の17時に、報告がまだのタスクがある人へ知らせます`))
      .catch((error) => {
        setMeetingWeekday(previous)
        onShowToast(error instanceof Error ? error.message : '定例の曜日を保存できませんでした', 'error')
      })
  }
  const [showDraftRecovery, setShowDraftRecovery] = useState(false)
  // 設定を「個人／チーム管理（管理者だけ）／データ」に分けて見せる
  const showTeamTab = serverManaged && canManageUsers
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('personal')

  // 自分のパスワードを変える（サーバー版だけ）
  const [passwordForm, setPasswordForm] = useState({ current: '', next: '', confirm: '' })
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [savingPassword, setSavingPassword] = useState(false)
  const updatePasswordForm = (patch: Partial<typeof passwordForm>): void => {
    setPasswordForm((previous) => ({ ...previous, ...patch }))
    setPasswordError(null)
  }
  const changePassword = async (): Promise<void> => {
    if (savingPassword) return
    if (passwordForm.next.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`新しいパスワードは${MIN_PASSWORD_LENGTH}文字以上にしてください`)
      return
    }
    if (passwordForm.next !== passwordForm.confirm) {
      setPasswordError('新しいパスワードと確認用が一致しません')
      return
    }
    setSavingPassword(true)
    try {
      await window.api.authChangePassword(passwordForm.current, passwordForm.next)
      setPasswordForm({ current: '', next: '', confirm: '' })
      onShowToast('パスワードを変えました。次のログインから新しいパスワードを使います')
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : 'パスワードを変えられませんでした')
    } finally {
      setSavingPassword(false)
    }
  }

  // バックアップの状態（チーム管理を開いたときに読む）
  const [backupInfo, setBackupInfo] = useState<AdminBackupInfo | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)
  useEffect(() => {
    if (settingsTab !== 'team' || !showTeamTab) return
    let disposed = false
    setBackupError(null)
    void window.api.adminBackupInfo()
      .then((info) => {
        if (disposed) return
        setBackupInfo(info)
        if (!info) setBackupError('バックアップはサーバー版でのみ使えます')
      })
      .catch((error) => { if (!disposed) setBackupError(error instanceof Error ? error.message : 'バックアップの状態を読み込めませんでした') })
    return () => { disposed = true }
  }, [settingsTab, showTeamTab])
  const [desktopContext, setDesktopContext] = useState<DesktopContext | null>(null)
  const [desktopRelease, setDesktopRelease] = useState<DesktopReleaseStatus | null>(null)
  const saveDesktopPreference = async (patch: Partial<DesktopPreferences>): Promise<void> => {
    try {
      const preferences = await window.desktop?.setPreferences(patch)
      if (preferences) setDesktopContext((value) => value ? { ...value, preferences } : value)
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '設定を保存できませんでした', 'error')
    }
  }

  const exportCsv = async (kind: 'todos' | 'subtasks' | 'worklogs'): Promise<void> => {
    if (exporting) return
    setExporting(true)
    try {
      if (kind === 'todos') {
        const todos = await window.api.todoGetAll()
        downloadCsv(`tasks_${dateStamp()}.csv`, toCsv(
          ['ID', 'タイトル', '説明', 'メモ', 'カテゴリ', '担当者', '状態', '優先度', '進捗(%)', '開始日', '期限', '繰り返し', '作成日時', '更新日時'],
          todos.map((todo) => [
            todo.id, todo.title, todo.description, todo.memo,
            todo.category_name, todo.assignee_name,
            STATUS_LABEL[todo.status] ?? todo.status, todo.priority, todo.progress,
            todo.start_date, todo.due_date,
            todo.recurrence ? todoRecurrenceLabel(todo) ?? todo.recurrence : '',
            formatLocal(todo.created_at), formatLocal(todo.updated_at)
          ])
        ))
      } else if (kind === 'subtasks') {
        const [todos, subTasks] = await Promise.all([window.api.todoGetAll(), window.api.subtaskGetAll()])
        const titleById = new Map(todos.map((todo) => [todo.id, todo.title]))
        downloadCsv(`subtasks_${dateStamp()}.csv`, toCsv(
          ['ID', 'タスク', 'サブタスク', 'メモ', '開始日', '期限', '進捗(%)', '完了', '完了日時', '作成日時'],
          subTasks.map((sub) => [
            sub.id, titleById.get(sub.todo_id) ?? sub.todo_id, sub.title, sub.description,
            sub.start_date, sub.due_date, sub.done ? 100 : sub.progress ?? 0, sub.done ? '済' : '',
            sub.completed_at ? formatLocal(sub.completed_at) : '', formatLocal(sub.created_at)
          ])
        ))
      } else {
        const logs = await window.api.worklogGetAll()
        downloadCsv(`worklogs_${dateStamp()}.csv`, toCsv(
          ['ID', 'タスク', 'カテゴリ', '開始', '終了', '分', 'メモ'],
          logs.map((log) => [
            log.id, log.title, log.category_name,
            formatLocal(log.start_time), formatLocal(log.end_time),
            Math.round(log.duration_seconds / 60), log.note
          ])
        ))
      }
      onShowToast('CSVを書き出しました')
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : 'CSVの書き出しに失敗しました', 'error')
    } finally {
      setExporting(false)
    }
  }

  const [shortcuts, setShortcuts] = useState<ShortcutConfig[]>([
    { key: 'globalShortcutFocus', label: 'アプリを最前面に表示', value: 'CommandOrControl+Alt+T', editing: false },
    { key: 'globalShortcutQuickAdd', label: 'クイック追加モーダル', value: 'CommandOrControl+Alt+N', editing: false },
    { key: 'globalShortcutExport', label: 'Markdownコピー', value: 'CommandOrControl+Alt+E', editing: false },
    ...(window.desktop ? [{ key: 'globalShortcutProgress', label: '進捗のクイック投稿', value: 'CommandOrControl+Alt+P', editing: false }] : [])
  ])
  const [iconDataUrl, setIconDataUrl] = useState('')
  const [dataDir, setDataDir] = useState('')
  const [newDataDir, setNewDataDir] = useState('')
  const [changingDir, setChangingDir] = useState(false)
  const changingDirRef = useRef(false)
  const [archiveRetentionDays, setArchiveRetentionDays] = useState('90')
  const [workLogRetentionDays, setWorkLogRetentionDays] = useState('0')
  const [notifyBeforeDays, setNotifyBeforeDays] = useState('0')
  const [mdTemplates, setMdTemplates] = useState<MdTemplates>({
    mdHeaderTpl: '# 作業ログ - {{date}}',
    mdTaskTpl: '## {{title}}{{category}}\n\n**合計: {{task_min}}分**',
    mdEntryTpl: '- {{start}} ～ {{end}} ({{min}}分){{note}}',
    mdFooterTpl: '**本日合計: {{total_min}}分**'
  })
  const captureRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (window.desktop) {
      void window.desktop.getContext().then(setDesktopContext)
      const unsubscribe = window.desktop.onCommand((command) => {
        if (command.type === 'preferences') setDesktopContext((value) => value ? { ...value, preferences: command.preferences } : value)
      })
      return unsubscribe
    }
    return undefined
  }, [])

  useEffect(() => {
    // Only the team server offers the installer; the personal app has nothing to ask.
    if (!serverManaged && !window.desktop) return undefined
    const controller = new AbortController()
    void fetchDesktopRelease(controller.signal).then((status) => {
      if (!controller.signal.aborted) setDesktopRelease(status)
    })
    return () => controller.abort()
  }, [serverManaged])

  useEffect(() => {
    window.api.iconGetDataUrl().then(setIconDataUrl)
    window.api.dataGetDir().then((d) => { setDataDir(d); setNewDataDir(d) })
    // 設定値を読み込む
    shortcuts.forEach((s, i) => {
      window.api.settingsGet(s.key).then((v) => {
        if (v) setShortcuts((prev) => prev.map((p, pi) => pi === i ? { ...p, value: v } : p))
      })
    })
    window.api.settingsGet('archiveRetentionDays').then((v) => { if (v !== null) setArchiveRetentionDays(v) })
    window.api.settingsGet('workLogRetentionDays').then((v) => { if (v !== null) setWorkLogRetentionDays(v) })
    window.api.settingsGet('notifyBeforeDays').then((v) => { if (v !== null) setNotifyBeforeDays(v) })
    Promise.all([
      window.api.settingsGet('mdHeaderTpl'),
      window.api.settingsGet('mdTaskTpl'),
      window.api.settingsGet('mdEntryTpl'),
      window.api.settingsGet('mdFooterTpl')
    ]).then(([header, task, entry, footer]) => {
      setMdTemplates((prev) => ({
        mdHeaderTpl: header ?? prev.mdHeaderTpl,
        mdTaskTpl: task ?? prev.mdTaskTpl,
        mdEntryTpl: entry ?? prev.mdEntryTpl,
        mdFooterTpl: footer ?? prev.mdFooterTpl
      }))
    })
  }, [])

  // ショートカット編集開始
  const startEdit = (index: number): void => {
    setShortcuts((prev) => prev.map((s, i) => ({ ...s, editing: i === index })))
    setTimeout(() => captureRef.current?.focus(), 50)
  }

  const cancelEdit = (): void => {
    setShortcuts((prev) => prev.map((s) => ({ ...s, editing: false })))
  }

  const handleKeyCapture = async (e: React.KeyboardEvent, index: number): Promise<void> => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') { cancelEdit(); return }
    const accelerator = captureKeyEvent(e)
    if (!accelerator) return

    // 競合チェック
    const conflict = shortcuts.find((s, i) => i !== index && s.value === accelerator)
    if (conflict) {
      onShowToast(`「${conflict.label}」と競合しています`, 'error')
      return
    }

    const updated = shortcuts.map((s, i) =>
      i === index ? { ...s, value: accelerator, editing: false } : s
    )
    try {
      await window.api.settingsSet(shortcuts[index].key, accelerator)
      await window.api.shortcutsReregister()
      setShortcuts(updated)
      onShowToast('ショートカットを更新しました')
    } catch (error) {
      cancelEdit()
      onShowToast(error instanceof Error ? error.message : 'ショートカットを登録できませんでした', 'error')
    }
  }

  // アイコン変更
  const handlePickIcon = async (): Promise<void> => {
    const result = await window.api.iconPick()
    if (result.success && result.dataUrl) {
      setIconDataUrl(result.dataUrl)
      onShowToast('アイコンを変更しました')
    }
  }

  const handleResetIcon = async (): Promise<void> => {
    const url = await window.api.iconReset()
    setIconDataUrl(url)
    onShowToast('デフォルトアイコンに戻しました')
  }

  // データ保存場所変更
  const handlePickDir = async (): Promise<void> => {
    if (changingDirRef.current) return
    const picked = await window.api.dataPickDir()
    if (picked) setNewDataDir(picked)
  }

  const handleChangeDir = async (): Promise<void> => {
    if (changingDirRef.current) return
    if (newDataDir === dataDir) { onShowToast('現在と同じ場所です', 'error'); return }
    changingDirRef.current = true
    setChangingDir(true)
    try {
      const result = await window.api.dataChangeDir(newDataDir)
      if (result.moved) {
        setDataDir(newDataDir)
        onShowToast('保存場所を変更しました。元のフォルダにもデータを残しています')
      }
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '保存場所を変更できませんでした', 'error')
    } finally {
      changingDirRef.current = false
      setChangingDir(false)
    }
  }

  const handleThemeSelect = async (nextMode: ThemeMode): Promise<void> => {
    if (nextMode === themeMode) return
    try {
      await onThemeChange(nextMode)
      onShowToast(nextMode === 'system' ? '表示テーマを OS の設定に合わせます' : `表示テーマを${THEME_LABELS[nextMode]}に変更しました`)
    } catch {
      onShowToast('テーマの変更に失敗しました', 'error')
    }
  }

  const handleFontSelect = async (nextFont: string): Promise<void> => {
    if (nextFont === fontFamily) return
    try {
      await onFontFamilyChange(nextFont)
      onShowToast('フォントを変更しました')
    } catch {
      onShowToast('フォントの変更に失敗しました', 'error')
    }
  }

  const handleFontScaleSelect = async (nextScale: string): Promise<void> => {
    if (nextScale === fontScale) return
    try {
      await onFontScaleChange(nextScale)
      onShowToast('文字サイズを変更しました')
    } catch {
      onShowToast('文字サイズの変更に失敗しました', 'error')
    }
  }

  const editingIndex = shortcuts.findIndex((s) => s.editing)
  const offeredRelease = desktopRelease?.release ?? null
  const newerRelease = desktopContext && isNewerDesktopRelease(offeredRelease, desktopContext) ? offeredRelease : null
  // Members in a browser are offered the app; administrators also see what to share or why nothing is offered.
  const offerDesktopApp = serverManaged && !window.desktop && !!offeredRelease
  const showReleaseAdmin = serverManaged && canManageUsers && desktopRelease !== null
  const settingsTabs: Array<{ key: SettingsTab; label: string }> = [
    { key: 'personal', label: '個人' },
    ...(showTeamTab ? [{ key: 'team' as const, label: 'チーム管理' }] : []),
    { key: 'data', label: 'データ' }
  ]
  const desktopReleaseSection = (offerDesktopApp || showReleaseAdmin) ? (<section>
      <h3 style={sectionHead}>デスクトップ版（Windows）</h3>
      {offerDesktopApp && offeredRelease && <>
        <p style={{ fontSize: '0.8rem', color: 'var(--slate-400)', margin: '8px 0 12px', lineHeight: 1.6 }}>タイマーや通知が使えるデスクトップ版を配布しています（最新 {offeredRelease.version}）。</p>
        <a href={desktopDownloadPageUrl()} target="_blank" rel="noopener noreferrer" style={linkBtn}>ダウンロードページを開く</a>
      </>}
      {showReleaseAdmin && (offeredRelease ? <>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-subtle)', margin: offerDesktopApp ? '14px 0 4px' : '8px 0 4px' }}>メンバーに案内するダウンロードページ（管理者のみ表示）</p>
        <div style={pathBox}>{desktopDownloadPageUrl()}</div>
        {isLoopbackOrigin(window.location.origin) && <p style={{ fontSize: '0.72rem', color: 'var(--amber-400)', marginTop: 6, lineHeight: 1.6 }}>
          このPC（サーバー）から開いているため、ほかのPCではこのURLを使えません。メンバーには {`http://<サーバーのIPアドレス>:${window.location.port || '80'}/download`} を案内してください。
        </p>}
      </> : <div style={{ fontSize: '0.8rem', color: 'var(--slate-400)', marginTop: 8, lineHeight: 1.6 }}>
        <p>配布中のインストーラーはありません。</p>
        {/* 配布フォルダのパスなどは、困ったときだけ開く */}
        <details style={{ marginTop: 4 }}>
          <summary style={detailsSummary}>詳しく</summary>
          {desktopRelease?.reason && <p style={{ fontSize: '0.75rem', color: 'var(--amber-400)', overflowWrap: 'anywhere' }}>{desktopRelease.reason}</p>}
          <p style={{ fontSize: '0.75rem', color: 'var(--text-subtle)' }}><code style={codeStyle}>npm run publish:desktop</code> で公開できます。</p>
        </details>
      </div>)}
    </section>) : null

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (showDraftRecovery) return
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      if (editingIndex >= 0) {
        cancelEdit()
        return
      }
      onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [cancelEdit, editingIndex, onClose, showDraftRecovery])

  return (
    <><div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="設定" style={{
        background: 'var(--slate-800)', borderRadius: 14, padding: 28, width: 560,
        maxHeight: '85vh', overflowY: 'auto',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)', border: '1px solid var(--slate-700)',
        display: 'flex', flexDirection: 'column', gap: 28
      }}>
        {/* ヘッダー */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: '1.1rem', color: 'var(--slate-200)' }}>⚙ 設定</h2>
          <button onClick={onClose} aria-label="設定を閉じる" title="閉じる（Esc）" style={closeBtnStyle}>×</button>
        </div>

        {/* 個人／チーム管理（管理者だけ）／データ */}
        <div role="tablist" aria-label="設定の分類" onKeyDown={(event) => handleTablistKeyDown(event, true)} style={{ display: 'flex', gap: 6, marginTop: -12, borderBottom: '1px solid var(--slate-700)', paddingBottom: 10 }}>
          {settingsTabs.map((item) => (
            <button key={item.key} type="button" role="tab" aria-selected={settingsTab === item.key} tabIndex={settingsTab === item.key ? 0 : -1} onClick={() => setSettingsTab(item.key)} style={settingsTabStyle(settingsTab === item.key)}>
              {item.label}
            </button>
          ))}
        </div>

        {settingsTab === 'personal' && <>
        {desktopContext && <section>
          <h3 style={sectionHead}>HAKOBI デスクトップ</h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--slate-300)', margin: '10px 0 4px' }}>{desktopContext.groupName}</p>
          <p style={{ fontSize: '0.72rem', color: 'var(--slate-400)', marginBottom: 12, overflowWrap: 'anywhere' }}>{desktopContext.serverUrl}</p>
          <p style={{ fontSize: '0.75rem', color: 'var(--slate-400)', marginBottom: newerRelease ? 6 : 12 }}>このPCのバージョン: {desktopContext.appVersion ?? '1.0.4 以前'}</p>
          {newerRelease && <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--amber-400)' }}>新しいバージョン {newerRelease.version} を配布しています。</span>
            <a href={desktopDownloadPageUrl()} target="_blank" rel="noopener noreferrer" style={linkBtn}>ダウンロードページを開く</a>
          </div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => void window.desktop?.openConnectionSettings()} style={secondaryBtn}>接続先を変更</button>
            <button disabled={desktopContext.serverVersion < 1} onClick={() => void window.desktop?.openTimer()} style={secondaryBtn}>右下タイマーを表示</button>
            <button disabled={desktopContext.serverVersion < 1} onClick={() => void window.desktop?.openQuickProgress()} style={secondaryBtn}>進捗をひとこと</button>
          </div>
          {desktopContext.serverVersion < 1 && <p style={{ fontSize: '0.75rem', color: 'var(--amber-400)', marginTop: 8 }}>タイマーとクイック投稿を使うにはサーバー版を更新してください。</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14, fontSize: '0.8rem', color: 'var(--slate-300)' }}>
            {([
              ['showTimer', '起動時に右下タイマーを表示'],
              ['alwaysOnTop', 'タイマーを最前面に固定'],
              ['hideTaskTitle', 'タイマーにタスク名を表示しない'],
              ['showNotifications', '通知をデスクトップに表示']
            ] as const).filter(([key]) => typeof desktopContext.preferences[key] === 'boolean').map(([key, label]) => <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={desktopContext.preferences[key]} onChange={(event) => void saveDesktopPreference({ [key]: event.target.checked })} />{label}
            </label>)}
          </div>
          <p style={{ fontSize: '0.72rem', color: 'var(--slate-400)', marginTop: 12 }}>接続先・タイマー・通知・グローバルショートカットの設定は、このPCだけに保存されます。</p>
        </section>}

        {!showTeamTab && desktopReleaseSection}

        {serverManaged && <section>
          <h3 style={sectionHead}>パスワードの変更</h3>
          <form
            onSubmit={(event) => { event.preventDefault(); void changePassword() }}
            style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, maxWidth: 320 }}
          >
            <input type="password" autoComplete="current-password" aria-label="今のパスワード" placeholder="今のパスワード" value={passwordForm.current} onChange={(event) => updatePasswordForm({ current: event.target.value })} style={passwordInput} />
            <input type="password" autoComplete="new-password" aria-label="新しいパスワード" placeholder={`新しいパスワード（${MIN_PASSWORD_LENGTH}文字以上）`} value={passwordForm.next} onChange={(event) => updatePasswordForm({ next: event.target.value })} style={passwordInput} />
            <input type="password" autoComplete="new-password" aria-label="新しいパスワード（確認）" placeholder="新しいパスワード（確認）" value={passwordForm.confirm} onChange={(event) => updatePasswordForm({ confirm: event.target.value })} style={passwordInput} />
            {passwordError && <p role="alert" style={{ fontSize: '0.75rem', color: 'var(--red-300)', margin: 0 }}>{passwordError}</p>}
            <button type="submit" disabled={savingPassword || !passwordForm.current || !passwordForm.next || !passwordForm.confirm} style={{ ...primaryBtn, alignSelf: 'flex-start', opacity: savingPassword || !passwordForm.current || !passwordForm.next || !passwordForm.confirm ? 0.5 : 1 }}>
              {savingPassword ? '変更中…' : 'パスワードを変える'}
            </button>
          </form>
        </section>}

        {/* ─── 自分の進捗サマリー ─── */}
        {onMySummary && (
          <section>
            <h3 style={sectionHead}>進捗サマリー</h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-subtle)', margin: '6px 0 12px' }}>
              期間を指定して、追加タスク・タスク変更・進捗ログ・作業時間を振り返ります。タスク別のMarkdownをコピーして日報・週報に貼れます。
            </p>
            <button onClick={onMySummary} style={secondaryBtn}>📊 自分の進捗サマリーを開く</button>
          </section>
        )}

        {/* ─── 1. キーボードショートカット ─── */}
        <section>
          <h3 style={sectionHead}>表示テーマ</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-subtle)', margin: '6px 0 12px' }}>
            アプリの色をライト／ダークで切り替えます。「OS に合わせる」は Windows の設定に合わせて切り替わります。
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['dark', 'light', 'system'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => { void handleThemeSelect(mode) }}
                aria-pressed={themeMode === mode}
                style={{
                  ...secondaryBtn,
                  border: `1px solid ${themeMode === mode ? 'var(--blue-600)' : 'var(--slate-700)'}`,
                  background: themeMode === mode ? 'var(--blue-700)' : 'var(--slate-700)',
                  color: themeMode === mode ? 'var(--on-fill-blue-50)' : 'var(--slate-300)'
                }}
              >
                {THEME_LABELS[mode]}
              </button>
            ))}
          </div>
        </section>

        {/* ─── フォント ─── */}
        <section>
          <h3 style={sectionHead}>フォント</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-subtle)', margin: '6px 0 12px' }}>
            アプリ全体の表示フォントを切り替えます。
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {FONT_PRESETS.map((preset) => (
              <button
                key={preset.value}
                onClick={() => { void handleFontSelect(preset.value) }}
                style={{
                  ...secondaryBtn,
                  fontFamily: preset.value,
                  border: `1px solid ${fontFamily === preset.value ? 'var(--blue-600)' : 'var(--slate-700)'}`,
                  background: fontFamily === preset.value ? 'var(--blue-700)' : 'var(--slate-700)',
                  color: fontFamily === preset.value ? 'var(--on-fill-blue-50)' : 'var(--slate-300)'
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </section>

        {/* ─── 文字サイズ ─── */}
        <section>
          <h3 style={sectionHead}>文字サイズ</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-subtle)', margin: '6px 0 12px' }}>
            アプリ全体の文字サイズを切り替えます。
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {FONT_SCALE_PRESETS.map((preset) => (
              <button
                key={preset.value}
                aria-pressed={fontScale === preset.value}
                onClick={() => { void handleFontScaleSelect(preset.value) }}
                style={{
                  ...secondaryBtn,
                  border: `1px solid ${fontScale === preset.value ? 'var(--blue-600)' : 'var(--slate-700)'}`,
                  background: fontScale === preset.value ? 'var(--blue-700)' : 'var(--slate-700)',
                  color: fontScale === preset.value ? 'var(--on-fill-blue-50)' : 'var(--slate-300)'
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </section>

        {(!serverManaged || window.desktop) && <section>
          <h3 style={sectionHead}>キーボードショートカット</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-subtle)', margin: '6px 0 12px' }}>
            キーをクリックして新しいキーを押すと変更できます。Escでキャンセル。<br/>
            グローバルショートカットは、アプリを隠したり最小化したりしていても使えます。
          </p>

          {/* キャプチャ用隠しinput */}
          <input
            ref={captureRef}
            style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }}
            onKeyDown={(e) => editingIndex >= 0 && handleKeyCapture(e, editingIndex)}
            onBlur={cancelEdit}
            readOnly
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {shortcuts.map((s, i) => (
              <div key={s.key} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 12px', borderRadius: 8,
                background: s.editing ? 'var(--slate-900)' : 'transparent',
                border: `1px solid ${s.editing ? 'var(--indigo-500)' : 'transparent'}`
              }}>
                <div>
                  <div style={{ fontSize: '0.88rem', color: 'var(--slate-200)' }}>{s.label}</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-subtle)', marginTop: 2 }}>グローバル</div>
                </div>
                <button
                  onClick={() => s.editing ? cancelEdit() : startEdit(i)}
                  title={s.editing ? 'キーを押してください (Escでキャンセル)' : 'クリックして変更'}
                  style={{
                    background: s.editing ? 'color-mix(in srgb, var(--indigo-500) 18.8%, transparent)' : 'var(--slate-900)',
                    border: `1px solid ${s.editing ? 'var(--indigo-500)' : 'var(--slate-700)'}`,
                    borderRadius: 6, padding: '4px 12px', cursor: 'pointer',
                    color: s.editing ? 'var(--indigo-300)' : 'var(--slate-200)',
                    fontFamily: 'monospace', fontSize: '0.85rem', whiteSpace: 'nowrap',
                    minWidth: 160, textAlign: 'center'
                  }}
                >
                  {s.editing ? '⌨ キーを押してください…' : toDisplay(s.value)}
                </button>
              </div>
            ))}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 12px'
            }}>
              <div>
                <div style={{ fontSize: '0.88rem', color: 'var(--slate-200)' }}>モーダルを閉じる</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-subtle)', marginTop: 2 }}>アプリ内</div>
              </div>
              <kbd style={kbdStyle}>Esc</kbd>
            </div>
          </div>
        </section>}

        {/* ─── 2. アイコン ─── */}
        {!serverManaged && <section>
          <h3 style={sectionHead}>アイコン</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12 }}>
            {iconDataUrl && (
              <img
                src={iconDataUrl}
                alt="icon"
                style={{ width: 56, height: 56, borderRadius: 12, border: '2px solid var(--slate-700)', imageRendering: 'pixelated' }}
              />
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={handlePickIcon} style={primaryBtn}>📁 画像を選択… (PNG/JPG/ICO)</button>
              <button onClick={handleResetIcon} style={secondaryBtn}>デフォルトに戻す</button>
            </div>
          </div>
        </section>}

        {/* ─── 3. 通知 ─── */}
        {!serverManaged && <section>
          <h3 style={sectionHead}>期限通知</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-subtle)', margin: '6px 0 12px' }}>
            起動時・1時間ごとに期限が近いタスクを通知します。-1で通知しない。
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ fontSize: '0.78rem', color: 'var(--slate-400)', whiteSpace: 'nowrap' }}>何日前から通知</label>
            <input
              type="number"
              min={-1}
              max={30}
              value={notifyBeforeDays}
              onChange={(e) => setNotifyBeforeDays(e.target.value)}
              style={{ ...numInputStyle, width: 70 }}
            />
            <button
              onClick={async () => {
                await window.api.settingsSet('notifyBeforeDays', notifyBeforeDays)
                onShowToast('保存しました')
              }}
              style={secondaryBtn}
            >保存</button>
          </div>
          <p style={{ fontSize: '0.72rem', color: 'var(--text-subtle)', marginTop: 4 }}>0 = 当日のみ　1 = 前日から　-1 = 通知しない</p>
        </section>}
        </>}

        {settingsTab === 'team' && showTeamTab && <>
        {/* ─── 管理者: ユーザー管理 ─── */}
        {canManageUsers && onManageUsers && (
          <section>
            <h3 style={sectionHead}>管理者</h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-subtle)', margin: '6px 0 12px' }}>
              メンバーの追加・編集・削除、権限の変更、パスワードの再設定ができます。
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={onManageUsers} style={primaryBtn}>👤 ユーザー管理を開く</button>
              {onProgressReport && (
                <button onClick={onProgressReport} style={secondaryBtn}>📊 進捗レポートを開く</button>
              )}
              {onDesktopImport && (
                <button onClick={onDesktopImport} style={secondaryBtn}>💾 デスクトップDBを取り込む</button>
              )}
            </div>
            {serverManaged && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12, fontSize: '0.8rem', color: 'var(--slate-300)' }}>
                定例の曜日
                <select value={meetingWeekday} onChange={(event) => changeMeetingWeekday(event.target.value)} aria-label="定例の曜日" style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--slate-700)', background: 'var(--slate-900)', color: 'var(--slate-200)' }}>
                  <option value="">決めない（リマインドしない）</option>
                  {[1, 2, 3, 4, 5, 6, 0].map((day) => <option key={day} value={String(day)}>{MEETING_WEEKDAYS[day]}曜日</option>)}
                </select>
                <span style={{ fontSize: '0.75rem', color: 'var(--slate-400)' }}>前日の17時に、直近7日に報告がない担当タスクがある人へ通知します</span>
              </label>
            )}
          </section>
        )}

        {serverManaged && <section>
          <h3 style={sectionHead}>バックアップ</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--slate-400)', margin: '6px 0 12px', lineHeight: 1.6 }}>
            今のデータ（タスク・進捗ログ・作業記録・アカウントなど全部）を1つのファイルに保存します。
          </p>
          {backupInfo ? <>
            <a href={backupInfo.downloadUrl} download style={linkBtn}>💾 今のデータをダウンロード</a>
            <p style={{ fontSize: '0.75rem', color: 'var(--slate-400)', marginTop: 12, lineHeight: 1.6 }}>
              {backupInfo.keep > 0
                ? `サーバーは毎日1回、自動でバックアップを取り、${backupInfo.keep}日分を残します。${backupInfo.latestAt ? `いちばん新しいもの: ${formatLocal(backupInfo.latestAt)}（${backupInfo.count}件）` : 'まだ自動のバックアップはありません。'}`
                : '自動のバックアップは止めています（サーバーの設定 TODO_BACKUP_KEEP=0）。'}
            </p>
            <details style={{ marginTop: 6 }}>
              <summary style={detailsSummary}>詳しく</summary>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-subtle)', margin: '8px 0 4px' }}>自動のバックアップの置き場所（サーバーのフォルダ）</p>
              <div style={pathBox}>{backupInfo.directory}</div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-subtle)', marginTop: 8, lineHeight: 1.6 }}>戻すときは、サーバーを止めてから DB を差し替えます。手順は docs/HAKOBI.md の「バックアップから戻す」にあります。</p>
            </details>
          </> : <p style={{ fontSize: '0.8rem', color: backupError ? 'var(--red-300)' : 'var(--slate-400)' }}>{backupError ?? '読み込み中…'}</p>}
        </section>}

        {desktopReleaseSection}
        </>}

        {settingsTab === 'data' && <>
        {/* ─── データのエクスポート ─── */}
        <section>
          <h3 style={sectionHead}>データのエクスポート</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-subtle)', margin: '6px 0 12px' }}>
            CSV（UTF-8 BOM付き・Excel対応）でダウンロードします。
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => void exportCsv('todos')} disabled={exporting} style={secondaryBtn}>📋 タスクCSV</button>
            <button onClick={() => void exportCsv('subtasks')} disabled={exporting} style={secondaryBtn}>📑 サブタスクCSV</button>
            <button onClick={() => void exportCsv('worklogs')} disabled={exporting} style={secondaryBtn}>⏱ 作業ログCSV</button>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-subtle)', margin: '14px 0 12px' }}>
            Markdown形式でタスク一覧を出力します（クリップボードへのコピーは Ctrl+Alt+E でも可能）。
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => void onExportClipboard()} style={secondaryBtn}>📝 Markdownをコピー</button>
            <button onClick={() => void onExportFile()} style={secondaryBtn}>💾 Markdownを書き出し</button>
          </div>
        </section>

        {/* ─── 4. Markdownテンプレート ─── */}
        <section>
          <h3 style={sectionHead}>Markdownテンプレート</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-subtle)', margin: '6px 0 14px' }}>
            Markdownエクスポートの出力形式を変更します。変数: <code style={codeStyle}>{'{{date}}'}</code> <code style={codeStyle}>{'{{title}}'}</code> <code style={codeStyle}>{'{{category}}'}</code> <code style={codeStyle}>{'{{task_min}}'}</code> <code style={codeStyle}>{'{{start}}'}</code> <code style={codeStyle}>{'{{end}}'}</code> <code style={codeStyle}>{'{{min}}'}</code> <code style={codeStyle}>{'{{note}}'}</code> <code style={codeStyle}>{'{{total_min}}'}</code>
          </p>
          {(
            [
              { key: 'mdHeaderTpl', label: 'ヘッダー', hint: '変数: {{date}}' },
              { key: 'mdTaskTpl', label: 'タスク行', hint: '変数: {{title}} {{category}} {{task_min}}' },
              { key: 'mdEntryTpl', label: 'エントリー行', hint: '変数: {{start}} {{end}} {{min}} {{note}}' },
              { key: 'mdFooterTpl', label: 'フッター', hint: '変数: {{total_min}}' }
            ] as { key: keyof MdTemplates; label: string; hint: string }[]
          ).map(({ key, label, hint }) => (
            <div key={key} style={{ marginBottom: 14 }}>
              <label style={{ fontSize: '0.78rem', color: 'var(--slate-400)', display: 'block', marginBottom: 2 }}>
                {label} <span style={{ color: 'var(--text-subtle)', fontWeight: 'normal' }}>— {hint}</span>
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <textarea
                  value={mdTemplates[key]}
                  onChange={(e) => setMdTemplates((prev) => ({ ...prev, [key]: e.target.value }))}
                  rows={2}
                  style={{ ...textareaStyle, flex: 1 }}
                />
                <button
                  onClick={async () => {
                    await window.api.settingsSet(key, mdTemplates[key])
                    onShowToast('保存しました')
                  }}
                  style={{ ...secondaryBtn, alignSelf: 'flex-start' }}
                >保存</button>
              </div>
            </div>
          ))}
        </section>

        {/* ─── 4. 保持期間 ─── */}
        {!serverManaged && <section>
          <h3 style={sectionHead}>データ保持期間</h3>
          <div style={{ display: 'flex', gap: 20, marginTop: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: '0.78rem', color: 'var(--slate-400)', display: 'block', marginBottom: 4 }}>
                アーカイブ保持（日数）
              </label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  min={0}
                  value={archiveRetentionDays}
                  onChange={(e) => setArchiveRetentionDays(e.target.value)}
                  style={{ ...numInputStyle, width: 80 }}
                />
                <button
                  onClick={async () => {
                    await window.api.settingsSet('archiveRetentionDays', archiveRetentionDays)
                    onShowToast('保存しました')
                  }}
                  style={secondaryBtn}
                >保存</button>
              </div>
              <p style={{ fontSize: '0.72rem', color: 'var(--text-subtle)', marginTop: 4 }}>0 = 自動削除しない</p>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: '0.78rem', color: 'var(--slate-400)', display: 'block', marginBottom: 4 }}>
                作業ログ保持（日数）
              </label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  min={0}
                  value={workLogRetentionDays}
                  onChange={(e) => setWorkLogRetentionDays(e.target.value)}
                  style={{ ...numInputStyle, width: 80 }}
                />
                <button
                  onClick={async () => {
                    await window.api.settingsSet('workLogRetentionDays', workLogRetentionDays)
                    onShowToast('保存しました')
                  }}
                  style={secondaryBtn}
                >保存</button>
              </div>
              <p style={{ fontSize: '0.72rem', color: 'var(--text-subtle)', marginTop: 4 }}>0 = 無期限保持</p>
            </div>
          </div>
        </section>}

        {/* ─── 5. データ保存場所 ─── */}
        {!serverManaged && <section>
          <h3 style={sectionHead}>データ保存場所</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-subtle)', margin: '6px 0 12px' }}>
            変更すると既存データを新しいフォルダにコピーします。<br/>
            保存先はすぐに切り替わり、元のフォルダにもバックアップを残します。<br/>
            データが入っているフォルダは選択できません。
          </p>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-subtle)', marginBottom: 4 }}>現在の場所</div>
          <div style={pathBox}>{dataDir || '読み込み中…'}</div>

          <div style={{ fontSize: '0.72rem', color: 'var(--text-subtle)', margin: '12px 0 4px' }}>変更先</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ ...pathBox, flex: 1, cursor: 'default', color: newDataDir !== dataDir ? 'var(--indigo-300)' : 'var(--slate-400)' }}>
              {newDataDir || '…'}
            </div>
            <button onClick={handlePickDir} disabled={changingDir} style={secondaryBtn}>参照…</button>
          </div>

          {newDataDir !== dataDir && (
            <button
              onClick={handleChangeDir}
              disabled={changingDir}
              style={{ ...primaryBtn, marginTop: 10, width: '100%' }}
            >
              {changingDir ? '保存場所を変更中…' : 'コピーして保存場所を変更'}
            </button>
          )}

          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[
              { label: 'データベース', path: dataDir ? `${dataDir}\\todo.db` : '…' },
              { label: 'アイコン画像', path: dataDir ? `${dataDir}\\icons\\` : '…' }
            ].map(({ label, path: p }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-subtle)', whiteSpace: 'nowrap', width: 80 }}>{label}</span>
                <span style={{ ...pathBox, flex: 1, fontSize: '0.75rem' }}>{p}</span>
              </div>
            ))}
          </div>
        </section>}

        {serverManaged && <section>
          <h3 style={sectionHead}>旧版の下書き</h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--slate-400)', margin: '8px 0 12px', lineHeight: 1.6 }}>更新前にこのPCで入力した進捗やコメントが見つからない場合は、内容を確認して自分のアカウントへ復元できます。</p>
          <button type="button" onClick={() => setShowDraftRecovery(true)} style={secondaryBtn}>旧版の下書きを確認・復元</button>
        </section>}
        </>}
      </div>
    </div>
    {serverManaged && showDraftRecovery && <LegacyDraftRecoveryModal onClose={() => setShowDraftRecovery(false)} onShowToast={onShowToast} />}</>
  )
}

// ─── スタイル定数 ─────────────────────────────────────────────

const sectionHead: React.CSSProperties = {
  fontSize: '0.72rem', color: 'var(--text-subtle)', textTransform: 'uppercase',
  letterSpacing: '0.08em', fontWeight: 'bold'
}

const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--text-subtle)',
  cursor: 'pointer', fontSize: '1.2rem', padding: '2px 6px'
}

const primaryBtn: React.CSSProperties = {
  padding: '7px 14px', background: 'var(--indigo-500)', border: 'none',
  borderRadius: 7, color: 'var(--on-fill-white)', cursor: 'pointer', fontSize: '0.85rem',
  fontWeight: 'bold', whiteSpace: 'nowrap'
}

const secondaryBtn: React.CSSProperties = {
  padding: '7px 14px', background: 'var(--slate-700)', border: 'none',
  borderRadius: 7, color: 'var(--slate-400)', cursor: 'pointer', fontSize: '0.85rem',
  whiteSpace: 'nowrap'
}

const linkBtn: React.CSSProperties = {
  ...secondaryBtn, display: 'inline-block', color: 'var(--slate-200)', textDecoration: 'none'
}

const kbdStyle: React.CSSProperties = {
  display: 'inline-block', background: 'var(--slate-900)', border: '1px solid var(--slate-600)',
  borderRadius: 5, padding: '4px 12px', fontSize: '0.8rem',
  color: 'var(--slate-200)', fontFamily: 'monospace', whiteSpace: 'nowrap'
}

const detailsSummary: React.CSSProperties = {
  cursor: 'pointer',
  fontSize: '0.75rem',
  color: 'var(--slate-400)'
}

const passwordInput: React.CSSProperties = {
  padding: '7px 10px',
  borderRadius: 7,
  border: '1px solid var(--slate-700)',
  background: 'var(--slate-900)',
  color: 'var(--slate-200)',
  fontSize: '0.85rem'
}

const pathBox: React.CSSProperties = {
  background: 'var(--slate-900)', border: '1px solid var(--slate-800)', borderRadius: 5,
  padding: '6px 10px', fontSize: '0.78rem', color: 'var(--slate-400)',
  fontFamily: 'monospace', userSelect: 'all', wordBreak: 'break-all'
}

const numInputStyle: React.CSSProperties = {
  padding: '6px 8px', background: 'var(--slate-900)', border: '1px solid var(--slate-700)',
  borderRadius: 6, color: 'var(--slate-200)', fontSize: '0.85rem', outline: 'none'
}

const textareaStyle: React.CSSProperties = {
  padding: '6px 8px', background: 'var(--slate-900)', border: '1px solid var(--slate-700)',
  borderRadius: 6, color: 'var(--slate-200)', fontSize: '0.82rem', outline: 'none',
  fontFamily: 'monospace', resize: 'vertical'
}

const codeStyle: React.CSSProperties = {
  background: 'var(--slate-900)', border: '1px solid var(--slate-700)', borderRadius: 3,
  padding: '1px 4px', fontSize: '0.78rem', color: 'var(--indigo-300)', fontFamily: 'monospace'
}
