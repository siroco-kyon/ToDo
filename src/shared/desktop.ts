export interface DesktopPreferences {
  showTimer: boolean
  timerCompact: boolean
  alwaysOnTop: boolean
  hideTaskTitle: boolean
  globalShortcutFocus: string
  globalShortcutQuickAdd: string
  globalShortcutExport: string
  globalShortcutProgress: string
}

export interface ConnectionProfile {
  id: string
  name: string
  url: string
}

export interface DesktopContext {
  version: number
  serverVersion: number
  groupName: string
  serverUrl: string
  preferences: DesktopPreferences
}

export interface DesktopState {
  userId: string | null
  taskId: string | null
  taskTitle: string
  startTime: string | null
  online: boolean
  /** Server time minus this computer's time, supplied by the authenticated Web UI. */
  clockOffsetMs?: number
}

export type DesktopCommand =
  | { type: 'quick-add' }
  | { type: 'export' }
  | { type: 'navigate'; todoId: string }
  | { type: 'progress-target'; todoId: string }
  | { type: 'preferences'; preferences: DesktopPreferences }

/** Only this narrow bridge is exposed to the server-hosted UI. */
export interface DesktopBridge {
  getContext(): Promise<DesktopContext>
  setPreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>
  openMain(todoId?: string): Promise<void>
  openTimer(): Promise<void>
  openQuickProgress(todoId?: string): Promise<void>
  openGantt(): Promise<void>
  openReport(): Promise<void>
  openConnectionSettings(): Promise<void>
  hideWindow(): Promise<void>
  resizeTimer(compact: boolean): Promise<void>
  publishState(state: DesktopState): Promise<void>
  onCommand(listener: (command: DesktopCommand) => void): () => void
}

export interface LauncherState {
  mode: 'local' | 'server' | 'unset'
  profile: ConnectionProfile | null
  preferences: DesktopPreferences
  message: string
  connecting: boolean
  canCancel: boolean
}

/** This bridge is available only to the bundled connection screen. */
export interface LauncherBridge {
  getState(): Promise<LauncherState>
  connect(profile: { name: string; url: string }): Promise<void>
  useLocal(): Promise<void>
  retry(): Promise<void>
  cancel(): Promise<void>
  onState(listener: (state: LauncherState) => void): () => void
}

declare global {
  interface Window {
    desktop?: DesktopBridge
    hakobiLauncher?: LauncherBridge
  }
}
