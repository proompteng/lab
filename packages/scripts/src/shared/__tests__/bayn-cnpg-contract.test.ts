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

test('the CNPG platform installs the pinned Barman Cloud plugin', () => {
  const platform = readManifest('argocd/applications/cloudnative-pg/kustomization.yaml')
  const patches = platform.patches.map((patch: { patch: string }) => patch.patch).join('\n')

  expect(platform.resources).toContain(
    'https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.13.0/manifest.yaml',
  )
  expect(patches).toContain(
    'ghcr.io/cloudnative-pg/plugin-barman-cloud@sha256:71589dbac582333442812b07b31f7ea4d00324a8358aac7ca507dabf9f4b6c96',
  )
  expect(patches).toContain(
    'Z2hjci5pby9jbG91ZG5hdGl2ZS1wZy9wbHVnaW4tYmFybWFuLWNsb3VkLXNpZGVjYXJAc2hhMjU2Ojk5MDM2MWFmMzMxOWY5ZTIzYWFmYTBmNmQ3OTgxZjk5YmYxZjY5YjRlNmE4NWNmMWJjN2Q3MWQ2ZjA5YmIyODg=',
  )
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
  const alloy = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')

  expect(applicationPolicy.spec.egress).toContainEqual({
    to: [{ podSelector: { matchLabels: { 'cnpg.io/cluster': 'bayn-db' } } }],
    ports: [{ port: 5432, protocol: 'TCP' }],
  })
  expect(databasePolicy.spec.podSelector.matchLabels).toEqual({ 'cnpg.io/cluster': 'bayn-db' })
  expect(databasePolicy.spec.policyTypes).toEqual(['Ingress'])
  expect(databasePolicy.spec.ingress).toHaveLength(4)
  expect(databasePolicy.spec.ingress).toEqual(
    expect.arrayContaining([
      {
        from: [{ podSelector: { matchLabels: { 'app.kubernetes.io/name': 'bayn' } } }],
        ports: [{ port: 5432, protocol: 'TCP' }],
      },
      {
        from: [{ podSelector: { matchLabels: { 'cnpg.io/cluster': 'bayn-db' } } }],
        ports: [{ port: 5432, protocol: 'TCP' }],
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
  expect(alloy).toContain('label = "cnpg.io/cluster"')
  expect(alloy).toContain('job_name        = "cnpg-postgres"')
})
