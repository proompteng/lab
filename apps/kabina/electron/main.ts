import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CoreV1Api, KubeConfig } from '@kubernetes/client-node'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'

import type { KubeconfigFile } from './types.js'

const isDev = !app.isPackaged
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function resolvePreload() {
  return isDev ? path.join(app.getAppPath(), 'dist-electron', 'preload.js') : path.join(__dirname, 'preload.js')
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b1224',
    autoHideMenuBar: true,
    title: 'Kabina',
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: isDev,
    },
  })

  if (isDev) {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173'
    await win.loadURL(devServerUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    const indexPath = path.join(app.getAppPath(), 'dist', 'index.html')
    await win.loadFile(indexPath)
  }
}

ipcMain.handle('kubeconfig:select', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
  })

  if (result.canceled || result.filePaths.length === 0) return null

  const filePath = result.filePaths[0]
  const content = await fs.readFile(filePath, 'utf8')
  const payload: KubeconfigFile = { path: filePath, content }

  return payload
})

ipcMain.handle('kubeconfig:listNamespaces', async (_event, kubeconfig?: string) => {
  const kc = new KubeConfig()
  if (!kubeconfig || kubeconfig.trim().length === 0) {
    throw new Error('No kubeconfig provided')
  }

  kc.loadFromString(kubeconfig)

  const k8sApi = kc.makeApiClient(CoreV1Api)
  const resp = await k8sApi.listNamespace()
  return (resp.items ?? []).map((ns) => ns.metadata?.name).filter((name): name is string => Boolean(name))
})

ipcMain.handle('kubeconfig:listPods', async (_event, kubeconfig?: string, namespace?: string) => {
  const kc = new KubeConfig()
  if (!kubeconfig || kubeconfig.trim().length === 0) {
    throw new Error('No kubeconfig provided')
  }
  if (!namespace) {
    throw new Error('Namespace is required')
  }

  kc.loadFromString(kubeconfig)
  const k8sApi = kc.makeApiClient(CoreV1Api)
  const resp = await k8sApi.listNamespacedPod({ namespace })
  return (resp.items ?? [])
    .map((pod) => ({
      name: pod.metadata?.name ?? 'unknown',
      phase: pod.status?.phase ?? 'Unknown',
      node: pod.spec?.nodeName ?? '—',
    }))
    .filter((pod) => pod.name)
})

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow()
  }
})
