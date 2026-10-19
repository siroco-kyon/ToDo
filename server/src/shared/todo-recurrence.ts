// タスクの繰り返し（完了にすると次回分を作る）の種類と、次回の日付の計算。サーバー版とデスクトップ版の両方で使う。
// 次回の日付は、完了した日ではなく前回の開始日・期限から1周期ずらす。
// 毎月・毎年は、その月にない日を末日に丸める（1/31 の次の月は 2/28、2/29 の次の年は平年なら 2/28）。
// 画面側（src/renderer/src/lib/recurrence.ts）にも同じ計算があり、tests/recurrence-dates.cjs で一致を確かめている。

export type TodoRecurrence = 'daily' | 'weekly' | 'monthly' | 'yearly'

export const TODO_RECURRENCES: readonly TodoRecurrence[] = ['daily', 'weekly', 'monthly', 'yearly']

export function isTodoRecurrence(value: unknown): value is TodoRecurrence {
  return typeof value === 'string' && (TODO_RECURRENCES as readonly string[]).includes(value)
}

/**
 * 保存する前に繰り返しの値を確かめる。null・undefined・空文字は「なし」（null）。
 * 知らない値はエラーにする（画面の選択肢と DB の制約にない値を保存しない）
 */
export function normalizeTodoRecurrence(value: unknown): TodoRecurrence | null {
  if (value === null || value === undefined || value === '') return null
  if (isTodoRecurrence(value)) return value
  throw new Error('繰り返しの指定が正しくありません。毎日・毎週・毎月・毎年・なしから選んでください')
}

function toKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** 日付（YYYY-MM-DD）を繰り返しの1周期ぶんずらす */
export function nextRecurrenceDateKey(dateKey: string, recurrence: TodoRecurrence): string {
  const [year, month, day] = dateKey.slice(0, 10).split('-').map(Number)
  if (recurrence === 'daily' || recurrence === 'weekly') {
    const date = new Date(Date.UTC(year, month - 1, day + (recurrence === 'daily' ? 1 : 7)))
    return toKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
  }
  const targetYear = recurrence === 'yearly' ? year + 1 : year + Math.floor(month / 12)
  const targetMonth = recurrence === 'yearly' ? month : (month % 12) + 1
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate()
  return toKey(targetYear, targetMonth, Math.min(day, lastDay))
}

/**
 * 繰り返しの値の DB 制約。古い DB にも付けられるよう、表を作り直さずトリガーで確かめる。
 * 選択肢が増えたときに合わせられるよう、起動のたびに今の選択肢で作り直す。
 * 既にある行の値は変えない（繰り返しを書き換えるときだけ確かめる）
 */
export function installTodoRecurrenceConstraint(db: { exec(sql: string): unknown }): void {
  const allowed = TODO_RECURRENCES.map((value) => `'${value}'`).join(', ')
  const check = `WHEN NEW.recurrence IS NOT NULL AND NEW.recurrence NOT IN (${allowed})
    BEGIN SELECT RAISE(ABORT, '繰り返しの指定が正しくありません'); END`
  db.exec(`
    DROP TRIGGER IF EXISTS todos_recurrence_insert_check;
    DROP TRIGGER IF EXISTS todos_recurrence_update_check;
    CREATE TRIGGER todos_recurrence_insert_check BEFORE INSERT ON Todos ${check};
    CREATE TRIGGER todos_recurrence_update_check BEFORE UPDATE OF recurrence ON Todos ${check};
  `)
}
