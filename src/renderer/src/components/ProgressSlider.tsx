import React, { useEffect, useRef, useState } from 'react'

// マウスで左右にドラッグして進捗率を変えられるバー。
// ドラッグ中は表示だけ動かし、指を離したときに1回だけ保存する（途中の値で何度も保存しない）。
// キーボードでも ←→（5%）、PageUp/PageDown（10%）、Home/End で操作できる。

interface Props {
  value: number
  /** 保存処理。完了するまでは新しい値を表示し続ける */
  onCommit: (value: number) => Promise<unknown> | void
  label: string
  disabled?: boolean
  /** バーの太さ（px） */
  height?: number
  /** ドラッグ時のきざみ（%） */
  step?: number
  /** 右側に % の数値を出す */
  showValue?: boolean
  valueMinWidth?: number
}

const KEY_COMMIT_DELAY_MS = 500

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value))
}

export function ProgressSlider({
  value,
  onCommit,
  label,
  disabled = false,
  height = 8,
  step = 5,
  showValue = true,
  valueMinWidth = 40
}: Props): React.JSX.Element {
  // ドラッグ中・保存待ちの値。null のときは props の値をそのまま出す
  const [pending, setPending] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [hovered, setHovered] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)
  const keyTimerRef = useRef<number | null>(null)
  const shown = pending ?? value

  useEffect(() => () => {
    if (keyTimerRef.current !== null) window.clearTimeout(keyTimerRef.current)
  }, [])

  const valueFromClientX = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return value
    const ratio = (clientX - rect.left) / rect.width
    return clamp(Math.round((ratio * 100) / step) * step)
  }

  // 保存中に次の操作が始まったとき、古い保存の完了で新しい表示値を消さないための番号
  const commitIdRef = useRef(0)

  const commit = async (next: number): Promise<void> => {
    const commitId = ++commitIdRef.current
    if (next === value) {
      setPending(null)
      return
    }
    setPending(next)
    try {
      await onCommit(next)
    } finally {
      if (commitId === commitIdRef.current) setPending(null)
    }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (disabled || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus()
    commitIdRef.current += 1
    setDragging(true)
    setPending(valueFromClientX(event.clientX))
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    setPending(valueFromClientX(event.clientX))
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    setDragging(false)
    void commit(valueFromClientX(event.clientX))
  }

  const handlePointerCancel = (): void => {
    setDragging(false)
    setPending(null)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const deltas: Record<string, number> = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 10, PageDown: -10 }
    let next: number | null = null
    if (event.key in deltas) next = clamp(shown + deltas[event.key])
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = 100
    if (next === null) return
    event.preventDefault()
    const target = next
    setPending(target)
    // 連打のたびに保存しないよう、キー操作が止まってからまとめて保存する
    if (keyTimerRef.current !== null) window.clearTimeout(keyTimerRef.current)
    keyTimerRef.current = window.setTimeout(() => {
      keyTimerRef.current = null
      void commit(target)
    }, KEY_COMMIT_DELAY_MS)
  }

  const active = dragging || hovered
  const fillColor = shown >= 100 ? '#22c55e' : '#3b82f6'
  const thumbSize = height + 6

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shown}
        aria-valuetext={`${shown}%`}
        aria-disabled={disabled}
        title={disabled ? undefined : 'ドラッグで進捗率を変更（←→キーでも変更できます）'}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onKeyDown={handleKeyDown}
        style={{
          flex: 1,
          minWidth: 0,
          // 細いバーでも掴みやすいよう、上下に当たり判定の余白を取る
          padding: '6px 0',
          cursor: disabled ? 'default' : dragging ? 'grabbing' : 'ew-resize',
          touchAction: 'none',
          outlineOffset: 2
        }}
      >
        <div ref={trackRef} style={{ position: 'relative', height, background: '#1e293b', borderRadius: 999 }}>
          <div
            style={{
              width: `${shown}%`,
              height: '100%',
              background: fillColor,
              borderRadius: 999,
              opacity: pending !== null && !dragging ? 0.7 : 1,
              transition: dragging ? 'none' : 'width 0.15s ease'
            }}
          />
          {!disabled && (
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: `${shown}%`,
                width: thumbSize,
                height: thumbSize,
                marginLeft: -thumbSize / 2,
                marginTop: -thumbSize / 2,
                borderRadius: '50%',
                background: '#f8fafc',
                border: `2px solid ${fillColor}`,
                boxShadow: '0 1px 4px rgba(0,0,0,0.5)',
                opacity: active ? 1 : 0.55,
                transform: dragging ? 'scale(1.15)' : 'none',
                transition: dragging ? 'none' : 'left 0.15s ease, opacity 0.15s ease'
              }}
            />
          )}
        </div>
      </div>
      {showValue && (
        <span style={{ fontSize: height >= 8 ? '0.86rem' : '0.72rem', color: dragging ? '#93c5fd' : '#f1f5f9', fontWeight: 800, minWidth: valueMinWidth, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {shown}%
        </span>
      )}
    </div>
  )
}
