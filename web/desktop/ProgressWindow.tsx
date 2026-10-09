import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCurrentUser } from '../auth/UserContext'
import { copyTextToClipboard } from '@renderer/lib/clipboard'
import { HttpError, postQuickProgress, type QuickProgressRequest } from '../lib/client'
import { elapsedTime, useDesktopContext, useDesktopTask } from './useDesktopTask'
import { listProgressDrafts, progressDraftKey, readProgressDraft, transferProgressDraft, writeProgressDraft, type ProgressDraft } from './progressDrafts'
import { subscribeProgressTarget } from './progressTarget'
import './desktop.css'

function newRequestId(): string {
  // randomUUID requires HTTPS; LAN servers can be HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function ProgressWindow(): React.JSX.Element {
  const { user } = useCurrentUser()
  const context = useDesktopContext()
  const { todos, running, connected, loading, error, now, refresh } = useDesktopTask()
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('todo') ?? '')
  const selectedRef = useRef(selectedId)
  const draftRef = useRef<ProgressDraft>(readProgressDraft(localStorage, user.id, selectedId))
  const [body, setBody] = useState(draftRef.current.body)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const queuedTarget = useRef<string | null>(null)
  const active = useRef(true)
  const [message, setMessage] = useState(draftRef.current.lastError ?? '')
  const [failed, setFailed] = useState(Boolean(draftRef.current.lastError))
  const [savedDrafts, setSavedDrafts] = useState(() => listProgressDrafts(localStorage, user.id))
  const [showDrafts, setShowDrafts] = useState(false)
  const [showTransfer, setShowTransfer] = useState(false)
  const [transferTo, setTransferTo] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const reloadDrafts = useCallback(() => setSavedDrafts(listProgressDrafts(localStorage, user.id)), [user.id])
  const applyTarget = useCallback((todoId: string): void => {
    if (todoId === selectedRef.current) { textareaRef.current?.focus(); return }
    selectedRef.current = todoId
    const draft = readProgressDraft(localStorage, user.id, todoId)
    draftRef.current = draft
    setSelectedId(todoId)
    setBody(draft.body)
    setMessage(draft.lastError ?? '')
    setFailed(Boolean(draft.lastError))
    setShowTransfer(false)
    setTransferTo('')
    textareaRef.current?.focus()
    reloadDrafts()
  }, [user.id, reloadDrafts])
  const selectTarget = useCallback((todoId: string): void => {
    if (pendingRef.current) { queuedTarget.current = todoId; return }
    if (draftRef.current.attempt && todoId !== selectedRef.current) {
      setMessage('送信結果が未確認です。同じ投稿を再試行して結果を確認してから、別のタスクを開いてください')
      setFailed(true)
      return
    }
    applyTarget(todoId)
  }, [applyTarget])
  useEffect(() => subscribeProgressTarget(selectTarget), [selectTarget])
  useEffect(() => {
    active.current = true
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key.startsWith(progressDraftKey(user.id, ''))) reloadDrafts()
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', reloadDrafts)
    return () => {
      active.current = false
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', reloadDrafts)
    }
  }, [user.id, reloadDrafts])
  const available = useMemo(() => [...todos].filter((todo) => todo.status !== 'archived' || todo.id === selectedId || todo.id === running?.todo_id).sort((a, b) => {
    const rank = (id: string, assigned: boolean): number => id === running?.todo_id ? 0 : assigned ? 1 : 2
    const mine = (todo: typeof a): boolean => todo.assignee_id === user.id || Boolean(todo.co_assignees?.some((item) => item.user_id === user.id))
    return rank(a.id, mine(a)) - rank(b.id, mine(b)) || b.updated_at.localeCompare(a.updated_at)
  }), [todos, selectedId, running?.todo_id, user.id])
  useEffect(() => {
    // Once a task is selected, refreshes must never replace its draft or error.
    if (!loading && !selectedRef.current && !draftRef.current.body && !pendingRef.current) {
      const initial = available.find((todo) => todo.id === running?.todo_id)?.id ?? available[0]?.id
      if (initial) applyTarget(initial)
    }
  }, [loading, available, running?.todo_id, applyTarget])

  const task = todos.find((todo) => todo.id === selectedId)
  const missingTask = Boolean(selectedId && !loading && !task)
  const canRetry = Boolean(draftRef.current.attempt)
  const canSubmit = Boolean(selectedId && body.trim() && connected && !pending && (task || canRetry))
  const canStop = canSubmit && running?.todo_id === selectedId
  const saveDraft = (todoId: string, draft: ProgressDraft): void => {
    writeProgressDraft(localStorage, user.id, todoId, draft)
    if (selectedRef.current === todoId) draftRef.current = draft
    if (active.current) reloadDrafts()
  }
  const editBody = (value: string): void => {
    if (pendingRef.current || draftRef.current.attempt) return
    setBody(value)
    const draft = { body: value, taskTitle: task?.title ?? draftRef.current.taskTitle, updatedAt: new Date().toISOString() }
    draftRef.current = draft
    try { saveDraft(selectedRef.current, draft) }
    catch { setMessage('このPCに下書きを保存できません'); setFailed(true) }
  }
  const submit = async (stopTimer: boolean): Promise<void> => {
    const todoId = selectedRef.current
    const currentDraft = draftRef.current
    if (pendingRef.current || !todoId || !currentDraft.body.trim() || !connected) return
    pendingRef.current = true
    setPending(true)
    setMessage('')
    setFailed(false)
    const attempt: QuickProgressRequest = currentDraft.attempt ?? {
      requestId: newRequestId(), expectedUserId: user.id, todoId, body: currentDraft.body,
      stopTimer, expectedStartTime: stopTimer ? running?.start_time : null
    }
    const attemptedDraft = { ...currentDraft, attempt, lastError: undefined, taskTitle: task?.title ?? currentDraft.taskTitle, updatedAt: new Date().toISOString() }
    let sent = false
    try {
      saveDraft(todoId, attemptedDraft)
      sent = true
      await postQuickProgress(attempt)
      localStorage.removeItem(progressDraftKey(user.id, todoId))
      if (active.current && selectedRef.current === todoId) {
        draftRef.current = { body: '' }
        setBody('')
        setMessage(attempt.stopTimer ? '進捗を投稿して計測を停止しました' : '進捗を投稿しました')
      }
    } catch (err) {
      const failure = err instanceof Error ? err.message : '投稿できませんでした。下書きは残っています'
      const definite = !sent || (err instanceof HttpError && err.status >= 400 && err.status < 500)
      const retained: ProgressDraft = { ...attemptedDraft, attempt: definite ? undefined : attempt, lastError: failure }
      if (selectedRef.current === todoId) draftRef.current = retained
      try { saveDraft(todoId, retained) } catch { /* The in-memory draft remains available for copying. */ }
      if (active.current && selectedRef.current === todoId) { setMessage(failure); setFailed(true) }
    } finally {
      pendingRef.current = false
      if (active.current) {
        setPending(false)
        reloadDrafts()
        const nextTarget = queuedTarget.current
        queuedTarget.current = null
        if (nextTarget) selectTarget(nextTarget)
        textareaRef.current?.focus()
        // Updating the display cannot hold posting, closing, or draft recovery hostage.
        void refresh()
      }
    }
  }
  const copyBody = async (): Promise<void> => {
    try { await copyTextToClipboard(body); setMessage('下書きをコピーしました'); setFailed(false) }
    catch (err) { setMessage(err instanceof Error ? err.message : 'コピーできませんでした'); setFailed(true) }
    finally { textareaRef.current?.focus() }
  }
  const moveDraft = (): void => {
    if (pendingRef.current || draftRef.current.attempt || !transferTo) return
    try {
      saveDraft(selectedId, draftRef.current)
      transferProgressDraft(localStorage, user.id, selectedId, transferTo)
      applyTarget(transferTo)
      setMessage('下書きを移しました。内容を確認してから投稿してください')
      setFailed(false)
    } catch (err) { setMessage(err instanceof Error ? err.message : '下書きを移せませんでした'); setFailed(true) }
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !pendingRef.current && !event.isComposing) void window.desktop?.hideWindow()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const destination = transferTo ? readProgressDraft(localStorage, user.id, transferTo) : null
  return <div className="hakobi-desktop progress-window">
    <header><span className="brand">HAKOBI <span className="group">{context?.groupName}</span></span>
      <button aria-label="閉じる" disabled={pending} onClick={() => void window.desktop?.hideWindow()}>×</button></header>
    <h1>進捗をひとこと</h1>
    <p className="hint">{user.display_name} として投稿 · 下書きはこのPCに保存</p>
    <div className="draft-tools"><button aria-expanded={showDrafts} aria-controls="quick-progress-drafts" onClick={() => { reloadDrafts(); setShowDrafts(!showDrafts) }}>保存した下書き（{savedDrafts.length}）</button>
      <button disabled={!body || pending} onClick={() => void copyBody()}>本文をコピー</button></div>
    {showDrafts && <section id="quick-progress-drafts" className="draft-list" aria-label="自分の保存した下書き">
      {!savedDrafts.length ? <p>この接続先に保存した下書きはありません。</p> : <ul>{savedDrafts.map(({ todoId, draft }) => {
        const savedTask = todos.find((todo) => todo.id === todoId)
        const title = savedTask?.title ?? draft.taskTitle ?? (todoId ? '削除されたタスク' : 'タスク未選択')
        return <li key={todoId}><button data-draft-task={todoId} disabled={pending} onClick={() => selectTarget(todoId)}><strong>{title}</strong>
          <span>{draft.attempt ? '送信結果が未確認' : savedTask?.status === 'archived' ? 'アーカイブ済み · 下書き' : !savedTask && !loading ? '投稿先なし · 下書き' : '下書き'}</span>
          <small>{draft.body.slice(0, 75)}</small></button></li>
      })}</ul>}
    </section>}
    <label htmlFor="quick-progress-task">タスク</label>
    <select id="quick-progress-task" value={selectedId} disabled={pending || loading} onChange={(event) => selectTarget(event.target.value)}>
      {!selectedId && <option value="">タスクを選択</option>}
      {selectedId && !available.some((todo) => todo.id === selectedId) && <option value={selectedId}>{draftRef.current.taskTitle ?? '前回の投稿先'}（削除済み・確認待ち）</option>}
      {available.map((todo) => <option key={todo.id} value={todo.id}>{todo.id === running?.todo_id ? '▶ ' : ''}{todo.title}{todo.assignee_id === user.id ? '（自分の担当）' : ''}{todo.status === 'archived' ? '（アーカイブ済み）' : ''}</option>)}
    </select>
    {(missingTask || task?.status === 'archived') && <p className="draft-warning">{missingTask ? 'このタスクは見つかりません。本文は残っています。コピーするか、送信結果を確認した後で別のタスクへ移せます。' : 'このタスクはアーカイブ済みです。下書きはそのまま残っています。'}</p>}
    {canRetry && <p className="draft-warning">送信結果が未確認です。同じ投稿を再試行して結果を確認してください。本文と投稿先は変更されません。</p>}
    <label htmlFor="quick-progress-body">進んだこと・困っていること</label>
    <textarea ref={textareaRef} id="quick-progress-body" value={body} maxLength={10000} disabled={pending} readOnly={canRetry}
      placeholder="例: 画面の修正が終わりました。明日は動作確認を進めます。" onChange={(event) => editBody(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSubmit) void submit(false) } }} />
    <div className="submission-info"><span>{running?.todo_id === selectedId ? `計測中 ${elapsedTime(running.start_time, now)}` : '投稿だけでもOK'}</span><span>Ctrl + Enter で投稿</span></div>
    <div className="primary-actions"><button className="primary" disabled={!canSubmit} onClick={() => void submit(false)}>{pending ? '送信中…' : canRetry ? '同じ投稿を再試行' : '投稿する'}</button>
      <button disabled={!canStop || canRetry} onClick={() => void submit(true)}>投稿して計測を停止</button>
      <button disabled={pending || !selectedId} onClick={() => void window.desktop?.openMain(selectedId)}>詳細を開く</button></div>
    <div role={failed || error ? 'alert' : 'status'} className={`message ${failed || error ? 'error' : 'success'}`}>{message || error || (!connected ? '再接続中です。下書きの編集は続けられます。' : 'チームの進捗ログに投稿されます')}</div>
    <div className="draft-tools secondary-tools">
      <button disabled={pending || canRetry || !body.trim()} onClick={() => { setShowTransfer(!showTransfer); setTransferTo('') }}>別のタスクへ移す</button>
      {!connected && <button disabled={pending} onClick={() => void refresh()}>接続を確認</button>}
    </div>
    {showTransfer && <section className="draft-transfer" aria-label="下書きの移し替え">
      <label htmlFor="quick-progress-transfer">移し先</label>
      <select id="quick-progress-transfer" value={transferTo} onChange={(event) => setTransferTo(event.target.value)}><option value="">タスクを選択</option>
        {todos.filter((todo) => todo.id !== selectedId && todo.status !== 'archived').map((todo) => <option key={todo.id} value={todo.id}>{todo.title}</option>)}
      </select>
      {destination?.attempt ? <p className="draft-warning">移し先に未確認の送信があります。先にその送信結果を確認してください。</p> : destination?.body && <><p>移し先の下書きの末尾に追記します。</p><pre>{destination.body}</pre></>}
      <button disabled={!transferTo || Boolean(destination?.attempt)} onClick={moveDraft}>{destination?.body ? '移し先の下書きに追記する' : 'このタスクへ移す'}</button>
    </section>}
  </div>
}
