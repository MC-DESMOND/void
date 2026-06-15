import { contextBridge } from 'electron'
import { electronAPI, } from '@electron-toolkit/preload'
// preload/index.ts
import { ipcRenderer } from "electron";


contextBridge.exposeInMainWorld("electronAPI", {
  readFile:    (path: string) => ipcRenderer.invoke("file.read", path),
  openDialog:  ()             => ipcRenderer.invoke("dialog.open"),
  openFolder:  ()             => ipcRenderer.invoke("dialog.open-folder"),
  onOpenFile:  (cb: (path: string) => void) =>
    ipcRenderer.on("open-file", (_, path) => cb(path)),
  onOpenFiles: (cb: (data: { files: string[], startIndex: number }) => void) =>
    ipcRenderer.on("open-files", (_, data) => cb(data)),
});

// Custom APIs for renderer
const api = {}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
