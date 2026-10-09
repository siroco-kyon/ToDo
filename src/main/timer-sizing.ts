export interface TimerSize { width: number; height: number }
export interface TimerPoint { x: number; y: number }
export interface TimerBounds extends TimerSize, TimerPoint {}
export interface TimerSizes { normal?: TimerSize; compact?: TimerSize }

/** All dimensions are outer window pixels, including the native frame. */
export const TIMER_SIZES = {
  normal: { width: 360, height: 250, minWidth: 320, minHeight: 240 },
  compact: { width: 320, height: 150, minWidth: 300, minHeight: 150 }
} as const
export const MAX_TIMER_SIZE: TimerSize = { width: 1600, height: 1200 }

export function normalizeTimerSize(compact: boolean, value: unknown): TimerSize | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { width, height } = value as Partial<TimerSize>
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  const minimum = TIMER_SIZES[compact ? 'compact' : 'normal']
  return {
    width: Math.max(minimum.minWidth, Math.min(MAX_TIMER_SIZE.width, Math.round(width))),
    height: Math.max(minimum.minHeight, Math.min(MAX_TIMER_SIZE.height, Math.round(height)))
  }
}

export function timerGeometry(compact: boolean, saved: TimerSize | undefined, area: TimerBounds,
  options: { position?: TimerPoint; anchor?: TimerPoint } = {}): { bounds: TimerBounds; minSize: TimerSize } {
  const preset = TIMER_SIZES[compact ? 'compact' : 'normal']
  const requested = normalizeTimerSize(compact, saved) ?? preset
  const width = Math.min(requested.width, area.width)
  const height = Math.min(requested.height, area.height)
  const x = options.anchor ? options.anchor.x - width : options.position?.x ?? area.x + area.width - width - 20
  const y = options.anchor ? options.anchor.y - height : options.position?.y ?? area.y + area.height - height - 20
  return {
    bounds: {
      x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
      y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))),
      width: Math.floor(width), height: Math.floor(height)
    },
    minSize: { width: Math.min(preset.minWidth, area.width), height: Math.min(preset.minHeight, area.height) }
  }
}
