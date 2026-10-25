import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { isMap, isSeq, parseAllDocuments, parseDocument } from 'yaml'

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

const cutover = new Map(
  ['tengri', 'proompteng'].map((app) => [
    app,
    parseAllDocuments(
      execFileSync(
        'kustomize',
        ['build', new URL(`../../../../argocd/applications/${app}`, import.meta.url).pathname],
        {
          encoding: 'utf8',
        },
      ),
    ),
  ]),
)

function cutoverManifest(app: string, kind: string, name: string) {
  const document = cutover
    .get(app)
    ?.find((entry) => entry.get('kind') === kind && entry.getIn(['metadata', 'name']) === name)
  if (!document) throw new Error(`Missing cutover ${kind}/${name}`)
  expect(document.errors).toEqual([])
  return document
}

function manifest(path: string) {
  const document = parseDocument(readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8'))
  expect(document.errors).toEqual([])
  return document
}

test('controller identity reaches the mounted SPIFFE workload API', () => {
  const controller = cutoverManifest('tengri', 'Deployment', 'tengri')
  const mounts = controller.getIn(['spec', 'template', 'spec', 'containers', 0, 'volumeMounts'])
  if (!isSeq(mounts)) throw new Error('Missing controller volume mounts')
  expect(mounts.toJSON()).toContainEqual({
    name: 'workload-api',
    mountPath: '/spiffe-workload-api',
    readOnly: true,
  })
})

test('Nanoagent promotion rewrites the controller ConfigMap reference', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tengri-promotion-')))
  const image = `registry.ide-newton.ts.net/lab/nanoagent@sha256:${'e'.repeat(64)}`
  try {
    writeFileSync(
      join(directory, 'kustomization.yaml'),
      JSON.stringify({
        apiVersion: 'kustomize.config.k8s.io/v1beta1',
        kind: 'Kustomization',
        resources: [relative(directory, new URL('../../../../argocd/applications/tengri', import.meta.url).pathname)],
        configMapGenerator: [{ name: 'tengri-release', behavior: 'merge', literals: [`NANOAGENT_IMAGE=${image}`] }],
      }),
    )
    const rendered = parseAllDocuments(
      execFileSync('kustomize', ['build', directory, '--load-restrictor', 'LoadRestrictionsNone'], {
        encoding: 'utf8',
      }),
    )
    const release = rendered.find(
      (entry) => entry.get('kind') === 'ConfigMap' && entry.getIn(['data', 'NANOAGENT_IMAGE']) === image,
    )
    const controller = rendered.find(
      (entry) => entry.get('kind') === 'Deployment' && entry.getIn(['metadata', 'name']) === 'tengri',
    )
    if (!release || !controller) throw new Error('Missing promoted image contract')
    const env = controller.getIn(['spec', 'template', 'spec', 'containers', 0, 'env'])
    if (!isSeq(env)) throw new Error('Missing controller environment')
    const reference = env.items.find((entry) => isMap(entry) && entry.get('name') === 'TENGRI_DEFAULT_IMAGE')
    if (!isMap(reference)) throw new Error('Missing guest image reference')
    expect(reference.getIn(['valueFrom', 'configMapKeyRef', 'name'])).toBe(release.getIn(['metadata', 'name']))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the namespace can admit six slot leases with rolling-upgrade headroom', () => {
  const quota = manifest('argocd/applications/tengri/resource-quota.yaml')
  const source = readFileSync(new URL('../../../../services/tengri/src/controller.rs', import.meta.url), 'utf8')
  const slots = /const SLOT_COUNT: usize = (\d+);/.exec(source)
  if (!slots) throw new Error('Controller slot capacity must be explicit')
  expect(Number(quota.getIn(['spec', 'hard', 'count/leases.coordination.k8s.io']))).toBeGreaterThanOrEqual(
    Number(slots[1]) + 1,
  )
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
    'tengri-run-worker',
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

test('the controller and supervisors reach only their required Ofz endpoints', () => {
  const namespace = { matchLabels: { 'kubernetes.io/metadata.name': 'ofz' } }
  const database = {
    to: [{ namespaceSelector: namespace, podSelector: { matchLabels: { 'cnpg.io/cluster': 'ofz-db' } } }],
    ports: [{ protocol: 'TCP', port: 5432 }],
  }
  const targetPolicies = cutover.get('tengri')!.map((entry) => entry.toJSON() as NetworkPolicy)
  const ofzRules = (name: string) =>
    targetPolicies
      .find((policy) => policy.metadata?.name === name)
      ?.spec?.egress?.filter((rule) =>
        rule.to?.some((target) => target.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'ofz'),
      )
  expect(ofzRules('tengri-control-plane')).toEqual([
    {
      to: [{ namespaceSelector: namespace, podSelector: { matchLabels: { 'app.kubernetes.io/name': 'ofz-api' } } }],
      ports: [{ protocol: 'TCP', port: 9443 }],
    },
    database,
  ])
  expect(ofzRules('tengri-slots')).toEqual([database])
  const guest = networkPolicies.find((policy) => policy.metadata?.name === 'tengri-slots')
  const internet = guest?.spec?.egress?.flatMap((rule) => rule.to ?? []).find((target) => target.ipBlock)
  expect(internet?.ipBlock?.except).toContain('10.0.0.0/8')
  expect(internet?.ipBlock?.except).toContain('100.64.0.0/10')
})

test('the controller mounts its request key and verified-TLS database credential', () => {
  const deployment = cutoverManifest('tengri', 'Deployment', 'tengri')
  const pod = deployment.getIn(['spec', 'template', 'spec'])
  if (!isMap(pod)) throw new Error('Deployment pod spec must be a mapping')
  expect(pod.toJSON()).toMatchObject({
    securityContext: { runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532 },
    containers: [
      expect.objectContaining({
        env: expect.arrayContaining([
          { name: 'OFZ_GRPC_ENDPOINT', value: 'ofz-api.ofz.svc.cluster.local:9443' },
          { name: 'TENGRI_INTERNAL_HMAC_KEY_FILE', value: '/var/run/tengri/internal/TENGRI_INTERNAL_HMAC_SECRET' },
          {
            name: 'TENGRI_DATABASE_DSN',
            value:
              'host=ofz-db-rw.ofz.svc.cluster.local port=5432 dbname=tengri_control user=tengri_controller sslmode=require',
          },
          { name: 'TENGRI_DATABASE_PASSWORD_FILE', value: '/var/run/tengri/database/password' },
          { name: 'TENGRI_DATABASE_CA_FILE', value: '/var/run/tengri/database-ca/ca.crt' },
        ]),
        volumeMounts: expect.arrayContaining([
          { name: 'internal-request-key', mountPath: '/var/run/tengri/internal', readOnly: true },
          { name: 'database', mountPath: '/var/run/tengri/database', readOnly: true },
          { name: 'database-ca', mountPath: '/var/run/tengri/database-ca', readOnly: true },
        ]),
      }),
    ],
    volumes: expect.arrayContaining([
      { name: 'internal-request-key', secret: { secretName: 'tengri-internal-request-key', defaultMode: 0o440 } },
      { name: 'database', secret: { secretName: 'tengri-controller-db', defaultMode: 0o440 } },
      { name: 'database-ca', secret: { secretName: 'ofz-database-ca', defaultMode: 0o440 } },
    ]),
  })
  const containers = pod.get('containers')
  if (!isSeq(containers) || !isMap(containers.items[0])) throw new Error('Controller container required')
  expect(containers.items[0].get('envFrom')).toBeUndefined()
  const serialized = JSON.stringify(pod.toJSON())
  expect(serialized).not.toContain('TENGRI_AUTHZ_')
  expect(serialized).not.toContain('tengri-runtime')
  expect(serialized).not.toContain('tengri-spicedb-key')
})

test('the BFF reads the same dedicated request key contract as the controller', () => {
  const deployment = cutoverManifest('proompteng', 'Deployment', 'proompteng')
  const volumes = deployment.getIn(['spec', 'template', 'spec', 'volumes'])
  if (!isSeq(volumes)) throw new Error('BFF volumes must be explicit')
  const key = volumes.items.find((entry) => isMap(entry) && entry.get('name') === 'tengri-bff')
  if (!isMap(key)) throw new Error('BFF request key volume required')
  expect(key.getIn(['secret', 'secretName'])).toBe('tengri-internal-request-key')
  expect(key.getIn(['secret', 'defaultMode'])).toBe(288)
  expect(deployment.getIn(['spec', 'template', 'spec', 'securityContext', 'fsGroup'])).toBe(1001)
})

test('active deployments use the complete Ofz cutover contract', () => {
  for (const app of ['tengri', 'proompteng']) {
    const active = manifest(`argocd/applications/${app}/deployment.yaml`).toString()
    expect(active).toContain('OFZ_GRPC_ENDPOINT')
    expect(active).toContain('tengri-internal-request-key')
    expect(active).toContain('ofz-database-ca')
  }
})

test('the BFF cutover includes every required Ofz, identity and TLS database setting', () => {
  const deployment = cutoverManifest('proompteng', 'Deployment', 'proompteng')
  const pod = deployment.getIn(['spec', 'template', 'spec'])
  if (!isMap(pod)) throw new Error('BFF pod required')
  expect(pod.toJSON()).toMatchObject({
    containers: [
      expect.objectContaining({
        env: expect.arrayContaining([
          { name: 'OFZ_GRPC_ENDPOINT', value: 'ofz-api.ofz.svc.cluster.local:9443' },
          { name: 'TENGRI_OIDC_ISSUER', value: 'https://auth.proompteng.ai/realms/tengri' },
          { name: 'TENGRI_OIDC_CLIENT_SECRET_FILE', value: '/var/run/tengri/oidc/client-secret' },
          {
            name: 'TENGRI_DATABASE_DSN',
            value: 'postgres://tengri_bff@ofz-db-rw.ofz.svc.cluster.local:5432/tengri_control',
          },
          { name: 'TENGRI_DATABASE_PASSWORD_FILE', value: '/var/run/tengri/database/password' },
          { name: 'TENGRI_DATABASE_CA_FILE', value: '/var/run/tengri/database-ca/ca.crt' },
        ]),
        volumeMounts: expect.arrayContaining([
          { name: 'oidc', mountPath: '/var/run/tengri/oidc', readOnly: true },
          { name: 'database', mountPath: '/var/run/tengri/database', readOnly: true },
          { name: 'database-ca', mountPath: '/var/run/tengri/database-ca', readOnly: true },
        ]),
      }),
    ],
    volumes: expect.arrayContaining([
      { name: 'oidc', secret: { secretName: 'tengri-oidc-client', defaultMode: 0o440 } },
      { name: 'database', secret: { secretName: 'tengri-bff-db', defaultMode: 0o440 } },
      { name: 'database-ca', secret: { secretName: 'ofz-database-ca', defaultMode: 0o440 } },
    ]),
  })
  const policies = cutoverManifest('proompteng', 'NetworkPolicy', 'proompteng-web').toJSON() as NetworkPolicy
  for (const port of [9443, 5432, 8443]) {
    expect(policies.spec?.egress?.some((rule) => rule.ports?.some((entry) => entry.port === port))).toBe(true)
  }
})
