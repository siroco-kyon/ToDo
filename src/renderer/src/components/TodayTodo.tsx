import React, { useState } from 'react'
import type { SubTask } from '../types'
import { toDateKey } from '../lib/dueDate'
import { TODAY_SECTION_LABEL, buildTodaySections, countRemaining, type TodayListGroup } from '../lib/todoList'
import { QuickCheckItem } from './TodoChecklist'

// 「今日やること」: 自分の ToDoリストの、繰り返しの項目と期限が今日までのやることを、リストごとに並べてその場でチェックする。
// ToDo タブと、右の「今日の予定」パネルの両方で使う。ToDoリストを使っていない人には出さない。

interface ItemsProps {
  groups: TodayListGroup[]
  pendingIds: Set<string>
  onToggle: (item: SubTask) => void
  onOpenList: (todoId: string) => void
  /** 項目の担当者名を出す（全員のリストを見ているとき） */
  showAssignee?: boolean
}

export function TodayTodoItems({ groups, pendingIds, onToggle, onOpenList, showAssignee = false }: ItemsProps): React.JSX.Element {
  const todayKey = toDateKey(new Date())
  if (groups.length === 0) {
    return <div style={{ fontSize: '0.78rem', color: '#64748b', lineHeight: 1.5 }}>今日やる項目はありません。</div>
  }
  // リストが一つだけなら、項目ごとのリスト名は出さない
  const showListName = groups.length > 1
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {buildTodaySections(groups).map(({ section, entries }) => {
        const done = entries.filter(({ item }) => item.done).length
        return (
          <div key={section} style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
            <div title={TODAY_SECTION_LABEL[section].title} style={{ display: 'flex', alignItems: 'baseline', gap: 6, paddingBottom: 2 }}>
              <span style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 700 }}>{TODAY_SECTION_LABEL[section].label}</span>
              <span style={{ fontSize: '0.66rem', color: done === entries.length ? '#4ade80' : '#64748b' }}>{done}/{entries.length}</span>
            </div>
            {entries.map(({ item, todo }) => (
              <QuickCheckItem
                key={item.id}
                item={item}
                pending={pendingIds.has(item.id)}
                todayKey={todayKey}
                listTitle={todo.title}
                listName={showListName ? todo.title : undefined}
                listColor={todo.category_color}
                showAssignee={showAssignee}
                onToggle={() => onToggle(item)}
                onOpen={() => onOpenList(todo.id)}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}

function readCollapsed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

/** 右の「今日の予定」パネルに置く、畳める「今日のToDo」 */
export function TodayTodoCard({ groups, pendingIds, storageKey, onToggle, onOpenList, onOpenTab }: Omit<ItemsProps, 'showAssignee'> & {
  /** 畳んだ状態の保存キー（ユーザーごと） */
  storageKey: string
  onOpenTab: () => void
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(storageKey))
  const remaining = countRemaining(groups)
  const toggleCollapsed = (): void => {
    setCollapsed((previous) => {
      try {
        window.localStorage.setItem(storageKey, previous ? '0' : '1')
      } catch {
        // 保存できなくても開閉はできる
      }
      return !previous
    })
  }
  return (
    <section aria-label="今日のToDo" style={{ background: '#0f172a', border: '1px solid #312e81', borderRadius: 12, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? '開く' : '畳む'}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#94a3b8', fontSize: '0.75rem', transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s ease' }}
        >
          ▾
        </button>
        <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#e0e7ff' }}>今日のToDo</span>
        <span style={{ fontSize: '0.7rem', color: remaining > 0 ? '#c7d2fe' : '#4ade80' }}>{remaining > 0 ? `残り ${remaining}` : 'すべて済み'}</span>
        <button onClick={onOpenTab} title="ToDo タブを開く" style={{ marginLeft: 'auto', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#93c5fd', fontSize: '0.7rem', fontWeight: 700 }}>
          ToDoタブ
        </button>
      </div>
      {!collapsed && (
        <div style={{ marginTop: 8 }}>
          <TodayTodoItems groups={groups} pendingIds={pendingIds} onToggle={onToggle} onOpenList={onOpenList} />
        </div>
      )}
    </section>
  )
}
