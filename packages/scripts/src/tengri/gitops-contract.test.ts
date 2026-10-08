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

test('the namespace quota covers six slots at the accepted native memory limit', () => {
  function mib(value: unknown) {
    const match = /^(\d+)(Mi|Gi)$/.exec(String(value))
    if (!match) throw new Error('Expected a bounded memory quantity')
    return Number(match[1]) * (match[2] === 'Gi' ? 1024 : 1)
  }
  const quota = manifest('argocd/applications/tengri/resource-quota.yaml')
  const slots = Number(quota.getIn(['spec', 'hard', 'count/leases.coordination.k8s.io']))
  const native = readFileSync(new URL('../../../../services/tengri/test-kvm.sh', import.meta.url), 'utf8')
  const nativeMemory = /--memory=(\d+)g/.exec(native)
  if (!nativeMemory) throw new Error('Native acceptance must constrain runner memory')
  const deployment = manifest('argocd/applications/tengri/deployment.yaml')
  const controller = mib(
    deployment.getIn(['spec', 'template', 'spec', 'containers', 0, 'resources', 'limits', 'memory']),
  )
  const proxy = mib(
    deployment.getIn(['spec', 'template', 'metadata', 'annotations', 'sidecar.istio.io/proxyMemoryLimit']),
  )
  const required = slots * (Number(nativeMemory[1]) * 1024 + 128) + controller + proxy
  expect(mib(quota.getIn(['spec', 'hard', 'limits.memory']))).toBeGreaterThanOrEqual(required)
  expect(mib(quota.getIn(['spec', 'hard', 'requests.memory']))).toBeGreaterThanOrEqual(required)
})

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

test('device allocation installs its admission restriction before advertising KVM/TUN', () => {
  const devices = manifest('argocd/applications/tengri-devices/kustomization.yaml').get('resources')
  const controller = manifest('argocd/applications/tengri/kustomization.yaml').get('resources')
  if (!isSeq(devices) || !isSeq(controller)) throw new Error('Application resources must be sequences')
  expect(devices.toJSON()).toContain('slot-admission.yaml')
  expect(controller.toJSON()).not.toContain('slot-admission.yaml')

  const admission = documents<{
    kind?: string
    metadata?: { name?: string; annotations?: Record<string, string> }
    spec?: { failurePolicy?: string; policyName?: string; validationActions?: string[] }
  }>('argocd/applications/tengri-devices/slot-admission.yaml')
  expect(admission).toHaveLength(2)
  for (const resource of admission) {
    expect(resource.metadata?.annotations?.['argocd.argoproj.io/sync-wave']).toBe('-1')
  }
  expect(admission.find((resource) => resource.kind === 'ValidatingAdmissionPolicy')).toMatchObject({
    metadata: { name: 'tengri-slot-devices' },
    spec: { failurePolicy: 'Fail' },
  })
  expect(admission.find((resource) => resource.kind === 'ValidatingAdmissionPolicyBinding')).toMatchObject({
    spec: { policyName: 'tengri-slot-devices', validationActions: ['Deny'] },
  })
  const plugin = manifest('argocd/applications/tengri-devices/device-plugin.yaml')
  expect(plugin.getIn(['metadata', 'annotations', 'argocd.argoproj.io/sync-wave']) ?? '0').toBe('0')
})

test('slot supervisors retain host attestation after retiring guest identity privileges', () => {
  const accounts = documents<{ kind?: string; metadata?: { name?: string }; automountServiceAccountToken?: boolean }>(
    'argocd/applications/tengri/service-account.yaml',
  )
  expect(accounts.map((account) => account.metadata?.name).sort()).toEqual(['tengri', 'tengri-slot'])
  expect(accounts.find((account) => account.metadata?.name === 'tengri-slot')).toMatchObject({
    kind: 'ServiceAccount',
    automountServiceAccountToken: false,
  })
  expect(rbac.some((document) => document.kind === 'ClusterRole' || document.kind === 'ClusterRoleBinding')).toBe(false)
  expect(
    rbac
      .flatMap((document) => document.rules ?? [])
      .some((rule) =>
        rule.resources?.some((resource) => ['serviceaccounts/token', 'clusterstaticentries'].includes(resource)),
      ),
  ).toBe(false)
  const tengriResources = manifest('argocd/applications/tengri/kustomization.yaml').get('resources')
  if (!isSeq(tengriResources)) throw new Error('Tengri resources must be a sequence')
  expect(tengriResources.toJSON()).not.toContain('spire-admission.yaml')

  const values = manifest('argocd/applications/spire-server/values.yaml')
  const plugins = ['spire-server', 'unsupportedBuiltInPlugins']
  const attestors = values.getIn([...plugins, 'nodeAttestor', 'k8s_psat', 'plugin_data', 'clusters', 0])
  if (!isMap(attestors)) throw new Error('Host attestation must remain configured')
  expect(attestors.toJSON()).toEqual({
    galactic: {
      audience: ['spire-server'],
      service_account_allow_list: ['spire-system:spire-agent'],
      allowed_node_label_keys: [],
      allowed_pod_label_keys: [],
    },
  })
  const publishers = values.getIn([...plugins, 'bundlePublisher', 'k8s_configmap', 'plugin_data', 'clusters', 0])
  if (!isMap(publishers)) throw new Error('Host trust must keep renewing')
  expect(publishers.toJSON()).toEqual({
    'chart-internal': {
      format: 'spiffe',
      namespace: 'spire-system',
      configmap_name: 'spire-bundle',
      configmap_key: 'bundle.spiffe',
    },
  })
  const supervisor = values.getIn([
    'spire-server',
    'controllerManager',
    'identities',
    'clusterSPIFFEIDs',
    'tengri-slot',
  ])
  if (!isMap(supervisor)) throw new Error('Slot supervisor registration must remain configured')
  expect(supervisor.toJSON()).toEqual({
    enabled: true,
    spiffeIDTemplate: 'spiffe://{{ .TrustDomain }}/ns/tengri/slot/pod/{{ .PodMeta.UID }}',
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'tengri' } },
    podSelector: {
      matchLabels: { 'app.kubernetes.io/name': 'tengri-slot', 'spiffe.io/spire-managed-identity': 'true' },
    },
    workloadSelectorTemplates: ['k8s:sa:tengri-slot', 'k8s:container-name:supervisor'],
    ttl: '2m',
    fallback: false,
  })
  const resources = manifest('argocd/applications/spire-server/kustomization.yaml').get('resources')
  if (!isSeq(resources)) throw new Error('SPIRE resources must be a sequence')
  expect(resources.toJSON()).not.toContain('guest-bundle.yaml')
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

test('the controller reaches prepared slots without preserving an old guest network path', () => {
  const policies = networkPolicies.filter((document) => document.kind === 'NetworkPolicy')
  expect(policies.map((policy) => policy.metadata?.name).sort()).toEqual([
    'tengri-control-plane',
    'tengri-default-deny',
    'tengri-slots',
  ])
  for (const policy of policies) {
    expect(policy.metadata?.annotations?.['argocd.argoproj.io/sync-options']).toBe('Prune=false,Delete=false')
  }
  const controller = policies.find((policy) => policy.metadata?.name === 'tengri-control-plane')
  const guestTargets = controller?.spec?.egress
    ?.flatMap((rule) => rule.to ?? [])
    .filter((target) => target.podSelector && !target.namespaceSelector)
  expect(guestTargets).toEqual([{ podSelector: { matchLabels: { 'app.kubernetes.io/name': 'tengri-slot' } } }])
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
