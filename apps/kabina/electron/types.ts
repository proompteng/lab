export type KubeconfigFile = {
  path: string
  content: string
}

export type PodSummary = {
  name: string
  phase: string
  node: string
}
