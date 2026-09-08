export type TanstackServiceOptions = {
  name: string
  description?: string
  owner?: string
  domain?: string
  namespace?: string
  exposure?: 'external-dns' | 'tailscale'
  tailscaleHostname?: string
  imageRegistry: string
  imageRepository?: string
  imageTag?: string
  port?: number
  enablePostgres?: boolean
  enableRedis?: boolean
  includeCi?: boolean
  includeArgo?: boolean
  includeScripts?: boolean
}

export type GeneratedFile = {
  path: string
  contents: string
  executable?: boolean
}
