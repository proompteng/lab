declare global {
  interface Window {
    kubeBridge: {
      selectKubeconfig: () => Promise<{ path: string; content: string } | null>
      listNamespaces: (kubeconfig?: string) => Promise<string[]>
      listPods: (kubeconfig: string, namespace: string) => Promise<{ name: string; phase: string; node: string }[]>
    }
  }
}
