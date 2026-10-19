import React from 'react'
import {
  DEFAULT_REPORT_VIEW_SETTINGS,
  REPORT_SCOPE_OPTIONS,
  REPORT_STATUS_OPTIONS,
  REPORT_SUBTASK_OPTIONS,
  type ReportViewSettings
} from '../lib/reportViewSettings'
import type { Todo } from '../types'

// 報告タブの「表示設定」パネル。報告に出すタスクを、カテゴリ・状態・対象（期間との関係）で選び、
// サブタスクの見せ方・小見出しの有無・個別に隠したタスクを扱う。設定は見ている人ごとに保存される。

export interface ReportCategoryOption {
  /** カテゴリID（未分類は ''） */
  key: string
  label: string
  color: string | null
  /** 表示中のタスク一覧（検索などの絞り込み後）のうち、アーカイブ以外のタスク数 */
  count: number
}

interface Props {
  settings: ReportViewSettings
  onChange: (update: (previous: ReportViewSettings) => ReportViewSettings) => void
  categoryOptions: ReportCategoryOption[]
  hiddenTodos: Todo[]
  onUnhideTodo: (todo: Todo) => void
  /** 小見出しのチェックボックスの文言。小見出しを作れない表示（デスクトップ版など）では null */
  subGroupLabel: string | null
  onClose: () => void
}

export function ReportSettingsPanel({ settings, onChange, categoryOptions, hiddenTodos, onUnhideTodo, subGroupLabel, onClose }: Props): React.JSX.Element {
  const hiddenCategories = new Set(settings.hiddenCategoryKeys)

  const toggleCategory = (key: string): void => {
    onChange((previous) => ({
      ...previous,
      hiddenCategoryKeys: previous.hiddenCategoryKeys.includes(key)
        ? previous.hiddenCategoryKeys.filter((item) => item !== key)
        : [...previous.hiddenCategoryKeys, key]
    }))
  }

  // 「これだけ」: 押したカテゴリ以外をすべて隠す（選択肢はカテゴリ一覧のすべてと未分類）
  const showOnlyCategory = (key: string): void => {
    onChange((previous) => ({
      ...previous,
      hiddenCategoryKeys: categoryOptions.map((option) => option.key).filter((item) => item !== key)
    }))
  }

  const resetAll = (): void => {
    // 個別に隠したタスクと畳んだ小見出しは「既定に戻す」で消さない（積み上げたものなので、戻すのは個別に）
    onChange((previous) => ({
      ...DEFAULT_REPORT_VIEW_SETTINGS,
      statuses: { ...DEFAULT_REPORT_VIEW_SETTINGS.statuses },
      hiddenTodoIds: previous.hiddenTodoIds,
      collapsedSubGroupKeys: previous.collapsedSubGroupKeys
    }))
  }

  return (
    <section id="report-view-settings" aria-label="報告の表示設定" style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '0.86rem', color: 'var(--slate-200)' }}>表示設定</strong>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-subtle)' }}>自分の画面だけに反映されます（ほかの人の報告タブは変わりません）</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={resetAll} title="カテゴリ・状態・対象・サブタスク・小見出しを既定に戻します（個別に隠したタスクはそのまま）" style={smallButtonStyle}>既定に戻す</button>
          <button onClick={onClose} style={smallButtonStyle}>閉じる</button>
        </div>
      </div>

      <Row label="カテゴリ" hint="外したカテゴリのタスクは出しません">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {categoryOptions.map((option) => {
            const shown = !hiddenCategories.has(option.key)
            return (
              <span key={option.key || 'none'} style={categoryChipStyle(shown)}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                  <input type="checkbox" checked={shown} onChange={() => toggleCategory(option.key)} style={{ accentColor: 'var(--indigo-500)', margin: 0 }} />
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: option.color ?? 'var(--slate-600)', flexShrink: 0 }} />
                  {option.label}
                  <span style={{ color: 'var(--text-subtle)', fontWeight: 600 }}>{option.count}</span>
                </label>
                {categoryOptions.length > 1 && (
                  <button onClick={() => showOnlyCategory(option.key)} title={`「${option.label}」だけを出します`} style={onlyButtonStyle}>これだけ</button>
                )}
              </span>
            )
          })}
          {settings.hiddenCategoryKeys.length > 0 && (
            <button onClick={() => onChange((previous) => ({ ...previous, hiddenCategoryKeys: [] }))} style={smallButtonStyle}>すべて出す</button>
          )}
        </div>
      </Row>

      <Row label="状態">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {REPORT_STATUS_OPTIONS.map((option) => (
            <label key={option.key} title={option.title} style={checkLabelStyle}>
              <input
                type="checkbox"
                checked={settings.statuses[option.key]}
                onChange={(event) => onChange((previous) => ({ ...previous, statuses: { ...previous.statuses, [option.key]: event.target.checked } }))}
                style={{ accentColor: 'var(--indigo-500)' }}
              />
              {option.label}
            </label>
          ))}
        </div>
      </Row>

      <Row label="対象">
        <div role="radiogroup" aria-label="対象" style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {REPORT_SCOPE_OPTIONS.map((option) => (
            <label key={option.value} title={option.title} style={checkLabelStyle}>
              <input
                type="radio"
                name="report-scope"
                checked={settings.scope === option.value}
                onChange={() => onChange((previous) => ({ ...previous, scope: option.value }))}
                style={{ accentColor: 'var(--indigo-500)' }}
              />
              {option.label}
            </label>
          ))}
        </div>
      </Row>

      <Row label="サブタスク">
        <div role="radiogroup" aria-label="サブタスクの見せ方" style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {REPORT_SUBTASK_OPTIONS.map((option) => (
            <label key={option.value} style={checkLabelStyle}>
              <input
                type="radio"
                name="report-subtask-mode"
                checked={settings.subTaskMode === option.value}
                onChange={() => onChange((previous) => ({ ...previous, subTaskMode: option.value }))}
                style={{ accentColor: 'var(--indigo-500)' }}
              />
              {option.label}
            </label>
          ))}
        </div>
      </Row>

      {subGroupLabel && (
        <Row label="小見出し">
          <label style={checkLabelStyle}>
            <input
              type="checkbox"
              checked={settings.splitSubGroups}
              onChange={(event) => onChange((previous) => ({ ...previous, splitSubGroups: event.target.checked }))}
              style={{ accentColor: 'var(--indigo-500)' }}
            />
            {subGroupLabel}
            <span style={{ fontSize: '0.7rem', color: 'var(--text-subtle)' }}>（折りたたんだ小見出しは、次に開いたときも折りたたんだまま）</span>
          </label>
        </Row>
      )}

      <Row label="隠したタスク" hint="カードの「隠す」で出さないことにしたタスク">
        {hiddenTodos.length === 0 ? (
          <span style={{ fontSize: '0.76rem', color: 'var(--text-subtle)' }}>ありません</span>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {hiddenTodos.map((todo) => (
              <span key={todo.id} style={hiddenTodoChipStyle}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>{todo.title}</span>
                <button onClick={() => onUnhideTodo(todo)} aria-label={`${todo.title}を報告に戻す`} style={onlyButtonStyle}>戻す</button>
              </span>
            ))}
            {hiddenTodos.length > 1 && (
              <button onClick={() => onChange((previous) => ({ ...previous, hiddenTodoIds: [] }))} style={smallButtonStyle}>すべて戻す</button>
            )}
          </div>
        )}
      </Row>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', paddingTop: 10, borderTop: '1px solid var(--slate-800)' }}>
      <div style={{ width: 110, flexShrink: 0, paddingTop: 2 }}>
        <div style={{ fontSize: '0.78rem', color: 'var(--slate-300)', fontWeight: 700 }}>{label}</div>
        {hint && <div style={{ fontSize: '0.66rem', color: 'var(--text-subtle)', marginTop: 2, lineHeight: 1.4 }}>{hint}</div>}
      </div>
      <div style={{ flex: '1 1 320px', minWidth: 0 }}>{children}</div>
    </div>
  )
}

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '12px 14px',
  background: 'var(--c-0b1220)',
  border: '1px solid var(--slate-700)',
  borderRadius: 12
}

const smallButtonStyle: React.CSSProperties = {
  padding: '3px 9px',
  background: 'var(--gray-900)',
  border: '1px solid var(--slate-700)',
  borderRadius: 7,
  color: 'var(--slate-300)',
  cursor: 'pointer',
  fontSize: '0.72rem',
  fontWeight: 700,
  whiteSpace: 'nowrap'
}

const checkLabelStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: '0.78rem',
  color: 'var(--slate-300)',
  cursor: 'pointer'
}

function categoryChipStyle(shown: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 8px',
    borderRadius: 999,
    border: `1px solid ${shown ? 'var(--slate-700)' : 'var(--gray-800)'}`,
    background: shown ? 'var(--gray-900)' : 'transparent',
    color: shown ? 'var(--slate-200)' : 'var(--slate-500)',
    fontSize: '0.76rem',
    fontWeight: 700,
    textDecoration: shown ? 'none' : 'line-through'
  }
}

const onlyButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  color: 'var(--indigo-400)',
  cursor: 'pointer',
  fontSize: '0.68rem',
  fontWeight: 700,
  textDecoration: 'none'
}

const hiddenTodoChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '3px 9px',
  borderRadius: 999,
  border: '1px solid var(--slate-700)',
  background: 'var(--gray-900)',
  color: 'var(--slate-300)',
  fontSize: '0.76rem',
  minWidth: 0
}
