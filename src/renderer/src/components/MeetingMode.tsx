import React, { useEffect, useState, useRef } from 'react'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { copyTextToClipboard } from '../lib/clipboard'

/** 定例モードで1人ずつ見せるまとまり（担当者別なら担当者、カテゴリ別ならカテゴリ） */
export interface MeetingGroup {
  key: string
  label: string
  color: string | null
  /** 見出しの横に出す件数など（例: 「5件・報告なし 1・要相談 2」） */
  summary: string
}

/** 定例の進み具合。報告タブを開いている間は、定例モードを閉じても残す */
export interface MeetingState {
  startedAt: number
  index: number
  /** 今話している人（まとまり）のキー。並びが変わったり、その人が一覧から外れたりしても時間を取り違えないため */
  currentKey: string | null
  /** 話した人の表示名。一覧から外れた人も議事録に残すため */
  labels: Record<string, string>
  /** 今の人を表示し始めた時刻 */
  personStartedAt: number
  /** まとまりごとに使った秒数（前の人に戻ったときは足していく） */
  spentSeconds: Record<string, number>
  notes: Record<string, string>
  /** その場で作ったタスクの名前 */
  createdTasks: Record<string, string[]>
  targetMinutes: number
  /** 閉じていた時間の合計（議事録の会議時間に入れない） */
  pausedMs: number
  /** 閉じた時刻（開いているあいだは null） */
  pausedAt: number | null
}

function toKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 決まったことの期限の近道（なし・今週金曜・来週金曜・2週間後） */
export function meetingDueChoices(today = new Date()): Array<{ label: string; value: string | null }> {
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const thisFriday = new Date(base)
  thisFriday.setDate(base.getDate() + ((5 - base.getDay() + 7) % 7))
  const nextFriday = new Date(thisFriday)
  nextFriday.setDate(thisFriday.getDate() + 7)
  const twoWeeks = new Date(base)
  twoWeeks.setDate(base.getDate() + 14)
  const short = (date: Date): string => `${date.getMonth() + 1}/${date.getDate()}`
  return [
    { label: 'なし', value: null },
    { label: `今週金曜 ${short(thisFriday)}`, value: toKey(thisFriday) },
    { label: `来週金曜 ${short(nextFriday)}`, value: toKey(nextFriday) },
    { label: `2週間後 ${short(twoWeeks)}`, value: toKey(twoWeeks) }
  ]
}

export function createMeetingState(now = Date.now(), first?: { key: string; label: string }): MeetingState {
  return {
    startedAt: now,
    index: 0,
    currentKey: first?.key ?? null,
    labels: first ? { [first.key]: first.label } : {},
    personStartedAt: now,
    spentSeconds: {},
    notes: {},
    createdTasks: {},
    targetMinutes: 3,
    pausedMs: 0,
    pausedAt: null
  }
}

/** 開き直すとき: 閉じていた時間を会議時間から外し、今の人の時間はここから数え直す */
export function resumeMeetingState(state: MeetingState, now = Date.now()): MeetingState {
  return {
    ...state,
    personStartedAt: now,
    pausedMs: state.pausedMs + (state.pausedAt != null ? Math.max(0, now - state.pausedAt) : 0),
    pausedAt: null
  }
}

/** 会議の時間（閉じていた時間を除く） */
function activeMeetingMs(state: MeetingState, now: number): number {
  const pausing = state.pausedAt != null ? Math.max(0, now - state.pausedAt) : 0
  return Math.max(0, now - state.startedAt - state.pausedMs - pausing)
}

interface Props {
  groups: MeetingGroup[]
  state: MeetingState
  onStateChange: (updater: (previous: MeetingState) => MeetingState) => void
  /** 期間の表示（議事録の見出しに使う） */
  periodLabel: string
  renderBody: (groupKey: string) => React.ReactNode
  /** 決まったことをタスクにする。作れたら true */
  onCreateTask?: (groupKey: string, title: string, dueDate: string | null) => Promise<boolean>
  /** タスクを作るときの担当・カテゴリの説明（例: 「担当: 佐藤」） */
  createTaskHint: (groupKey: string) => string
  onShowToast: (message: string, type?: 'success' | 'error') => void
  onClose: () => void
}

const TARGET_MINUTE_OPTIONS = [1, 2, 3, 5, 10]

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function formatMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  return minutes < 1 ? '1分未満' : `${minutes}分`
}

function formatClock(time: number): string {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 今の人の経過時間を足した、まとまりごとの使った秒数（閉じているあいだは足さない） */
function spentWithCurrent(state: MeetingState, now: number): Record<string, number> {
  const key = state.currentKey
  if (key == null || state.pausedAt != null) return state.spentSeconds
  return { ...state.spentSeconds, [key]: (state.spentSeconds[key] ?? 0) + Math.max(0, now - state.personStartedAt) / 1000 }
}

/** 今の人を切り替える。それまでの時間は前の人に足す */
function switchPerson(state: MeetingState, target: MeetingGroup, index: number, now: number): MeetingState {
  return {
    ...state,
    spentSeconds: spentWithCurrent(state, now),
    index,
    currentKey: target.key,
    labels: { ...state.labels, [target.key]: target.label },
    personStartedAt: now
  }
}

/** 議事録（Markdown）。話した人・メモ・その場で作ったタスクを残す */
export function meetingMinutesMarkdown(groups: MeetingGroup[], state: MeetingState, periodLabel: string, now = Date.now()): string {
  const spent = spentWithCurrent(state, now)
  const started = new Date(state.startedAt)
  const lines = [
    `# 定例 ${started.getMonth() + 1}/${started.getDate()}（${['日', '月', '火', '水', '木', '金', '土'][started.getDay()]}）`,
    '',
    `- 報告の期間: ${periodLabel}`,
    `- 時間: ${formatClock(state.startedAt)}〜${formatClock(now)}（${formatMinutes(activeMeetingMs(state, now) / 1000)}${state.pausedMs > 0 || state.pausedAt != null ? '。中断した時間を除く' : ''}）`
  ]
  // 途中で一覧から外れた人（報告して「報告なし」の絞り込みから外れたなど）も、話していれば最後に載せる
  const shownKeys = new Set(groups.map((group) => group.key))
  const leftGroups = [...new Set([...Object.keys(spent), ...Object.keys(state.notes), ...Object.keys(state.createdTasks)])]
    .filter((key) => !shownKeys.has(key))
    .map((key) => ({ key, label: state.labels[key] ?? '（一覧から外れた担当）' }))
  for (const group of [...groups, ...leftGroups]) {
    const seconds = spent[group.key] ?? 0
    const note = (state.notes[group.key] ?? '').trim()
    const tasks = state.createdTasks[group.key] ?? []
    if (seconds < 1 && !note && tasks.length === 0) continue
    lines.push('', `## ${group.label}（${formatMinutes(seconds)}）`)
    if (tasks.length > 0) {
      lines.push('- 決まったこと（タスクにしたもの）')
      for (const task of tasks) lines.push(`  - ${task}`)
    }
    if (note) {
      lines.push('- メモ')
      for (const line of note.split('\n')) lines.push(`  ${line}`)
    }
  }
  return `${lines.join('\n')}\n`
}

// 定例モード。報告タブの担当者（カテゴリ）を1人ずつ大きく表示し、持ち時間を計りながら進める。
// 決まったことはその場でタスクにでき、終わったら議事録をコピーできる
export function MeetingMode({ groups, state, onStateChange, periodLabel, renderBody, onCreateTask, createTaskHint, onShowToast, onClose }: Props): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)
  // 開いたら「次の人」へフォーカスを置く（先頭の「持ち時間」の選択欄だと、矢印キーで持ち時間が変わり、Esc も2回要った）。
  // 最後の人などで押せないときは、小窓そのものに置く（次の Esc で閉じる）
  const nextButtonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const next = nextButtonRef.current
    if (next && !next.disabled) next.focus()
    else dialogRef.current?.focus()
  }, [])
  const [now, setNow] = useState(() => Date.now())
  const [taskTitle, setTaskTitle] = useState('')
  // 決まったことの期限（その場で決めることが多いので、よく使う日を近道で選べるようにする）
  const [taskDue, setTaskDue] = useState<string | null>(null)
  const dueChoices = meetingDueChoices()
  const [creatingTask, setCreatingTask] = useState(false)
  // 今の人はキーで探す（並びが変わっても同じ人のまま）。一覧から外れていたら、同じ位置の人を見せる
  const keyedIndex = state.currentKey == null ? -1 : groups.findIndex((item) => item.key === state.currentKey)
  const index = keyedIndex >= 0 ? keyedIndex : Math.min(state.index, Math.max(groups.length - 1, 0))
  const group = groups[index]

  // 見せている人と今の人が違う（今の人が一覧から外れた）ときは、そこまでの時間を前の人に足して切り替える
  useEffect(() => {
    if (!group || state.currentKey === group.key) return
    const at = Date.now()
    onStateChange((previous) => previous.currentKey === group.key ? previous : switchPerson(previous, group, index, at))
  }, [group, index, onStateChange, state.currentKey])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const goTo = (nextIndex: number): void => {
    if (nextIndex < 0 || nextIndex >= groups.length || nextIndex === index) return
    const at = Date.now()
    const target = groups[nextIndex]
    onStateChange((previous) => switchPerson(previous, target, nextIndex, at))
    setTaskTitle('')
  }

  // ←→ で前の人・次の人、Esc で閉じる（入力中の Esc は、まず入力欄から抜ける。もう一度押すと閉じる）
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing = target != null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      // 入力欄から抜けるときは、フォーカスを小窓そのものへ移す（blur だけだとページの先頭へ落ち、次の Esc が効かなかった）
      if (event.key === 'Escape' && typing && !event.isComposing) { event.preventDefault(); dialogRef.current?.focus({ preventScroll: true }); return }
      if (event.key === 'Escape' && !typing) { event.preventDefault(); close(); return }
      if (typing || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key === 'ArrowRight') { event.preventDefault(); goTo(index + 1) }
      if (event.key === 'ArrowLeft') { event.preventDefault(); goTo(index - 1) }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  // 閉じている間は今の人の時間を止める（ここまでの時間を足しておき、開き直した時刻から数え直す）
  const close = (): void => {
    const at = Date.now()
    onStateChange((previous) => ({ ...previous, spentSeconds: spentWithCurrent(previous, at), personStartedAt: at, pausedAt: at }))
    onClose()
  }

  const copyMinutes = async (): Promise<void> => {
    try {
      await copyTextToClipboard(meetingMinutesMarkdown(groups, state, periodLabel))
      onShowToast('議事録をコピーしました')
    } catch {
      onShowToast('クリップボードへのコピーに失敗しました', 'error')
    }
  }

  const createTask = async (): Promise<void> => {
    const title = taskTitle.trim()
    if (!group || !title || !onCreateTask || creatingTask) return
    setCreatingTask(true)
    const ok = await onCreateTask(group.key, title, taskDue)
    setCreatingTask(false)
    if (!ok) return
    setTaskTitle('')
    setTaskDue(null)
    onStateChange((previous) => ({ ...previous, createdTasks: { ...previous.createdTasks, [group.key]: [...(previous.createdTasks[group.key] ?? []), title] } }))
  }

  const personSeconds = group
    ? (state.spentSeconds[group.key] ?? 0) + (state.currentKey === group.key ? Math.max(0, now - state.personStartedAt) / 1000 : 0)
    : 0
  const overTime = personSeconds > state.targetMinutes * 60
  const nearTime = !overTime && personSeconds > state.targetMinutes * 60 - 30

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="定例モード" tabIndex={-1} style={{ outline: 'none', position: 'fixed', inset: 0, zIndex: 950, background: 'var(--c-0b1220)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 20px', borderBottom: '1px solid var(--slate-800)', background: 'var(--slate-900)' }}>
        <span style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--indigo-300)' }}>定例モード</span>
        {group && (
          <>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: group.color ?? 'var(--slate-600)', flexShrink: 0 }} />
            <span style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--slate-50)' }}>{group.label}</span>
            <span style={{ fontSize: '0.8rem', color: 'var(--slate-400)' }}>{group.summary}</span>
          </>
        )}
        <span style={{ fontSize: '0.8rem', color: 'var(--slate-400)' }}>{groups.length > 0 ? `${index + 1} / ${groups.length}` : ''}</span>

        <span
          role="timer"
          aria-label={`この人の時間 ${formatDuration(personSeconds)}`}
          style={{ marginLeft: 'auto', fontSize: '1.3rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: overTime ? 'var(--red-400)' : nearTime ? 'var(--amber-400)' : 'var(--slate-200)' }}
        >
          {formatDuration(personSeconds)}
        </span>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--slate-400)' }}>
          持ち時間
          <select
            value={state.targetMinutes}
            onChange={(event) => onStateChange((previous) => ({ ...previous, targetMinutes: Number(event.target.value) }))}
            style={{ padding: '4px 6px', borderRadius: 6, border: '1px solid var(--slate-700)', background: 'var(--slate-900)', color: 'var(--slate-200)' }}
          >
            {TARGET_MINUTE_OPTIONS.map((minutes) => <option key={minutes} value={minutes}>{minutes}分</option>)}
          </select>
        </label>
        <button onClick={() => goTo(index - 1)} disabled={index === 0} title="前の人（←）" style={navButtonStyle(index === 0)}>◀ 前の人</button>
        <button ref={nextButtonRef} onClick={() => goTo(index + 1)} disabled={index >= groups.length - 1} title="次の人（→）" style={navButtonStyle(index >= groups.length - 1, true)}>次の人 ▶</button>
        <button onClick={() => void copyMinutes()} title="メモ・追加したタスク・時間をまとめてコピーします" style={navButtonStyle(false)}>議事録をコピー</button>
        <button onClick={close} title="定例モードを閉じます（Esc）。進み具合は残ります" style={navButtonStyle(false)}>閉じる</button>
      </div>

      {group ? (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 340px)', gap: 0 }}>
          <div style={{ overflowY: 'auto', padding: '16px 20px 40px' }}>
            <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {renderBody(group.key)}
            </div>
          </div>
          <aside style={{ borderLeft: '1px solid var(--slate-800)', background: 'var(--slate-900)', padding: 16, display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
            {onCreateTask && (
              <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--slate-200)' }}>決まったことをタスクにする</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--slate-400)' }}>{createTaskHint(group.key)}・開始日は今日</div>
                <div role="group" aria-label="期限" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.72rem', color: 'var(--slate-400)' }}>期限</span>
                  {dueChoices.map((choice) => (
                    <button
                      key={choice.label}
                      type="button"
                      aria-pressed={taskDue === choice.value}
                      onClick={() => setTaskDue(choice.value)}
                      style={{ padding: '3px 9px', borderRadius: 999, border: `1px solid ${taskDue === choice.value ? 'var(--blue-500)' : 'var(--slate-700)'}`, background: taskDue === choice.value ? 'var(--blue-950)' : 'transparent', color: taskDue === choice.value ? 'var(--blue-100)' : 'var(--slate-300)', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700 }}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    value={taskTitle}
                    onChange={(event) => setTaskTitle(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void createTask() } }}
                    aria-label="決まったこと（タスク名）"
                    placeholder="例: 見積書を再提出する"
                    style={{ flex: 1, minWidth: 0, padding: '7px 9px', borderRadius: 7, border: '1px solid var(--slate-700)', background: 'var(--c-0b1220)', color: 'var(--slate-200)', fontSize: '0.82rem' }}
                  />
                  <button onClick={() => void createTask()} disabled={!taskTitle.trim() || creatingTask} style={navButtonStyle(!taskTitle.trim() || creatingTask, true)}>
                    {creatingTask ? '追加中…' : '追加'}
                  </button>
                </div>
                {(state.createdTasks[group.key] ?? []).length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.8rem', color: 'var(--slate-300)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {(state.createdTasks[group.key] ?? []).map((title, taskIndex) => <li key={`${title}-${taskIndex}`}>{title}</li>)}
                  </ul>
                )}
              </section>
            )}
            <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--slate-200)' }}>定例メモ</div>
              <textarea
                value={state.notes[group.key] ?? ''}
                onChange={(event) => {
                  const value = event.target.value
                  onStateChange((previous) => ({ ...previous, notes: { ...previous.notes, [group.key]: value } }))
                }}
                aria-label={`${group.label}の定例メモ`}
                rows={8}
                placeholder="話したこと・決まったこと"
                style={{ padding: '8px 10px', borderRadius: 7, border: '1px solid var(--slate-700)', background: 'var(--c-0b1220)', color: 'var(--slate-200)', fontSize: '0.82rem', lineHeight: 1.6, resize: 'vertical' }}
              />
              <div style={{ fontSize: '0.75rem', color: 'var(--slate-400)', lineHeight: 1.6 }}>
                このメモはこの端末に12時間残ります（ほかの画面へ移っても、読み込み直しても消えません）。議事録として残す場合は、上の「議事録をコピー」でコピーしてください。
              </div>
            </section>
            <section style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--slate-200)' }}>順番</div>
              {groups.map((item, itemIndex) => {
                const seconds = itemIndex === index ? personSeconds : state.spentSeconds[item.key] ?? 0
                return (
                  <button
                    key={item.key}
                    onClick={() => goTo(itemIndex)}
                    aria-current={itemIndex === index ? 'true' : undefined}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, border: 'none', background: itemIndex === index ? 'var(--slate-800)' : 'transparent', color: 'var(--slate-200)', cursor: 'pointer', fontSize: '0.8rem', textAlign: 'left' }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: item.color ?? 'var(--slate-600)', flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                    <span style={{ color: 'var(--slate-400)', fontVariantNumeric: 'tabular-nums' }}>{seconds >= 1 ? formatDuration(seconds) : ''}</span>
                  </button>
                )
              })}
            </section>
          </aside>
        </div>
      ) : (
        <div style={{ padding: 40, color: 'var(--slate-400)' }}>表示できる担当者がいません。報告タブの絞り込みを確かめてください。</div>
      )}
    </div>
  )
}

function navButtonStyle(disabled: boolean, primary = false): React.CSSProperties {
  return {
    padding: '7px 12px',
    borderRadius: 8,
    border: `1px solid ${primary && !disabled ? 'var(--blue-600)' : 'var(--slate-700)'}`,
    background: primary && !disabled ? 'var(--blue-700)' : 'transparent',
    // 青い塗りの上の文字は、ライトでも明るいまま（--on-fill-*）
    color: disabled ? 'var(--slate-500)' : primary ? 'var(--on-fill-slate-200)' : 'var(--slate-200)',
    cursor: disabled ? 'default' : 'pointer',
    fontSize: '0.8rem',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}
