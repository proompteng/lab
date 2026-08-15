import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')
const readManifest = (path: string): Record<string, any> => YAML.parse(readRepoFile(path))

test('Bayn owns a protected two-instance synchronous CNPG cluster', () => {
  const cluster = readManifest('argocd/applications/bayn/postgres-cluster.yaml')

  expect(cluster.metadata.name).toBe('bayn-db')
  expect(cluster.metadata.annotations['argocd.argoproj.io/sync-options']).toBe('Prune=false,Delete=false')
  expect(cluster.spec).toMatchObject({
    instances: 2,
    enablePDB: true,
    enableSuperuserAccess: false,
    minSyncReplicas: 1,
    maxSyncReplicas: 1,
    primaryUpdateMethod: 'switchover',
    primaryUpdateStrategy: 'unsupervised',
    affinity: {
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            {
              matchExpressions: [{ key: 'kubernetes.io/arch', operator: 'In', values: ['amd64'] }],
            },
          ],
        },
      },
      podAntiAffinityType: 'required',
      topologyKey: 'kubernetes.io/hostname',
    },
    storage: {
      storageClass: 'rook-ceph-block',
      size: '10Gi',
      resizeInUseVolumes: true,
    },
    resources: {
      requests: { cpu: '250m', memory: '512Mi' },
      limits: { cpu: '2', memory: '2Gi' },
    },
    bootstrap: {
      initdb: {
        database: 'bayn',
        owner: 'bayn_app',
        encoding: 'UTF8',
        dataChecksums: true,
      },
    },
  })
  expect(cluster.spec.imageName).toBe(
    'ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie@sha256:9287ce030c6f3ce822e383b019ae4aaf1e8370bff3b39f9c51dc10d69dc97219',
  )
})

test('Bayn compares CNPG resources after admission defaulting', () => {
  const applicationSet = readManifest('argocd/applicationsets/product.yaml')
  const elements = applicationSet.spec.generators[0].matrix.generators[1].list.elements
  const bayn = elements.find((element: { name: string }) => element.name === 'bayn')

  expect(bayn.annotations['argocd.argoproj.io/compare-options']).toBe('ServerSideDiff=true,IncludeMutationWebhook=true')
})

test('the CNPG platform installs the pinned Barman Cloud plugin', () => {
  const platform = readManifest('argocd/applications/cloudnative-pg/kustomization.yaml')
  const patches = platform.patches.map((patch: { patch: string }) => patch.patch).join('\n')
  const sidecarSecretPatch = platform.patches.find(
    (patch: { target?: { kind?: string } }) => patch.target?.kind === 'Secret',
  )
  const encodedSidecarImage = sidecarSecretPatch.patch.match(/path: \/data\/SIDECAR_IMAGE\n\s+value: (\S+)/)?.[1]

  expect(platform.resources).toContain(
    'https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.14.0/manifest.yaml',
  )
  expect(patches).toContain(
    'ghcr.io/cloudnative-pg/plugin-barman-cloud:v0.14.0@sha256:823a8893690980ba5830bbbb11196a35f695b0488db7d846abc33baebf32417c',
  )
  expect(encodedSidecarImage).toBeDefined()
  expect(Buffer.from(encodedSidecarImage ?? '', 'base64').toString('utf8')).toBe(
    'ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar:v0.14.0@sha256:9880817c285c7afa4d195da2145064d21907405489ed6ec39abe59b1feb558a4',
  )
  expect(sidecarSecretPatch.target.name).toBe('plugin-barman-cloud-f998mh5292')
  expect(sidecarSecretPatch.patch).toContain('path: /metadata/name')
  expect(sidecarSecretPatch.patch).toContain('value: plugin-barman-cloud-m5m67kfh8f')
})

test('Bayn backups use an isolated protected plugin object store and bounded schedule', () => {
  const bucket = readManifest('argocd/applications/bayn/objectbucketclaim.yaml')
  const objectStore = readManifest('argocd/applications/bayn/postgres-objectstore.yaml')
  const cluster = readManifest('argocd/applications/bayn/postgres-cluster.yaml')
  const schedule = readManifest('argocd/applications/bayn/postgres-scheduled-backup.yaml')
  const kustomization = readManifest('argocd/applications/bayn/kustomization.yaml')
  const restoreRunbook = readRepoFile('docs/bayn/cnpg-backup-restore.md')

  expect(bucket.metadata.name).toBe('cnpg-bayn-db')
  expect(bucket.metadata.annotations['argocd.argoproj.io/sync-options']).toBe('Prune=false,Delete=false')
  expect(bucket.spec).toEqual({ bucketName: 'cnpg-bayn', storageClassName: 'rook-ceph-bucket' })
  expect(objectStore.metadata.name).toBe('bayn-db')
  expect(objectStore.metadata.annotations['argocd.argoproj.io/sync-options']).toBe(
    'Prune=false,Delete=false,SkipDryRunOnMissingResource=true',
  )
  expect(objectStore.spec).toMatchObject({
    retentionPolicy: '14d',
    instanceSidecarConfiguration: {
      logLevel: 'info',
      retentionPolicyIntervalSeconds: 1800,
      resources: {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '512Mi' },
      },
    },
    configuration: {
      destinationPath: 's3://cnpg-bayn/',
      endpointURL: 'http://rook-ceph-rgw-objectstore.rook-ceph.svc.cluster.local:80',
      s3Credentials: {
        accessKeyId: { name: 'cnpg-bayn-db', key: 'AWS_ACCESS_KEY_ID' },
        secretAccessKey: { name: 'cnpg-bayn-db', key: 'AWS_SECRET_ACCESS_KEY' },
      },
      data: { compression: 'snappy', jobs: 1, additionalCommandArgs: ['--max-bandwidth', '8MB'] },
      wal: { compression: 'snappy', maxParallel: 2 },
    },
  })
  expect(cluster.spec.backup).toBeUndefined()
  expect(cluster.spec.plugins).toEqual([
    {
      name: 'barman-cloud.cloudnative-pg.io',
      isWALArchiver: true,
      parameters: { barmanObjectName: 'bayn-db', serverName: 'bayn-db-live' },
    },
  ])
  expect(schedule.spec).toEqual({
    schedule: '0 0 3 * * *',
    immediate: true,
    backupOwnerReference: 'cluster',
    target: 'prefer-standby',
    method: 'plugin',
    pluginConfiguration: { name: 'barman-cloud.cloudnative-pg.io' },
    cluster: { name: 'bayn-db' },
  })
  expect(kustomization.resources).toEqual(
    expect.arrayContaining([
      'objectbucketclaim.yaml',
      'postgres-objectstore.yaml',
      'postgres-cluster.yaml',
      'postgres-scheduled-backup.yaml',
    ]),
  )
  expect(restoreRunbook).toContain('name: bayn-db-proof-UTC_SUFFIX')
})

test('Bayn and its database have explicit network paths and existing CNPG telemetry', () => {
  const policies = YAML.parseAllDocuments(readRepoFile('argocd/applications/bayn/networkpolicy.yaml')).map((document) =>
    document.toJSON(),
  )
  const applicationPolicy = policies.find((policy) => policy.metadata.name === 'bayn')
  const databasePolicy = policies.find((policy) => policy.metadata.name === 'bayn-db')
  const egressProxyPolicy = policies.find((policy) => policy.metadata.name === 'bayn-egress-proxy')
  const alloy = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')

  expect(applicationPolicy.spec.egress).toContainEqual({
    to: [{ podSelector: { matchLabels: { 'cnpg.io/cluster': 'bayn-db' } } }],
    ports: [{ port: 5432, protocol: 'TCP' }],
  })
  expect(databasePolicy.spec.podSelector.matchLabels).toEqual({ 'cnpg.io/cluster': 'bayn-db' })
  expect(databasePolicy.spec.policyTypes).toEqual(['Ingress'])
  expect(databasePolicy.spec.ingress).toHaveLength(5)
  expect(databasePolicy.spec.ingress).toEqual(
    expect.arrayContaining([
      {
        from: [
          { podSelector: { matchLabels: { 'app.kubernetes.io/name': 'bayn' } } },
          { podSelector: { matchLabels: { 'app.kubernetes.io/name': 'bayn-execution-controller' } } },
        ],
        ports: [{ port: 5432, protocol: 'TCP' }],
      },
      {
        from: [{ podSelector: { matchLabels: { 'cnpg.io/cluster': 'bayn-db' } } }],
        ports: [{ port: 5432, protocol: 'TCP' }],
      },
      {
        from: [
          { podSelector: { matchLabels: { 'cnpg.io/cluster': 'bayn-db' } } },
          { ipBlock: { cidr: '10.244.0.0/31' } },
          { ipBlock: { cidr: '10.244.3.0/31' } },
          { ipBlock: { cidr: '10.244.5.0/31' } },
        ],
        ports: [{ port: 8000, protocol: 'TCP' }],
      },
      {
        from: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'cloudnative-pg' } },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'cloudnative-pg' } },
          },
        ],
        ports: [
          { port: 5432, protocol: 'TCP' },
          { port: 8000, protocol: 'TCP' },
        ],
      },
      {
        from: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'observability' } },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'observability-cluster-metrics-alloy' } },
          },
        ],
        ports: [{ port: 9187, protocol: 'TCP' }],
      },
    ]),
  )
  expect(egressProxyPolicy.spec.ingress).toContainEqual({
    from: [
      { podSelector: { matchLabels: { 'app.kubernetes.io/name': 'bayn' } } },
      { podSelector: { matchLabels: { 'app.kubernetes.io/name': 'bayn-execution-controller' } } },
    ],
    ports: [{ port: 3128, protocol: 'TCP' }],
  })
  expect(alloy).toContain('label = "cnpg.io/cluster"')
  expect(alloy).toContain('job_name        = "cnpg-postgres"')
})

test('the native Restate cutover binds one read-only controller before the status rollout', () => {
  const deployment = readManifest('argocd/applications/bayn/deployment.yaml')
  const controller = readManifest('argocd/applications/bayn/execution-controller.yaml')
  const activationDocuments = YAML.parseAllDocuments(
    readRepoFile('argocd/applications/bayn/execution-activation.yaml'),
  ).map((document) => document.toJSON())
  const activation = activationDocuments.find((manifest) => manifest.kind === 'Job')
  const activationPolicy = activationDocuments.find((manifest) => manifest.kind === 'NetworkPolicy')
  const kustomization = readManifest('argocd/applications/bayn/kustomization.yaml')
  const environment = (manifest: Record<string, any>): Map<string, Record<string, any>> =>
    new Map(manifest.spec.template.spec.containers[0].env.map((entry: Record<string, any>) => [entry.name, entry]))
  const deploymentEnvironment = environment(deployment)
  const controllerEnvironment = environment(controller)
  const activationEnvironment = environment(activation)
  const sourceRevision = 'f0769cb31805bfb869d0af0bbac4fdbf6120aab8'
  const imageDigest = 'sha256:aaace9a798c4d2332c1d46d1f43976fe2e4edb9376824554b343083a5e531526'
  const imageTag = `sha-${sourceRevision}`
  const immutableImage = `registry.ide-newton.ts.net/lab/bayn:${imageTag}@${imageDigest}`
  const sharedPlanEnvironment = [
    'BAYN_CODE_REVISION',
    'BAYN_IMAGE_REPOSITORY',
    'BAYN_IMAGE_DIGEST',
    'BAYN_STRATEGY_BEHAVIOR_HASH',
    'BAYN_STRATEGY_PARAMETER_HASH',
    'BAYN_BROKER_ACCESS',
    'BAYN_CAPITAL_AUTHORITY',
    'BAYN_AUTHORITY_GENERATION_HASH',
    'BAYN_BROKER_PROVIDER',
    'BAYN_BROKER_ENVIRONMENT',
    'BAYN_ALPACA_BASE_URL',
    'BAYN_CYCLE_POLL_INTERVAL_MS',
    'BAYN_RECONCILIATION_INTERVAL_MS',
    'BAYN_OPERATION_TIMEOUT_MS',
    'BAYN_SIGNAL_SNAPSHOT_ID',
    'BAYN_SIGNAL_PUBLICATION_ASOF',
    'BAYN_SIGNAL_CALENDAR_VERSION',
    'BAYN_SIGNAL_DATA_START',
    'BAYN_SIGNAL_DATA_END',
    'BAYN_SIGNAL_LOOKBACK_START',
    'BAYN_SIGNAL_EVALUATION_START',
    'BAYN_SIGNAL_EVALUATION_END',
    'BAYN_TIGERBEETLE_CLUSTER_ID',
    'BAYN_TIGERBEETLE_ADDRESSES',
    'BAYN_TIGERBEETLE_LEDGER',
  ]

  expect(controller.kind).toBe('RestateDeployment')
  expect(controller.metadata.annotations['argocd.argoproj.io/sync-wave']).toBe('-1')
  expect(activation.metadata.annotations).toMatchObject({
    'argocd.argoproj.io/hook': 'Sync',
    'argocd.argoproj.io/sync-wave': '0',
  })
  expect(activation.metadata.name).toBe(`bayn-execution-activate-${sourceRevision.slice(0, 12)}`)
  expect(activation.metadata.labels['app.kubernetes.io/version']).toBe(sourceRevision.slice(0, 12))
  expect(activation.spec.template.metadata.labels['app.kubernetes.io/version']).toBe(sourceRevision.slice(0, 12))
  expect(deployment.metadata.annotations['argocd.argoproj.io/sync-wave']).toBe('1')
  expect(controller.spec.template.spec.containers[0].image).toBe(immutableImage)
  expect(activation.spec.template.spec.containers[0].image).toBe(immutableImage)
  expect(kustomization.images).toEqual([
    {
      name: 'bayn-main',
      newName: 'registry.ide-newton.ts.net/lab/bayn',
      newTag: imageTag,
      digest: imageDigest,
    },
  ])

  for (const name of sharedPlanEnvironment) {
    expect(controllerEnvironment.get(name)).toEqual(activationEnvironment.get(name))
  }
  expect(controllerEnvironment.get('BAYN_CODE_REVISION')?.value).toBe(sourceRevision)
  expect(controllerEnvironment.get('BAYN_IMAGE_DIGEST')?.value).toBe(imageDigest)
  expect(controllerEnvironment.get('BAYN_BROKER_ACCESS')?.value).toBe('read-only')
  expect(controllerEnvironment.get('BAYN_CAPITAL_AUTHORITY')?.value).toBe('none')
  expect(deploymentEnvironment.get('BAYN_BROKER_ACCESS')?.value).toBe('read-only')
  expect(deploymentEnvironment.get('BAYN_CAPITAL_AUTHORITY')?.value).toBe('none')
  expect(deploymentEnvironment.get('BAYN_EXPECTED_EXECUTION_CONTROLLER_PLAN_HASH')?.value).toBe(
    '5b16569ed3b0824e589ab3fb2c2cdbe9a6216e77506732c52a6e145d06327ab7',
  )
  const previousBinding = {
    planHash: 'a21bbfccdf03ea77478141d60dff64fd0b918ba9c30ec9d0b1ba9d64c4dea9a7',
    sourceRevision: 'f66223cb1c3e95d604c6f5a579d0f364b35fae41',
  }
  expect(controllerEnvironment.get('BAYN_EXECUTION_PREVIOUS_PLAN_HASH')?.value).toBe(previousBinding.planHash)
  expect(controllerEnvironment.get('BAYN_EXECUTION_PREVIOUS_SOURCE_REVISION')?.value).toBe(
    previousBinding.sourceRevision,
  )
  expect(activationEnvironment.get('BAYN_EXECUTION_PREVIOUS_PLAN_HASH')).toEqual(
    controllerEnvironment.get('BAYN_EXECUTION_PREVIOUS_PLAN_HASH'),
  )
  expect(activationEnvironment.get('BAYN_EXECUTION_PREVIOUS_SOURCE_REVISION')).toEqual(
    controllerEnvironment.get('BAYN_EXECUTION_PREVIOUS_SOURCE_REVISION'),
  )
  expect(deploymentEnvironment.has('BAYN_EXECUTION_PREVIOUS_PLAN_HASH')).toBe(false)
  expect(deploymentEnvironment.has('BAYN_EXECUTION_PREVIOUS_SOURCE_REVISION')).toBe(false)
  expect(controllerEnvironment.has('BAYN_LEGACY_LIFECYCLE_CONTROLLER_KEY')).toBe(false)
  expect(controllerEnvironment.has('BAYN_LEGACY_LIFECYCLE_PLAN_HASH')).toBe(false)
  expect(controllerEnvironment.has('BAYN_LEGACY_LIFECYCLE_SOURCE_REVISION')).toBe(false)
  expect(activationEnvironment.get('BAYN_EXECUTION_ACTIVATION_GENERATION')?.value).toBe(
    '457d0b36483c0b6f952cf81dd85ff7774e37cc91c4e01e054a37479e63822c53',
  )
  expect(activation.spec.template.spec.automountServiceAccountToken).toBe(false)
  expect(activationPolicy.spec.egress.flatMap((rule: Record<string, any>) => rule.ports ?? [])).toEqual([
    { port: 53, protocol: 'UDP' },
    { port: 53, protocol: 'TCP' },
    { port: 8080, protocol: 'TCP' },
    { port: 4318, protocol: 'TCP' },
  ])

  for (const candidate of [controllerEnvironment, activationEnvironment, deploymentEnvironment]) {
    expect(candidate.has('BAYN_CAPITAL_ACTIVATION_REQUEST')).toBe(false)
    expect(candidate.has('BAYN_MAXIMUM_AUTHORITY')).toBe(false)
  }
  expect(kustomization.resources).toContain('execution-activation.yaml')
  expect(kustomization.resources).not.toContain('lifecycle-current.yaml')
  expect(kustomization.resources).not.toContain('lifecycle-previous.yaml')
  expect(kustomization.patches ?? []).toEqual([])

  const deploymentPorts = deployment.spec.template.spec.containers[0]?.ports ?? []
  expect(deploymentPorts.map((port: { readonly name?: string }) => port.name)).toEqual(['http'])
  expect(
    deployment.spec.template.spec.volumes?.some(
      (volume: { readonly name?: string }) => volume.name === 'bayn-lifecycle-reviewer',
    ) ?? false,
  ).toBe(false)
})
