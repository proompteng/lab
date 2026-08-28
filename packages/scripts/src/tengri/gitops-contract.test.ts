import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

type Rule = {
  resources?: string[]
  verbs?: string[]
}

type Role = {
  kind?: string
  metadata?: { name?: string }
  rules?: Rule[]
}

type Service = {
  kind?: string
  metadata?: { name?: string }
  spec?: {
    ports?: Array<{ name?: string; port?: number; protocol?: string; targetPort?: string }>
  }
}

type IngressRoute = {
  kind?: string
  metadata?: { name?: string }
  spec?: {
    routes?: Array<{
      match?: string
      services?: Array<{ name?: string; port?: number }>
    }>
  }
}

type NetworkPolicy = {
  kind?: string
  metadata?: { name?: string }
  spec?: {
    ingress?: Array<{
      from?: Array<{ namespaceSelector?: { matchLabels?: Record<string, string> } }>
      ports?: Array<{ port?: number; protocol?: string }>
    }>
  }
}

function documents<T>(path: string): T[] {
  return Bun.YAML.parse(readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8')) as T[]
}

const rbac = documents<Role>('argocd/applications/tengri/rbac.yaml')
const services = documents<Service>('argocd/applications/tengri/services.yaml')
const ingressRoutes = documents<IngressRoute>('argocd/applications/tengri/ingressroute.yaml')
const networkPolicies = documents<NetworkPolicy>('argocd/applications/tengri/network-policies.yaml')

test('Tengri can watch Secret and PVC deletion to completion', () => {
  const role = rbac.find((document) => document.kind === 'Role' && document.metadata?.name === 'tengri')
  const cleanupRule = role?.rules?.find(
    (rule) => rule.resources?.includes('persistentvolumeclaims') && rule.resources.includes('secrets'),
  )

  expect(cleanupRule?.verbs).toEqual(['delete', 'get', 'list', 'patch', 'watch'])
})

test('public control and preview traffic use isolated Services and routes', () => {
  const gatewayService = services.find(
    (document) => document.kind === 'Service' && document.metadata?.name === 'tengri-gateway',
  )
  const previewService = services.find(
    (document) => document.kind === 'Service' && document.metadata?.name === 'tengri-preview',
  )
  expect(gatewayService?.spec?.ports).toEqual([{ name: 'http', port: 8080, targetPort: 'gateway', protocol: 'TCP' }])
  expect(previewService?.spec?.ports).toEqual([{ name: 'http', port: 8081, targetPort: 'preview', protocol: 'TCP' }])

  const gatewayIngress = ingressRoutes.find(
    (document) => document.kind === 'IngressRoute' && document.metadata?.name === 'tengri-gateway',
  )
  const previewIngress = ingressRoutes.find(
    (document) => document.kind === 'IngressRoute' && document.metadata?.name === 'tengri-preview',
  )
  const gatewayRoute = gatewayIngress?.spec?.routes?.[0]
  const previewRoute = previewIngress?.spec?.routes?.[0]
  expect(gatewayRoute?.match).toContain('Host(`tengri.proompteng.ai`)')
  expect(gatewayRoute?.match).not.toContain('HostRegexp')
  expect(gatewayRoute?.services).toEqual([{ name: 'tengri-gateway', port: 8080 }])
  expect(previewRoute?.match).toBe('HostRegexp(`^tengri-[a-z0-9]{24}\\.proompteng\\.ai$`)')
  expect(previewRoute?.services).toEqual([{ name: 'tengri-preview', port: 8081 }])
})

test('Traefik can reach both public listeners while observability remains control-only', () => {
  const controlPolicy = networkPolicies.find(
    (document) => document.kind === 'NetworkPolicy' && document.metadata?.name === 'tengri-control-plane',
  )
  const ingressFrom = (namespace: string) =>
    controlPolicy?.spec?.ingress?.find((rule) =>
      rule.from?.some((source) => source.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === namespace),
    )

  expect(ingressFrom('traefik')?.ports).toEqual([
    { protocol: 'TCP', port: 8080 },
    { protocol: 'TCP', port: 8081 },
  ])
  expect(ingressFrom('observability')?.ports).toEqual([{ protocol: 'TCP', port: 8080 }])
})
