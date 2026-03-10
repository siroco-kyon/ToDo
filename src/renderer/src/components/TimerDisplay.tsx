import React from 'react'

interface Props {
  elapsedSeconds: number
  isRunning: boolean
}

export function TimerDisplay({ elapsedSeconds, isRunning }: Props): React.JSX.Element {
  const h = Math.floor(elapsedSeconds / 3600)
  const m = Math.floor((elapsedSeconds % 3600) / 60)
  const s = elapsedSeconds % 60

  const formatted = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`

  return (
    <span
      style={{
        fontFamily: 'monospace',
        fontSize: '1.1em',
        color: isRunning ? '#4ade80' : '#94a3b8',
        fontWeight: isRunning ? 'bold' : 'normal'
      }}
    >
      {formatted}
    </span>
  )
}
