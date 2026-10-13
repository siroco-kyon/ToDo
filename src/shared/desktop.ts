export interface DesktopPreferences {
  showTimer: boolean
  timerCompact: boolean
  alwaysOnTop: boolean
  hideTaskTitle: boolean
  globalShortcutFocus: string
  globalShortcutQuickAdd: string
  globalShortcutExport: string
  globalShortcutProgress: string
  /** Show team notifications as OS notifications. */
  showNotifications: boolean
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
  /** Tasks the tray and taskbar offer for starting or switching the timer. Older Web UIs omit it. */
  recentTasks?: DesktopTaskShortcut[]
  /** Unread team notifications for the tray and taskbar badge. Older Web UIs omit it. */
  unreadCount?: number
}

export const DESKTOP_RECENT_TASK_LIMIT = 5

export interface DesktopTaskShortcut {
  id: string
  title: string
}

export interface DesktopNotification {
  /** Clicking opens this server notification as the in-app list does; without it the list itself opens. */
  notificationId?: string
  title: string
  body: string
}

export type DesktopCommand =
  | { type: 'quick-add' }
  | { type: 'export' }
  | { type: 'navigate'; todoId: string }
  | { type: 'progress-target'; todoId: string }
  | { type: 'preferences'; preferences: DesktopPreferences }
  | { type: 'open-notification'; notificationId?: string }
  | { type: 'timer-start'; todoId: string }
  | { type: 'timer-stop' }

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
  // The Web UI is served by the team server, so it may run inside an older app without these.
  notify?(notification: DesktopNotification): Promise<void>
  showError?(message: string): Promise<void>
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
