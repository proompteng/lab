import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isMap, parseDocument } from 'yaml'

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
  metadata?: { name?: string; annotations?: Record<string, string> }
  spec?: {
    ingress?: Array<{
      from?: Array<{ namespaceSelector?: { matchLabels?: Record<string, string> } }>
      ports?: Array<{ port?: number; protocol?: string }>
    }>
    egress?: Array<{
      to?: Array<{
        namespaceSelector?: { matchLabels?: Record<string, string> }
        podSelector?: { matchLabels?: Record<string, string> }
        ipBlock?: { cidr?: string; except?: string[] }
      }>
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

test('Tengri can create and clean up agent Pods, Secrets, and PVCs', () => {
  const role = rbac.find((document) => document.kind === 'Role' && document.metadata?.name === 'tengri')
  const podRule = role?.rules?.find((rule) => rule.resources?.includes('pods'))
  const persistentResourceRule = role?.rules?.find(
    (rule) => rule.resources?.includes('persistentvolumeclaims') && rule.resources.includes('secrets'),
  )

  expect(podRule?.verbs).toEqual(['create', 'delete', 'get', 'list', 'patch', 'watch'])
  expect(persistentResourceRule?.verbs).toEqual(['create', 'delete', 'get', 'list', 'patch', 'watch'])
})

test('Tengri preserves retained network policies during the runtime migration', () => {
  const policies = networkPolicies.filter((document) => document.kind === 'NetworkPolicy')
  expect(policies.map((policy) => policy.metadata?.name).sort()).toEqual([
    'tengri-control-plane',
    'tengri-default-deny',
    'tengri-microvm-guests',
  ])
  for (const policy of policies) {
    expect(policy.metadata?.annotations?.['argocd.argoproj.io/sync-options']).toBe('Prune=false,Delete=false')
  }
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

test('only the controller can reach the shared SpiceDB API', () => {
  const controller = networkPolicies.find((policy) => policy.metadata?.name === 'tengri-control-plane')
  const ofz = controller?.spec?.egress?.find((rule) =>
    rule.to?.some((target) => target.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'ofz'),
  )
  expect(ofz).toEqual({
    to: [
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ofz' } },
        podSelector: { matchLabels: { 'authzed.com/cluster': 'ofz', 'authzed.com/cluster-component': 'spicedb' } },
      },
    ],
    ports: [{ protocol: 'TCP', port: 8443 }],
  })
  const guest = networkPolicies.find((policy) => policy.metadata?.name === 'tengri-microvm-guests')
  expect(
    guest?.spec?.egress?.some((rule) =>
      rule.to?.some((target) => target.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'ofz'),
    ),
  ).toBe(false)
  const internet = guest?.spec?.egress?.flatMap((rule) => rule.to ?? []).find((target) => target.ipBlock)
  expect(internet?.ipBlock?.except).toContain('10.0.0.0/8')
  expect(internet?.ipBlock?.except).toContain('100.64.0.0/10')
})

test('the SpiceDB credential is sealed for the controller namespace and mounted as a file', () => {
  const manifest = (path: string) =>
    parseDocument(readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8'))
  const sealed = manifest('argocd/applications/tengri/spicedb-key-sealedsecret.yaml')
  expect(sealed.errors).toEqual([])
  expect(sealed.get('kind')).toBe('SealedSecret')
  expect(sealed.getIn(['metadata', 'namespace'])).toBe('tengri')
  expect(sealed.getIn(['spec', 'template', 'metadata', 'name'])).toBe('tengri-spicedb-key')
  expect(sealed.getIn(['spec', 'encryptedData', 'preshared_key'])).toBeString()
  expect(sealed.getIn(['spec', 'template', 'data'])).toBeUndefined()
  const deployment = manifest('argocd/applications/tengri/deployment.yaml')
  const pod = deployment.getIn(['spec', 'template', 'spec'])
  if (!isMap(pod)) throw new Error('Deployment pod spec must be a mapping')
  expect(pod.toJSON()).toMatchObject({
    containers: [
      expect.objectContaining({
        env: expect.arrayContaining([
          { name: 'TENGRI_AUTHZ_ENDPOINT', value: 'http://ofz.ofz.svc.cluster.local:8443' },
          { name: 'TENGRI_AUTHZ_KEY_FILE', value: '/var/run/secrets/tengri-authz/preshared_key' },
        ]),
        volumeMounts: expect.arrayContaining([
          { name: 'authz-secret', mountPath: '/var/run/secrets/tengri-authz', readOnly: true },
        ]),
      }),
    ],
    volumes: expect.arrayContaining([{ name: 'authz-secret', secret: { secretName: 'tengri-spicedb-key' } }]),
  })
})
