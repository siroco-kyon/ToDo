import React, { useState, useEffect, useRef } from 'react'
import { toCsv, downloadCsv, dateStamp } from '../lib/csv'
import type { Todo } from '../types'

interface Props {
  onClose: () => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
  themeMode: ThemeMode
  onThemeChange: (mode: ThemeMode) => Promise<void>
  canManageUsers?: boolean
  onManageUsers?: () => void
  onProgressReport?: () => void
  onDesktopImport?: () => void
}

const STATUS_LABEL: Record<Todo['status'], string> = {
  not_started: '未着手',
  active: '進行中',
  done: '完了',
  archived: 'アーカイブ'
}

const RECURRENCE_LABEL: Record<string, string> = { daily: '毎日', weekly: '毎週', monthly: '毎月' }

function formatLocal(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

type ThemeMode = 'dark' | 'light'

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

export function SettingsModal({ onClose, onShowToast, themeMode, onThemeChange, canManageUsers = false, onManageUsers, onProgressReport, onDesktopImport }: Props): React.JSX.Element {
  const [exporting, setExporting] = useState(false)

  const exportCsv = async (kind: 'todos' | 'subtasks' | 'worklogs'): Promise<void> => {
    if (exporting) return
    setExporting(true)
    try {
      if (kind === 'todos') {
        const todos = await window.api.todoGetAll()
        downloadCsv(`tasks_${dateStamp()}.csv`, toCsv(
          ['ID', 'タイトル', '説明', 'メモ', 'カテゴリ', '担当者', '状態', '優先度', '進捗(%)', '開始日', '締切日', '繰り返し', '作成日時', '更新日時'],
          todos.map((todo) => [
            todo.id, todo.title, todo.description, todo.memo,
            todo.category_name, todo.assignee_name,
            STATUS_LABEL[todo.status] ?? todo.status, todo.priority, todo.progress,
            todo.start_date, todo.due_date,
            todo.recurrence ? RECURRENCE_LABEL[todo.recurrence] ?? todo.recurrence : '',
            formatLocal(todo.created_at), formatLocal(todo.updated_at)
          ])
        ))
      } else if (kind === 'subtasks') {
        const [todos, subTasks] = await Promise.all([window.api.todoGetAll(), window.api.subtaskGetAll()])
        const titleById = new Map(todos.map((todo) => [todo.id, todo.title]))
        downloadCsv(`subtasks_${dateStamp()}.csv`, toCsv(
          ['ID', 'タスク', 'サブタスク', 'メモ', '開始日', '締切日', '完了', '完了日時', '作成日時'],
          subTasks.map((sub) => [
            sub.id, titleById.get(sub.todo_id) ?? sub.todo_id, sub.title, sub.description,
            sub.start_date, sub.due_date, sub.done ? '済' : '',
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
    { key: 'globalShortcutExport', label: 'Markdownコピー', value: 'CommandOrControl+Alt+E', editing: false }
  ])
  const [iconDataUrl, setIconDataUrl] = useState('')
  const [dataDir, setDataDir] = useState('')
  const [newDataDir, setNewDataDir] = useState('')
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
    setShortcuts(updated)
    await window.api.settingsSet(shortcuts[index].key, accelerator)
    await window.api.shortcutsReregister()
    onShowToast('ショートカットを更新しました')
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
    const picked = await window.api.dataPickDir()
    if (picked) setNewDataDir(picked)
  }

  const handleChangeDir = async (): Promise<void> => {
    if (newDataDir === dataDir) { onShowToast('現在と同じ場所です', 'error'); return }
    const result = await window.api.dataChangeDir(newDataDir)
    if (result.moved) {
      setDataDir(newDataDir)
      onShowToast('コピーしました。再起動後に有効になります')
    }
  }

  const handleThemeSelect = async (nextMode: ThemeMode): Promise<void> => {
    if (nextMode === themeMode) return
    try {
      await onThemeChange(nextMode)
      onShowToast(`表示テーマを${nextMode === 'light' ? 'ライト' : 'ダーク'}に変更しました`)
    } catch {
      onShowToast('テーマの変更に失敗しました', 'error')
    }
  }

  const editingIndex = shortcuts.findIndex((s) => s.editing)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
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
  }, [cancelEdit, editingIndex, onClose])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        background: '#1e293b', borderRadius: 14, padding: 28, width: 560,
        maxHeight: '85vh', overflowY: 'auto',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)', border: '1px solid #334155',
        display: 'flex', flexDirection: 'column', gap: 28
      }}>
        {/* ヘッダー */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: '1.1rem', color: '#e2e8f0' }}>⚙ 設定</h2>
          <button onClick={onClose} style={closeBtnStyle}>×</button>
        </div>

        {/* ─── 管理者: ユーザー管理 ─── */}
        {canManageUsers && onManageUsers && (
          <section>
            <h3 style={sectionHead}>管理者</h3>
            <p style={{ fontSize: '0.75rem', color: '#475569', margin: '6px 0 12px' }}>
              メンバーの追加・編集・権限変更・パスワード再設定を行います。
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
          </section>
        )}

        {/* ─── データのエクスポート ─── */}
        <section>
          <h3 style={sectionHead}>データのエクスポート</h3>
          <p style={{ fontSize: '0.75rem', color: '#475569', margin: '6px 0 12px' }}>
            CSV（UTF-8 BOM付き・Excel対応）でダウンロードします。バックアップや共有にどうぞ。
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => void exportCsv('todos')} disabled={exporting} style={secondaryBtn}>📋 タスクCSV</button>
            <button onClick={() => void exportCsv('subtasks')} disabled={exporting} style={secondaryBtn}>📑 サブタスクCSV</button>
            <button onClick={() => void exportCsv('worklogs')} disabled={exporting} style={secondaryBtn}>⏱ 作業ログCSV</button>
          </div>
        </section>

        {/* ─── 1. キーボードショートカット ─── */}
        <section>
          <h3 style={sectionHead}>表示テーマ</h3>
          <p style={{ fontSize: '0.75rem', color: '#475569', margin: '6px 0 12px' }}>
            アプリ表示をライト/ダークで切り替えます。設定は保存され、次回起動時も維持されます。
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => { void handleThemeSelect('dark') }}
              style={{
                ...secondaryBtn,
                border: `1px solid ${themeMode === 'dark' ? '#2563eb' : '#334155'}`,
                background: themeMode === 'dark' ? '#1d4ed8' : '#334155',
                color: themeMode === 'dark' ? '#eff6ff' : '#cbd5e1'
              }}
            >
              ダーク
            </button>
            <button
              onClick={() => { void handleThemeSelect('light') }}
              style={{
                ...secondaryBtn,
                border: `1px solid ${themeMode === 'light' ? '#2563eb' : '#334155'}`,
                background: themeMode === 'light' ? '#1d4ed8' : '#334155',
                color: themeMode === 'light' ? '#eff6ff' : '#cbd5e1'
              }}
            >
              ライト
            </button>
          </div>
        </section>

        <section>
          <h3 style={sectionHead}>キーボードショートカット</h3>
          <p style={{ fontSize: '0.75rem', color: '#475569', margin: '6px 0 12px' }}>
            キーをクリックして新しいキーを押すと変更できます。Escでキャンセル。<br/>
            グローバルはアプリが非表示・最小化でも動作します。
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
                background: s.editing ? '#0f172a' : 'transparent',
                border: `1px solid ${s.editing ? '#6366f1' : 'transparent'}`
              }}>
                <div>
                  <div style={{ fontSize: '0.88rem', color: '#e2e8f0' }}>{s.label}</div>
                  <div style={{ fontSize: '0.72rem', color: '#475569', marginTop: 2 }}>グローバル</div>
                </div>
                <button
                  onClick={() => s.editing ? cancelEdit() : startEdit(i)}
                  title={s.editing ? 'キーを押してください (Escでキャンセル)' : 'クリックして変更'}
                  style={{
                    background: s.editing ? '#6366f130' : '#0f172a',
                    border: `1px solid ${s.editing ? '#6366f1' : '#334155'}`,
                    borderRadius: 6, padding: '4px 12px', cursor: 'pointer',
                    color: s.editing ? '#a5b4fc' : '#e2e8f0',
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
                <div style={{ fontSize: '0.88rem', color: '#e2e8f0' }}>モーダルを閉じる</div>
                <div style={{ fontSize: '0.72rem', color: '#475569', marginTop: 2 }}>アプリ内</div>
              </div>
              <kbd style={kbdStyle}>Esc</kbd>
            </div>
          </div>
        </section>

        {/* ─── 2. アイコン ─── */}
        <section>
          <h3 style={sectionHead}>アイコン</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12 }}>
            {iconDataUrl && (
              <img
                src={iconDataUrl}
                alt="icon"
                style={{ width: 56, height: 56, borderRadius: 12, border: '2px solid #334155', imageRendering: 'pixelated' }}
              />
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={handlePickIcon} style={primaryBtn}>📁 画像を選択… (PNG/JPG/ICO)</button>
              <button onClick={handleResetIcon} style={secondaryBtn}>デフォルトに戻す</button>
            </div>
          </div>
        </section>

        {/* ─── 3. 通知 ─── */}
        <section>
          <h3 style={sectionHead}>期限通知</h3>
          <p style={{ fontSize: '0.75rem', color: '#475569', margin: '6px 0 12px' }}>
            起動時・1時間ごとに期限が近いタスクを通知します。-1で通知しない。
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ fontSize: '0.78rem', color: '#94a3b8', whiteSpace: 'nowrap' }}>何日前から通知</label>
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
          <p style={{ fontSize: '0.72rem', color: '#475569', marginTop: 4 }}>0 = 当日のみ　1 = 前日から　-1 = 通知しない</p>
        </section>

        {/* ─── 4. 保持期間 ─── */}
        <section>
          <h3 style={sectionHead}>データ保持期間</h3>
          <div style={{ display: 'flex', gap: 20, marginTop: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: '0.78rem', color: '#94a3b8', display: 'block', marginBottom: 4 }}>
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
              <p style={{ fontSize: '0.72rem', color: '#475569', marginTop: 4 }}>0 = 自動削除しない</p>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: '0.78rem', color: '#94a3b8', display: 'block', marginBottom: 4 }}>
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
              <p style={{ fontSize: '0.72rem', color: '#475569', marginTop: 4 }}>0 = 無期限保持</p>
            </div>
          </div>
        </section>

        {/* ─── 4. Markdownテンプレート ─── */}
        <section>
          <h3 style={sectionHead}>Markdownテンプレート</h3>
          <p style={{ fontSize: '0.75rem', color: '#475569', margin: '6px 0 14px' }}>
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
              <label style={{ fontSize: '0.78rem', color: '#94a3b8', display: 'block', marginBottom: 2 }}>
                {label} <span style={{ color: '#475569', fontWeight: 'normal' }}>— {hint}</span>
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

        {/* ─── 5. データ保存場所 ─── */}
        <section>
          <h3 style={sectionHead}>データ保存場所</h3>
          <p style={{ fontSize: '0.75rem', color: '#475569', margin: '6px 0 12px' }}>
            変更すると既存データを新しいフォルダにコピーします。<br/>
            適用は<strong style={{ color: '#f59e0b' }}>再起動後</strong>に有効になります。
          </p>
          <div style={{ fontSize: '0.72rem', color: '#64748b', marginBottom: 4 }}>現在の場所</div>
          <div style={pathBox}>{dataDir || '読み込み中…'}</div>

          <div style={{ fontSize: '0.72rem', color: '#64748b', margin: '12px 0 4px' }}>変更先</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ ...pathBox, flex: 1, cursor: 'default', color: newDataDir !== dataDir ? '#a5b4fc' : '#94a3b8' }}>
              {newDataDir || '…'}
            </div>
            <button onClick={handlePickDir} style={secondaryBtn}>参照…</button>
          </div>

          {newDataDir !== dataDir && (
            <button
              onClick={handleChangeDir}
              style={{ ...primaryBtn, marginTop: 10, width: '100%' }}
            >
              コピーして変更を適用（要再起動）
            </button>
          )}

          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[
              { label: 'データベース', path: dataDir ? `${dataDir}\\todo.db` : '…' },
              { label: 'アイコン画像', path: dataDir ? `${dataDir}\\icons\\` : '…' }
            ].map(({ label, path: p }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: '0.72rem', color: '#64748b', whiteSpace: 'nowrap', width: 80 }}>{label}</span>
                <span style={{ ...pathBox, flex: 1, fontSize: '0.75rem' }}>{p}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

// ─── スタイル定数 ─────────────────────────────────────────────

const sectionHead: React.CSSProperties = {
  fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase',
  letterSpacing: '0.08em', fontWeight: 'bold'
}

const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#64748b',
  cursor: 'pointer', fontSize: '1.2rem', padding: '2px 6px'
}

const primaryBtn: React.CSSProperties = {
  padding: '7px 14px', background: '#6366f1', border: 'none',
  borderRadius: 7, color: '#fff', cursor: 'pointer', fontSize: '0.85rem',
  fontWeight: 'bold', whiteSpace: 'nowrap'
}

const secondaryBtn: React.CSSProperties = {
  padding: '7px 14px', background: '#334155', border: 'none',
  borderRadius: 7, color: '#94a3b8', cursor: 'pointer', fontSize: '0.85rem',
  whiteSpace: 'nowrap'
}

const kbdStyle: React.CSSProperties = {
  display: 'inline-block', background: '#0f172a', border: '1px solid #475569',
  borderRadius: 5, padding: '4px 12px', fontSize: '0.8rem',
  color: '#e2e8f0', fontFamily: 'monospace', whiteSpace: 'nowrap'
}

const pathBox: React.CSSProperties = {
  background: '#0f172a', border: '1px solid #1e293b', borderRadius: 5,
  padding: '6px 10px', fontSize: '0.78rem', color: '#94a3b8',
  fontFamily: 'monospace', userSelect: 'all', wordBreak: 'break-all'
}

const numInputStyle: React.CSSProperties = {
  padding: '6px 8px', background: '#0f172a', border: '1px solid #334155',
  borderRadius: 6, color: '#e2e8f0', fontSize: '0.85rem', outline: 'none'
}

const textareaStyle: React.CSSProperties = {
  padding: '6px 8px', background: '#0f172a', border: '1px solid #334155',
  borderRadius: 6, color: '#e2e8f0', fontSize: '0.82rem', outline: 'none',
  fontFamily: 'monospace', resize: 'vertical'
}

const codeStyle: React.CSSProperties = {
  background: '#0f172a', border: '1px solid #334155', borderRadius: 3,
  padding: '1px 4px', fontSize: '0.78rem', color: '#a5b4fc', fontFamily: 'monospace'
}
