import { Tray, Menu, app, BrowserWindow } from 'electron'
import type { NativeImage } from 'electron'

let tray: Tray | null = null

export function createTray(mainWindow: BrowserWindow, icon: NativeImage): Tray {
  tray = new Tray(icon)
  tray.setToolTip('ToDo App')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '表示/非表示',
      click: () => {
        if (mainWindow.isVisible()) {
          mainWindow.hide()
        } else {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    {
      label: '最前面に表示',
      click: () => {
        mainWindow.show()
        mainWindow.focus()
      }
    },
    { type: 'separator' },
    {
      label: '終了',
      click: () => {
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.focus()
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  return tray
}

export function updateTrayIcon(image: NativeImage): void {
  if (tray) tray.setImage(image)
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}
