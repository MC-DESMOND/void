import { app, shell, BrowserWindow, ipcMain, protocol, net } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/void.png?asset'
import fs from 'fs'
import path from 'path'
import { dialog } from 'electron'

// ── constants ────────────────────────────────────────────────
const AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.ogg', '.m4a']

// ── helpers ──────────────────────────────────────────────────
function isAudio(filePath: string): boolean {
  return AUDIO_EXTS.includes(path.extname(filePath).toLowerCase())
}

function getAudioFiles(inputPath: string): { files: string[]; startIndex: number } {
  try {
    const stat = fs.statSync(inputPath)

    if (stat.isDirectory()) {
      const files = fs.readdirSync(inputPath)
        .filter(f => isAudio(f))
        .map(f => path.join(inputPath, f))
        .sort()
      return { files, startIndex: 0 }
    }

    if (stat.isFile() && isAudio(inputPath)) {
      const dir = path.dirname(inputPath)
      const files = fs.readdirSync(dir)
        .filter(f => isAudio(f))
        .map(f => path.join(dir, f))
        .sort()
      const startIndex = Math.max(0, files.indexOf(inputPath))
      return { files, startIndex }
    }
  } catch (e) {
    console.error('getAudioFiles error:', e)
  }

  return { files: [], startIndex: 0 }
}

// ── single instance lock (must be before whenReady) ──────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

app.on('second-instance', (_, argv) => {
  const inputPath = argv[argv.length - 1]
  if (!inputPath) return

  const result = getAudioFiles(inputPath)
  if (result.files.length === 0) return

  const windows = BrowserWindow.getAllWindows()
  if (windows.length > 0) {
    const win = windows[0]
    if (win.isMinimized()) win.restore()
    win.focus()
    win.webContents.send('open-files', result)
  }
})

// ── protocol (must be before whenReady) ──────────────────────
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'void',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
])

// ── ipc handlers ─────────────────────────────────────────────
ipcMain.handle('file.read', async (_, filePath: string) => {
  return fs.readFileSync(filePath)
})

ipcMain.handle('dialog.open', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a'] }],
  })
  return filePaths
})

ipcMain.handle('dialog.open-folder', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  })
  if (!filePaths[0]) return { files: [], startIndex: 0 }
  return getAudioFiles(filePaths[0])
})

// ── window ───────────────────────────────────────────────────
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    title: 'VOID 🎧',
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  protocol.handle('void', (request) => {
    const filePath = request.url.slice('void://'.length)
    const decoded = decodeURIComponent(filePath).replace(/^\//, '')
    const fileUrl = 'file:///' + decoded
    const rangeHeader = request.headers.get('Range')

    return net.fetch(fileUrl, {
      headers: rangeHeader ? { Range: rangeHeader } : {},
    }).then((response) => {
      const headers = new Headers(response.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      headers.set('Accept-Ranges', 'bytes')
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    })
  })

  mainWindow.webContents.once('did-finish-load', () => {
    const args = process.argv
    const inputPath = app.isPackaged ? args[1] : args[2]
    if (!inputPath) return

    const result = getAudioFiles(inputPath)
    if (result.files.length > 0) {
      mainWindow.webContents.send('open-files', result)
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── app lifecycle ─────────────────────────────────────────────
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.void.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})