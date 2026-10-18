import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useDialogFocus } from '../hooks/useDialogFocus'
import type { CreateUserInput, PublicUser, UpdateUserInput, UserRole, UserDeletePreview } from '../types'

interface Props {
  currentUserId: string
  onClose: () => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
  onChanged: () => void
}

const USER_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#84cc16', '#f97316', '#14b8a6']

function roleLabel(role: UserRole): string {
  return role === 'admin' ? '管理者' : 'メンバー'
}

export function UserManagementModal({ currentUserId, onClose, onShowToast, onChanged }: Props): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)
  const [deletePreview, setDeletePreview] = useState<UserDeletePreview | null>(null)
  const actionPending = useRef(false)
  const [users, setUsers] = useState<PublicUser[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [pwdId, setPwdId] = useState<string | null>(null)
  const [pwdValue, setPwdValue] = useState('')

  // Inline editor draft for the currently expanded row.
  const [editName, setEditName] = useState('')
  const [editRole, setEditRole] = useState<UserRole>('member')
  const [editColor, setEditColor] = useState(USER_COLORS[0])
  const [editActive, setEditActive] = useState(true)

  // Create form.
  const [newUsername, setNewUsername] = useState('')
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState<UserRole>('member')
  const [newColor, setNewColor] = useState(USER_COLORS[0])
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setUsers(await window.api.userList())
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : 'ユーザーの取得に失敗しました', 'error')
    } finally {
      setLoading(false)
    }
  }, [onShowToast])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault()
        if (actionPending.current) return
        if (deletePreview) setDeletePreview(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, deletePreview])

  const beginEdit = (user: PublicUser): void => {
    setPwdId(null)
    setEditId(user.id)
    setEditName(user.display_name)
    setEditRole(user.role)
    setEditColor(user.color)
    setEditActive(user.is_active === 1)
  }

  useEffect(() => window.api.onDataChanged((scope) => {
    if (scope === 'user') void load()
  }), [load])

  const beginDelete = async (user: PublicUser): Promise<void> => {
    if (actionPending.current) return
    actionPending.current = true
    setBusyId(user.id)
    try {
      setDeletePreview(await window.api.userDeletePreview(user.id))
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '削除対象を確認できませんでした', 'error')
    } finally {
      actionPending.current = false
      setBusyId(null)
    }
  }

  const handleDelete = async (username: string): Promise<void> => {
    if (!deletePreview || actionPending.current) return
    actionPending.current = true
    setBusyId(deletePreview.user.id)
    try {
      await window.api.userDelete(deletePreview.user.id, username)
      onShowToast('「' + deletePreview.user.display_name + '」を削除しました', 'success')
      setDeletePreview(null)
      setEditId(null)
      setPwdId(null)
      await load()
      onChanged()
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : 'メンバーを削除できませんでした', 'error')
    } finally {
      actionPending.current = false
      setBusyId(null)
    }
  }

  const handleCreate = async (): Promise<void> => {
    if (!newUsername.trim() || !newDisplayName.trim()) {
      onShowToast('ユーザー名と表示名を入力してください', 'error')
      return
    }
    if (newPassword.length < 6) {
      onShowToast('パスワードは6文字以上にしてください', 'error')
      return
    }
    setCreating(true)
    try {
      const input: CreateUserInput = {
        username: newUsername.trim(),
        display_name: newDisplayName.trim(),
        password: newPassword,
        role: newRole,
        color: newColor
      }
      await window.api.userCreate(input)
      onShowToast(`「${input.display_name}」を追加しました`)
      setNewUsername('')
      setNewDisplayName('')
      setNewPassword('')
      setNewRole('member')
      setNewColor(USER_COLORS[0])
      await load()
      onChanged()
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '追加に失敗しました', 'error')
    } finally {
      setCreating(false)
    }
  }

  const handleSaveEdit = async (user: PublicUser): Promise<void> => {
    if (!editName.trim()) {
      onShowToast('表示名を入力してください', 'error')
      return
    }
    const patch: UpdateUserInput = {
      display_name: editName.trim(),
      role: editRole,
      color: editColor,
      is_active: editActive
    }
    setBusyId(user.id)
    try {
      await window.api.userUpdate(user.id, patch)
      onShowToast(`「${editName.trim()}」を更新しました`)
      setEditId(null)
      await load()
      onChanged()
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '更新に失敗しました', 'error')
    } finally {
      setBusyId(null)
    }
  }

  const handleResetPassword = async (user: PublicUser): Promise<void> => {
    if (pwdValue.length < 6) {
      onShowToast('パスワードは6文字以上にしてください', 'error')
      return
    }
    setBusyId(user.id)
    try {
      await window.api.userResetPassword(user.id, pwdValue)
      onShowToast(`「${user.display_name}」のパスワードを変更しました`)
      setPwdId(null)
      setPwdValue('')
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : 'パスワードの変更に失敗しました', 'error')
    } finally {
      setBusyId(null)
    }
  }

  if (deletePreview) {
    return <DeleteMemberConfirmation key={deletePreview.user.id} preview={deletePreview} busy={busyId !== null}
      onCancel={() => { if (!actionPending.current) setDeletePreview(null) }} onDelete={handleDelete} />
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100
      }}
      onClick={(e) => e.target === e.currentTarget && !actionPending.current && onClose()}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="ユーザー管理" style={{
        background: 'var(--slate-800)', borderRadius: 14, padding: 28, width: 600,
        maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)', border: '1px solid var(--slate-700)',
        display: 'flex', flexDirection: 'column', gap: 24
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: '1.1rem', color: 'var(--slate-200)', margin: 0 }}>👤 ユーザー管理</h2>
          <button onClick={onClose} style={closeBtnStyle}>×</button>
        </div>

        {/* ─── メンバー一覧 ─── */}
        <section>
          <h3 style={sectionHead}>メンバー（{users.length}人）</h3>
          {loading ? (
            <div style={{ color: 'var(--slate-500)', fontSize: '0.84rem', padding: '12px 0' }}>読み込み中…</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              {users.map((user) => {
                const isSelf = user.id === currentUserId
                const inactive = user.is_active !== 1
                const isEditing = editId === user.id
                const isPwd = pwdId === user.id
                const rowBusy = busyId !== null
                return (
                  <div key={user.id} style={{
                    border: `1px solid ${isEditing ? 'var(--indigo-500)' : 'var(--slate-700)'}`,
                    borderRadius: 10, background: 'var(--slate-900)', padding: '10px 12px',
                    opacity: inactive && !isEditing ? 0.6 : 1
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ width: 12, height: 12, borderRadius: '50%', background: user.color, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: '0.9rem', color: 'var(--slate-200)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {user.display_name}
                          </span>
                          <span style={roleBadge(user.role)}>{roleLabel(user.role)}</span>
                          {isSelf && <span style={selfBadge}>自分</span>}
                          {inactive && <span style={inactiveBadge}>無効</span>}
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--slate-500)', marginTop: 2 }}>@{user.username}</div>
                      </div>
                      {!isEditing && (
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          <button onClick={() => beginEdit(user)} style={ghostBtn} disabled={rowBusy}>編集</button>
                          <button
                            onClick={() => { setEditId(null); setPwdId(isPwd ? null : user.id); setPwdValue('') }}
                            style={ghostBtn}
                            disabled={rowBusy}
                          >
                            パスワード
                          </button>
                          <button onClick={() => void beginDelete(user)} style={{ ...ghostBtn, color: 'var(--red-300)' }}
                            disabled={isSelf || rowBusy} title={isSelf ? '自分自身は削除できません' : undefined}>削除</button>
                        </div>
                      )}
                    </div>

                    {/* インライン編集 */}
                    {isEditing && (
                      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div>
                          <label style={fieldLabel}>表示名</label>
                          <input value={editName} onChange={(e) => setEditName(e.target.value)} style={inputStyle} />
                        </div>
                        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                          <div>
                            <label style={fieldLabel}>権限</label>
                            <select
                              value={editRole}
                              onChange={(e) => setEditRole(e.target.value as UserRole)}
                              disabled={isSelf}
                              title={isSelf ? '自分自身の管理者権限は変更できません' : undefined}
                              style={{ ...inputStyle, width: 140, opacity: isSelf ? 0.5 : 1 }}
                            >
                              <option value="member">メンバー</option>
                              <option value="admin">管理者</option>
                            </select>
                          </div>
                          <div>
                            <label style={fieldLabel}>状態</label>
                            <button
                              onClick={() => !isSelf && setEditActive((v) => !v)}
                              disabled={isSelf}
                              title={isSelf ? '自分自身は無効化できません' : undefined}
                              style={{
                                ...inputStyle, width: 140, cursor: isSelf ? 'default' : 'pointer',
                                color: editActive ? 'var(--green-400)' : 'var(--red-400)', opacity: isSelf ? 0.5 : 1, textAlign: 'left'
                              }}
                            >
                              {editActive ? '有効' : '無効'}
                            </button>
                          </div>
                        </div>
                        <div>
                          <label style={fieldLabel}>カラー</label>
                          <ColorSwatches value={editColor} onChange={setEditColor} />
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                          <button onClick={() => void handleSaveEdit(user)} style={primaryBtn} disabled={rowBusy}>
                            {rowBusy ? '保存中…' : '保存'}
                          </button>
                          <button onClick={() => setEditId(null)} style={secondaryBtn} disabled={rowBusy}>キャンセル</button>
                        </div>
                      </div>
                    )}

                    {/* パスワード再設定 */}
                    {isPwd && !isEditing && (
                      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input
                          type="password"
                          value={pwdValue}
                          onChange={(e) => setPwdValue(e.target.value)}
                          placeholder="新しいパスワード（6文字以上）"
                          style={{ ...inputStyle, flex: 1, minWidth: 200 }}
                        />
                        <button onClick={() => void handleResetPassword(user)} style={primaryBtn} disabled={rowBusy}>
                          {rowBusy ? '設定中…' : '設定'}
                        </button>
                        <button onClick={() => { setPwdId(null); setPwdValue('') }} style={secondaryBtn} disabled={rowBusy}>キャンセル</button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* ─── 新規追加 ─── */}
        <section>
          <h3 style={sectionHead}>メンバーを追加</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={fieldLabel}>ユーザー名（ログインID）</label>
                <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="例: tanaka" style={inputStyle} />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={fieldLabel}>表示名</label>
                <input value={newDisplayName} onChange={(e) => setNewDisplayName(e.target.value)} placeholder="例: 田中 太郎" style={inputStyle} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={fieldLabel}>初期パスワード（6文字以上）</label>
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={fieldLabel}>権限</label>
                <select value={newRole} onChange={(e) => setNewRole(e.target.value as UserRole)} style={{ ...inputStyle, width: 140 }}>
                  <option value="member">メンバー</option>
                  <option value="admin">管理者</option>
                </select>
              </div>
            </div>
            <div>
              <label style={fieldLabel}>カラー</label>
              <ColorSwatches value={newColor} onChange={setNewColor} />
            </div>
            <button onClick={() => void handleCreate()} style={{ ...primaryBtn, marginTop: 4, alignSelf: 'flex-start' }} disabled={creating}>
              {creating ? '追加中…' : '＋ 追加'}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

function ColorSwatches({ value, onChange }: { value: string; onChange: (color: string) => void }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {USER_COLORS.map((color) => (
        <button
          key={color}
          onClick={() => onChange(color)}
          title={color}
          style={{
            width: 24, height: 24, borderRadius: '50%', background: color, cursor: 'pointer',
            border: value === color ? '2px solid var(--slate-50)' : '2px solid transparent',
            boxShadow: value === color ? `0 0 0 2px ${color}` : 'none'
          }}
        />
      ))}
    </div>
  )
}

const sectionHead: React.CSSProperties = {
  fontSize: '0.72rem', color: 'var(--slate-500)', textTransform: 'uppercase',
  letterSpacing: '0.08em', fontWeight: 'bold', margin: 0
}

const fieldLabel: React.CSSProperties = {
  fontSize: '0.74rem', color: 'var(--slate-400)', display: 'block', marginBottom: 4
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 10px',
  background: 'var(--slate-900)', border: '1px solid var(--slate-700)', borderRadius: 7,
  color: 'var(--slate-200)', fontSize: '0.85rem', outline: 'none'
}

const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--slate-500)',
  cursor: 'pointer', fontSize: '1.2rem', padding: '2px 6px'
}

const primaryBtn: React.CSSProperties = {
  padding: '7px 16px', background: 'var(--indigo-500)', border: 'none',
  borderRadius: 7, color: 'var(--on-fill-white)', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 'bold', whiteSpace: 'nowrap'
}

const secondaryBtn: React.CSSProperties = {
  padding: '7px 14px', background: 'var(--slate-700)', border: 'none',
  borderRadius: 7, color: 'var(--slate-300)', cursor: 'pointer', fontSize: '0.85rem', whiteSpace: 'nowrap'
}

const ghostBtn: React.CSSProperties = {
  padding: '5px 10px', background: 'transparent', border: '1px solid var(--slate-700)',
  borderRadius: 6, color: 'var(--slate-400)', cursor: 'pointer', fontSize: '0.76rem', whiteSpace: 'nowrap'
}

function roleBadge(role: UserRole): React.CSSProperties {
  const admin = role === 'admin'
  return {
    fontSize: '0.64rem', fontWeight: 700, padding: '1px 7px', borderRadius: 99,
    background: admin ? 'color-mix(in srgb, var(--violet-600) 18.8%, transparent)' : 'color-mix(in srgb, var(--slate-700) 25.1%, transparent)', color: admin ? 'var(--violet-300)' : 'var(--slate-400)'
  }
}

const selfBadge: React.CSSProperties = {
  fontSize: '0.64rem', fontWeight: 700, padding: '1px 7px', borderRadius: 99,
  background: 'color-mix(in srgb, var(--blue-700) 18.8%, transparent)', color: 'var(--blue-300)'
}

const inactiveBadge: React.CSSProperties = {
  fontSize: '0.64rem', fontWeight: 700, padding: '1px 7px', borderRadius: 99,
  background: 'color-mix(in srgb, var(--red-900) 25.1%, transparent)', color: 'var(--red-300)'
}

function DeleteMemberConfirmation({ preview, busy, onCancel, onDelete }: {
  preview: UserDeletePreview
  busy: boolean
  onCancel: () => void
  onDelete: (username: string) => Promise<void>
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)
  const [confirmation, setConfirmation] = useState('')
  const { user } = preview
  const canDelete = !busy && confirmation === user.username
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="delete-member-heading" style={{ background: 'var(--slate-800)', border: '1px solid var(--red-500)', borderRadius: 14, padding: 28, width: 480, maxWidth: '90vw', maxHeight: '88vh', overflowY: 'auto', color: 'var(--slate-200)', lineHeight: 1.6 }}>
        <h2 id="delete-member-heading" style={{ margin: '0 0 14px' }}>メンバーの削除を確認</h2>
        <div style={{ fontSize: '1.2rem', fontWeight: 700, overflowWrap: 'anywhere' }}>{user.display_name}</div>
        <div style={{ color: 'var(--slate-300)', fontSize: '1rem', marginTop: 6, overflowWrap: 'anywhere' }}>ログインID: {user.username}</div>
        <p style={{ margin: '14px 0' }}>担当タスク {preview.taskCount}件・サブタスク {preview.subtaskCount}件を未割り当てにします。共同担当のタスク {preview.coAssignedTaskCount}件からも外します。</p>
        <p style={{ margin: '14px 0' }}>削除後はログインできなくなり、接続中のセッションを終了します。計測中の作業は停止してログを保存します。</p>
        <p style={{ margin: '14px 0' }}>タスク・作業ログ・投稿・変更履歴は残ります。削除は取り消せません。同じログインIDは再利用できません。</p>
        <label style={fieldLabel} htmlFor="delete-member-id">確認のため、対象のログインIDを入力してください</label>
        <input id="delete-member-id" value={confirmation} onChange={(event) => setConfirmation(event.target.value)}
          disabled={busy} autoComplete="off" spellCheck={false} style={inputStyle} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button autoFocus onClick={onCancel} disabled={busy} style={secondaryBtn}>キャンセル</button>
          <button onClick={() => { if (canDelete) void onDelete(confirmation) }} disabled={!canDelete}
            style={{ ...primaryBtn, background: canDelete ? 'var(--red-700)' : 'var(--slate-700)', opacity: canDelete ? 1 : 0.6 }}>{busy ? '削除中…' : '削除する'}</button>
        </div>
      </div>
    </div>
  )
}
