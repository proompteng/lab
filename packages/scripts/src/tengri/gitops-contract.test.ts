import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isMap, isSeq, parseDocument } from 'yaml'

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
    podSelector?: { matchLabels?: Record<string, string> }
    ingress?: Array<{
      from?: Array<{
        namespaceSelector?: { matchLabels?: Record<string, string> }
        podSelector?: { matchLabels?: Record<string, string> }
      }>
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

function manifest(path: string) {
  const document = parseDocument(readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8'))
  expect(document.errors).toEqual([])
  return document
}

test('the platform enrolls the KVM/TUN prerequisite without changing namespace policy', () => {
  const elements = manifest('argocd/applicationsets/platform.yaml').getIn([
    'spec',
    'generators',
    0,
    'matrix',
    'generators',
    1,
    'list',
    'elements',
  ])
  if (!isSeq(elements)) throw new Error('Platform applications must be a sequence')
  const devices = elements.items.find((entry) => isMap(entry) && entry.get('name') === 'tengri-devices')
  if (!isMap(devices)) throw new Error('The KVM/TUN application must be enrolled')
  expect(devices.get('path')).toBe('argocd/applications/tengri-devices')
  expect(devices.get('namespace')).toBe('kube-system')
  expect(devices.get('automation')).toBe('auto')
  expect(devices.get('enabled')).toBe('true')
  expect(devices.getIn(['annotations', 'argocd.argoproj.io/sync-wave'])).toBe('1')
  expect(devices.get('managedNamespaceMetadata')).toBeUndefined()
})

test('source delivery preserves guest attestation and published trust until cutover', () => {
  const accounts = documents<{ kind?: string; metadata?: { name?: string }; automountServiceAccountToken?: boolean }>(
    'argocd/applications/tengri/service-account.yaml',
  )
  for (const name of ['nanoagent', 'tengri-slot']) {
    expect(accounts.find((account) => account.metadata?.name === name)).toMatchObject({
      kind: 'ServiceAccount',
      automountServiceAccountToken: false,
    })
  }
  const values = manifest('argocd/applications/spire-server/values.yaml')
  const plugins = ['spire-server', 'unsupportedBuiltInPlugins']
  const guest = values.getIn([...plugins, 'nodeAttestor', 'k8s_psat', 'plugin_data', 'clusters', 0, 'galactic-guests'])
  if (!isMap(guest)) throw new Error('Existing guest attestation must remain configured')
  expect(guest.toJSON()).toEqual({
    audience: ['spire-server'],
    service_account_allow_list: ['tengri:nanoagent'],
    use_pod_uid_for_agent_id: true,
  })
  const publisher = values.getIn([
    ...plugins,
    'bundlePublisher',
    'k8s_configmap',
    'plugin_data',
    'clusters',
    0,
    'galactic-guests',
  ])
  if (!isMap(publisher)) throw new Error('Existing guest trust must keep renewing')
  expect(publisher.toJSON()).toEqual({
    format: 'pem',
    namespace: 'tengri',
    configmap_name: 'spire-guest-bundle',
    configmap_key: 'bundle.pem',
  })
  const resources = manifest('argocd/applications/spire-server/kustomization.yaml').get('resources')
  if (!isSeq(resources)) throw new Error('SPIRE resources must be a sequence')
  expect(resources.toJSON()).toContain('guest-bundle.yaml')
})

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
    'tengri-slots',
  ])
  for (const policy of policies) {
    expect(policy.metadata?.annotations?.['argocd.argoproj.io/sync-options']).toBe('Prune=false,Delete=false')
  }
  const existing = policies.find((policy) => policy.metadata?.name === 'tengri-microvm-guests')
  expect(existing?.spec?.podSelector?.matchLabels).toEqual({
    'app.kubernetes.io/name': 'nanoagent',
    'app.kubernetes.io/component': 'microvm',
  })
  expect(existing?.spec?.egress).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        to: expect.arrayContaining([
          expect.objectContaining({
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'spire-server' } },
          }),
        ]),
      }),
    ]),
  )
  const controller = policies.find((policy) => policy.metadata?.name === 'tengri-control-plane')
  expect(controller?.spec?.egress).toEqual(
    expect.arrayContaining([
      {
        to: [{ podSelector: { matchLabels: existing?.spec?.podSelector?.matchLabels } }],
        ports: [{ protocol: 'TCP', port: 8443 }],
      },
    ]),
  )
  const slots = policies.find((policy) => policy.metadata?.name === 'tengri-slots')
  expect(slots?.spec?.podSelector?.matchLabels).toEqual({ 'app.kubernetes.io/name': 'tengri-slot' })
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
  const guest = networkPolicies.find((policy) => policy.metadata?.name === 'tengri-slots')
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
  const sealed = manifest('argocd/applications/tengri/spicedb-key-sealedsecret.yaml')
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
