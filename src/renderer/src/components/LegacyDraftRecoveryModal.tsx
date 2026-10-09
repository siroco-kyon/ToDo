import React, { useEffect, useState } from 'react'
import type { PublicUser } from '../types'
import { copyTextToClipboard } from '../lib/clipboard'
import {
  announceProgressDraftChanges,
  legacyDraftAvailability,
  legacyDraftTargetKey,
  listLegacyProgressDrafts,
  restoreLegacyProgressDrafts,
  type LegacyProgressDraft
} from '../lib/legacyProgressDrafts'

interface Props {
  onClose: () => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
}

export function LegacyDraftRecoveryModal({ onClose, onShowToast }: Props): React.JSX.Element {
  const [user, setUser] = useState<PublicUser | null>(null)
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<LegacyProgressDraft[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [confirmedOwner, setConfirmedOwner] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoredCount, setRestoredCount] = useState(0)

  useEffect(() => {
    let disposed = false
    void Promise.all([window.api.authGetCurrentUser(), window.api.todoGetAll()]).then(([currentUser, todos]) => {
      if (disposed) return
      if (!currentUser) throw new Error('ログイン中のアカウントを確認できませんでした')
      setUser(currentUser)
      setTitles(Object.fromEntries(todos.map((todo) => [todo.id, todo.title])))
      setDrafts(listLegacyProgressDrafts(window.localStorage))
    }).catch((reason) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : '下書きを確認できませんでした')
    }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!restoring) onClose()
    }
    window.addEventListener('keydown', onEscape, true)
    return () => window.removeEventListener('keydown', onEscape, true)
  }, [onClose, restoring])

  const selected = drafts.filter((draft) => selectedIds.has(draft.id))
  const restore = async (): Promise<void> => {
    if (!user || !confirmedOwner || !selected.length || restoring) return
    setRestoring(true)
    setError('')
    try {
      const currentUser = await window.api.authGetCurrentUser()
      if (currentUser?.id !== user.id) throw new Error('ログイン中のアカウントが変わりました。画面を閉じて開き直してください')
      const result = restoreLegacyProgressDrafts(window.localStorage, selected, user.id)
      setRestoredCount((count) => count + result.restored.length)
      setSelectedIds(new Set())
      setConfirmedOwner(false)
      setDrafts(listLegacyProgressDrafts(window.localStorage))
      if (result.restored.length) onShowToast(`${result.restored.length}件の下書きを復元しました。内容を確認してから投稿してください`)
      if (result.skipped.length) setError('一部の下書きは別の画面で変更済み、または現在の下書きがあるため復元しませんでした')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '下書きを復元できませんでした')
      setDrafts(listLegacyProgressDrafts(window.localStorage))
    } finally {
      // Refresh even if a storage failure occurred after a destination was saved.
      announceProgressDraftChanges(selected.map((draft) => legacyDraftTargetKey(draft, user.id)))
      setRestoring(false)
    }
  }

  const copy = async (body: string): Promise<void> => {
    try { await copyTextToClipboard(body); onShowToast('下書きの内容をコピーしました') }
    catch { onShowToast('下書きをコピーできませんでした', 'error') }
  }

  return <div style={backdrop} onClick={(event) => { if (event.target === event.currentTarget && !restoring) onClose() }}>
    <div role="dialog" aria-modal="true" aria-label="旧版の下書きを復元" style={panel}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h2 style={{ fontSize: '1.1rem', margin: 0 }}>旧版の下書きを復元</h2>
        <button type="button" aria-label="閉じる" disabled={restoring} onClick={onClose} style={button}>閉じる</button>
      </header>
      <p style={text}>更新前にこのPCで保存された、未投稿の進捗やコメントを確認できます。誰が書いたものか判別できないため、自分の下書きだけを選んで復元してください。</p>
      {user && <p style={text}>復元先のアカウント: <strong style={{ color: '#e2e8f0' }}>{user.display_name || user.username}</strong></p>}
      {loading ? <p style={text}>下書きを確認しています…</p> : <>
        {drafts.length === 0 ? <p role="status" style={text}>{restoredCount ? '選択した下書きを復元しました。残っている旧版の下書きはありません。' : 'このPCには旧版の下書きがありません。'}</p> : <>
          {!reviewing ? <button type="button" onClick={() => setReviewing(true)} style={primary}>下書きの内容を確認する（{drafts.length}件）</button> : <>
            <p style={text}>選択して復元すると、今のアカウントの下書きへ移します。投稿は行いません。現在の下書きは上書きしません。</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {drafts.map((draft) => {
                const availability = user ? legacyDraftAvailability(window.localStorage, draft, user.id) : 'conflict'
                const missingTask = Boolean(draft.todoId && !(draft.todoId in titles))
                const disabled = availability !== 'available' || missingTask || !user || restoring
                const label = draft.kind === 'detail' ? 'タスク詳細の進捗' : draft.kind === 'timeline-note' ? 'タイムラインの進捗' : draft.entryKey?.startsWith('reply:') ? 'コメントへの返信' : '進捗へのコメント'
                return <article key={draft.id} style={{ padding: 14, border: '1px solid #334155', borderRadius: 8, background: '#0f172a' }}>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, color: '#e2e8f0', fontSize: '0.85rem' }}>
                    <input type="checkbox" aria-label={`${label}を復元する`} checked={selectedIds.has(draft.id)} disabled={disabled} onChange={(event) => {
                      setSelectedIds((ids) => { const next = new Set(ids); if (event.target.checked) next.add(draft.id); else next.delete(draft.id); return next })
                    }} />
                    <span>{label}{draft.todoId && <><br/><strong>{titles[draft.todoId] ?? '削除された、またはアクセスできないタスク'}</strong></>}</span>
                  </label>
                  <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '12px 0', fontFamily: 'inherit', fontSize: '0.85rem', color: '#cbd5e1' }}>{draft.body}</pre>
                  {availability === 'same' && <p style={text}>同じ内容の下書きがあります。重複して復元しません。</p>}
                  {availability === 'conflict' && <p style={text}>現在の下書きがあります。内容をコピーして、必要な部分を手動で追記できます。</p>}
                  {missingTask && <p style={text}>このタスクは現在開けないため、内容のコピーだけ利用できます。</p>}
                  <button type="button" onClick={() => void copy(draft.body)} style={button}>内容をコピー</button>
                </article>
              })}
            </div>
            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', ...text }}>
              <input type="checkbox" checked={confirmedOwner} disabled={restoring} onChange={(event) => setConfirmedOwner(event.target.checked)} />
              選んだ下書きは自分が作成したものです。今のアカウントの下書きとして復元します。
            </label>
            <button type="button" disabled={!selected.length || !confirmedOwner || restoring || !user} onClick={() => void restore()} style={{ ...primary, opacity: !selected.length || !confirmedOwner || restoring || !user ? 0.5 : 1 }}>{restoring ? '復元しています…' : `選択した${selected.length}件を復元`}</button>
          </>}
        </>}
      </>}
      {error && <p role="alert" style={{ ...text, color: '#fca5a5' }}>{error}</p>}
    </div>
  </div>
}

const backdrop: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18, boxSizing: 'border-box' }
const panel: React.CSSProperties = { width: 620, maxWidth: '100%', maxHeight: '85vh', overflowY: 'auto', background: '#1e293b', color: '#e2e8f0', padding: 24, borderRadius: 14, border: '1px solid #475569', display: 'flex', flexDirection: 'column', gap: 14, boxSizing: 'border-box' }
const text: React.CSSProperties = { margin: 0, color: '#94a3b8', fontSize: '0.8rem', lineHeight: 1.6 }
const button: React.CSSProperties = { padding: '7px 12px', color: '#cbd5e1', background: '#334155', border: 0, borderRadius: 6, cursor: 'pointer', fontSize: '0.8rem' }
const primary: React.CSSProperties = { ...button, color: '#fff', background: '#0f766e', padding: '10px 14px', alignSelf: 'flex-start' }
