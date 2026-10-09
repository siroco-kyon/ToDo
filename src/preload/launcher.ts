import { contextBridge, ipcRenderer } from 'electron'
import type { LauncherBridge, LauncherState } from '../shared/desktop'

const bridge: LauncherBridge = {
  getState: () => ipcRenderer.invoke('hakobi-launcher:state'),
  connect: (profile) => ipcRenderer.invoke('hakobi-launcher:connect', profile),
  useLocal: () => ipcRenderer.invoke('hakobi-launcher:local'),
  retry: () => ipcRenderer.invoke('hakobi-launcher:retry'),
  cancel: () => ipcRenderer.invoke('hakobi-launcher:cancel'),
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: LauncherState): void => listener(state)
    ipcRenderer.on('hakobi-launcher:state-changed', handler)
    return () => ipcRenderer.removeListener('hakobi-launcher:state-changed', handler)
  }
}
contextBridge.exposeInMainWorld('hakobiLauncher', bridge)
