import { contextBridge, ipcRenderer } from 'electron'
import type { KubeconfigFile } from './types.js'

contextBridge.exposeInMainWorld('kubeBridge', {
  selectKubeconfig: (): Promise<KubeconfigFile | null> => ipcRenderer.invoke('kubeconfig:select'),
  listNamespaces: (kubeconfig?: string): Promise<string[]> =>
    ipcRenderer.invoke('kubeconfig:listNamespaces', kubeconfig),
  listPods: (kubeconfig: string, namespace: string): Promise<{ name: string; phase: string; node: string }[]> =>
    ipcRenderer.invoke('kubeconfig:listPods', kubeconfig, namespace),
})
