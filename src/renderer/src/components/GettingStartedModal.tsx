import React, { useEffect, useRef } from 'react'
import { useDialogFocus } from '../hooks/useDialogFocus'

interface Props {
  /** チームで使っている（サーバー版）か。報告タブの説明を変える */
  multiUser: boolean
  onOpenReport: () => void
  onClose: () => void
}

// はじめて使う人への案内。毎日することを3つの手順にまとめ、上部のタブの名前を一言で説明する。
// 初めて開いたときに知らせから開けるほか、右上のメニュー・Ctrl+K からいつでも開ける
export function GettingStartedModal({ multiUser, onOpenReport, onClose }: Props): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const steps: Array<{ title: string; body: string }> = [
    {
      title: '自分のタスクを見る',
      body: multiUser
        ? '左の一覧は「担当: 自分」で絞ってあります。タスク名を押すと、詳しい内容が開きます。新しいタスクは左上の「＋ タスクを追加」から作れます。'
        : '左の一覧にタスクが並びます。タスク名を押すと、詳しい内容が開きます。新しいタスクは左上の「＋ タスクを追加」から作れます。'
    },
    {
      title: '進み具合を書く',
      body: 'タスクを開いて、進捗のバーを動かします（自動で保存されます）。「✎ 進捗ログを書く」を押して、今日やったことを一言残します。間違えたときは、下に出る知らせの「元に戻す」で戻せます。'
    },
    {
      title: multiUser ? '定例の前に報告を確かめる' : '週の終わりに振り返る',
      body: multiUser
        ? '上の「報告」タブで、自分の報告が済んでいるかを確かめます。まだのタスクがあるときは黄色の知らせが、済んでいるときは緑の知らせが出ます。'
        : '上の「報告」タブで、期間中の進捗ログや変化をまとめて見られます。'
    }
  ]
  const tabs: Array<[string, string]> = [
    ['ガント', '日程を横の棒で見る（開始日から期限まで）'],
    ['カンバン', '「未着手・進行中・保留中・完了」の列にカードを並べる'],
    ...(multiUser ? [['チーム', 'メンバーごとの遅れ・報告なし・期限'] as [string, string]] : []),
    ['進捗', 'みんなの進捗ログを新しい順に読む・返信する'],
    ['報告', '定例で見る画面。タスクごとの進み具合と報告をまとめて見る'],
    ['計画', '今日の時間割を作る'],
    ['ToDo', '毎日・毎週のチェックリスト'],
    ['記録', '計った作業時間を見る']
  ]

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'color-mix(in srgb, var(--slate-950) 60%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onMouseDown={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="getting-started-title"
        onMouseDown={(event) => event.stopPropagation()}
        style={{ width: 'min(36rem, calc(100vw - 32px))', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', background: 'var(--slate-800)', border: '1px solid var(--slate-700)', borderRadius: 14, padding: '20px 24px', boxShadow: '0 24px 64px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <h2 id="getting-started-title" style={{ margin: 0, fontSize: '1.1rem', color: 'var(--slate-100)' }}>はじめに: 毎日することは3つです</h2>
          <button onClick={onClose} aria-label="閉じる" title="閉じる（Esc）" style={{ minWidth: '1.9rem', minHeight: '1.9rem', border: '1px solid var(--slate-700)', borderRadius: 8, background: 'transparent', color: 'var(--slate-300)', cursor: 'pointer', fontSize: '1rem' }}>×</button>
        </div>

        <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {steps.map((step, index) => (
            <li key={step.title} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span aria-hidden="true" style={{ flexShrink: 0, width: '1.8rem', height: '1.8rem', borderRadius: '50%', background: 'var(--blue-700)', color: 'var(--on-fill-blue-50)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 }}>{index + 1}</span>
              <div>
                <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--slate-100)' }}>{step.title}</div>
                <div style={{ marginTop: 4, fontSize: '0.84rem', color: 'var(--slate-300)', lineHeight: 1.7 }}>{step.body}</div>
              </div>
            </li>
          ))}
        </ol>

        <section aria-labelledby="getting-started-tabs" style={{ borderTop: '1px solid var(--slate-700)', paddingTop: 12 }}>
          <h3 id="getting-started-tabs" style={{ margin: '0 0 8px', fontSize: '0.84rem', color: 'var(--slate-300)' }}>上のタブの使いみち</h3>
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', fontSize: '0.8rem' }}>
            {tabs.map(([name, description]) => (
              <React.Fragment key={name}>
                <dt style={{ color: 'var(--slate-100)', fontWeight: 700 }}>{name}</dt>
                <dd style={{ margin: 0, color: 'var(--slate-400)' }}>{description}</dd>
              </React.Fragment>
            ))}
          </dl>
        </section>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.74rem', color: 'var(--text-subtle)' }}>この案内は、右上のメニューの「使い方」からいつでも開けます</span>
          <button onClick={() => { onOpenReport(); onClose() }} style={{ marginLeft: 'auto', padding: '7px 12px', borderRadius: 8, border: '1px solid var(--slate-600)', background: 'var(--slate-700)', color: 'var(--slate-100)', cursor: 'pointer', fontWeight: 700 }}>報告タブを開く</button>
          <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--blue-600)', background: 'var(--blue-700)', color: 'var(--on-fill-blue-50)', cursor: 'pointer', fontWeight: 700 }}>はじめる</button>
        </div>
      </div>
    </div>
  )
}
