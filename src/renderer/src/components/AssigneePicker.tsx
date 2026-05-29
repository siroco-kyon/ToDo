import React from 'react'
import type { PublicUser } from '../types'

const baseSelectStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '8px 12px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 8,
  color: '#e2e8f0',
  fontSize: '0.9rem',
  boxSizing: 'border-box'
}

interface PickerProps {
  users: PublicUser[]
  value: string | null
  onChange: (assigneeId: string | null) => void
  selectStyle?: React.CSSProperties
  unassignedLabel?: string
}

/** Dropdown to choose the user a task is assigned to. Shows the chosen user's color as a dot. */
export function AssigneePicker({
  users,
  value,
  onChange,
  selectStyle,
  unassignedLabel = '未割り当て'
}: PickerProps): React.JSX.Element {
  const selected = users.find((user) => user.id === value) ?? null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span aria-hidden style={dotStyle(selected?.color ?? null, 11)} />
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        style={{ ...baseSelectStyle, ...selectStyle }}
      >
        <option value="">{unassignedLabel}</option>
        {users.map((user) => (
          <option key={user.id} value={user.id}>
            {user.display_name}
            {user.is_active ? '' : '（無効）'}
          </option>
        ))}
      </select>
    </div>
  )
}

interface ChipProps {
  name: string | null
  color: string | null
  fontSize?: number
}

/** Read-only colored badge with the assignee's initial and name. Renders nothing when unassigned. */
export function AssigneeChip({ name, color, fontSize = 0.72 }: ChipProps): React.JSX.Element | null {
  if (!name) return null
  const dotColor = color ?? '#64748b'

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '1px 7px 1px 3px',
        borderRadius: 99,
        background: `${dotColor}1f`,
        border: `1px solid ${dotColor}55`,
        color: '#e2e8f0',
        fontSize: `${fontSize}rem`,
        lineHeight: 1.6,
        maxWidth: 140,
        overflow: 'hidden'
      }}
    >
      <span style={avatarStyle(dotColor)}>{name.slice(0, 1)}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
    </span>
  )
}

function dotStyle(color: string | null, size: number): React.CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    background: color ?? '#475569',
    boxShadow: color ? `0 0 0 2px ${color}33` : 'none'
  }
}

function avatarStyle(color: string): React.CSSProperties {
  return {
    width: 16,
    height: 16,
    borderRadius: '50%',
    flexShrink: 0,
    background: color,
    color: '#0b1220',
    fontWeight: 800,
    fontSize: '0.62rem',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    textTransform: 'uppercase'
  }
}
