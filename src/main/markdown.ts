import { clipboard, dialog } from 'electron'
import fs from 'fs'
import { getTodayWorkLogs, getSetting } from './db'
import type { TodayWorkLog } from './db'

function applyTemplate(tpl: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (s, [k, v]) => s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v),
    tpl
  )
}

export function generateDailyMarkdown(): string {
  const logs = getTodayWorkLogs()
  if (logs.length === 0) {
    return '# 本日の作業ログ\n\nログがありません。\n'
  }

  const today = new Date()
  const dateStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`

  // テンプレート読み込み
  const headerTpl = getSetting('mdHeaderTpl') ?? '# 作業ログ - {{date}}'
  const taskTpl = getSetting('mdTaskTpl') ?? '## {{title}}{{category}}\n\n**合計: {{task_min}}分**'
  const entryTpl = getSetting('mdEntryTpl') ?? '- {{start}} ～ {{end}} ({{min}}分){{note}}'
  const footerTpl = getSetting('mdFooterTpl') ?? '**本日合計: {{total_min}}分**'

  // タスクごとにグループ化
  const grouped = new Map<string, { title: string; category: string | null; logs: TodayWorkLog[] }>()
  for (const log of logs) {
    if (!grouped.has(log.todo_id)) {
      grouped.set(log.todo_id, { title: log.title, category: log.category, logs: [] })
    }
    grouped.get(log.todo_id)!.logs.push(log)
  }

  let md = applyTemplate(headerTpl, { date: dateStr }) + '\n\n'

  for (const [, group] of grouped) {
    const totalSeconds = group.logs.reduce((sum, l) => sum + l.duration_seconds, 0)
    const totalMinutes = Math.round(totalSeconds / 60)

    const categoryLabel = group.category ? ` \`${group.category}\`` : ''
    md += applyTemplate(taskTpl, {
      title: group.title,
      category: categoryLabel,
      task_min: String(totalMinutes)
    }) + '\n\n'

    for (const log of group.logs) {
      const start = formatTime(new Date(log.start_time))
      const end = formatTime(new Date(log.end_time))
      const mins = Math.round(log.duration_seconds / 60)
      const noteStr = log.note ? ` — ${log.note}` : ''
      md += applyTemplate(entryTpl, {
        start, end, min: String(mins), note: noteStr
      }) + '\n'
    }
    md += '\n'
  }

  // サマリー
  const totalAll = logs.reduce((sum, l) => sum + l.duration_seconds, 0)
  md += `---\n` + applyTemplate(footerTpl, { total_min: String(Math.round(totalAll / 60)) }) + '\n'

  return md
}

function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export async function exportMarkdown(
  mode: 'clipboard' | 'file'
): Promise<{ success: boolean; message: string }> {
  const md = generateDailyMarkdown()

  if (mode === 'clipboard') {
    clipboard.writeText(md)
    return { success: true, message: 'クリップボードにコピーしました' }
  }

  const today = new Date()
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  const result = await dialog.showSaveDialog({
    defaultPath: `worklog-${dateStr}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })

  if (result.canceled || !result.filePath) {
    return { success: false, message: 'キャンセルされました' }
  }

  fs.writeFileSync(result.filePath, md, 'utf-8')
  return { success: true, message: `保存しました: ${result.filePath}` }
}
