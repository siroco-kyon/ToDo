import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge, DesktopCommand } from '../shared/desktop'

const bridge: DesktopBridge = {
  getContext: () => ipcRenderer.invoke('hakobi:context'),
  setPreferences: (patch) => ipcRenderer.invoke('hakobi:preferences', patch),
  openMain: (todoId) => ipcRenderer.invoke('hakobi:main', todoId),
  openTimer: () => ipcRenderer.invoke('hakobi:timer'),
  openQuickProgress: (todoId) => ipcRenderer.invoke('hakobi:progress', todoId),
  openGantt: () => ipcRenderer.invoke('hakobi:gantt'),
  openReport: () => ipcRenderer.invoke('hakobi:report'),
  openConnectionSettings: () => ipcRenderer.invoke('hakobi:connection'),
  hideWindow: () => ipcRenderer.invoke('hakobi:hide'),
  resizeTimer: (compact) => ipcRenderer.invoke('hakobi:resize-timer', compact),
  publishState: (state) => ipcRenderer.invoke('hakobi:state', state),
  onCommand: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: DesktopCommand): void => listener(command)
    ipcRenderer.on('hakobi:command', handler)
    return () => ipcRenderer.removeListener('hakobi:command', handler)
  }
}
contextBridge.exposeInMainWorld('desktop', bridge)
