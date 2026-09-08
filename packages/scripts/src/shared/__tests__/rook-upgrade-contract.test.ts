import { existsSync, readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readYaml = <T>(path: string): T => YAML.parse(readFileSync(new URL(path, repoRoot), 'utf8')) as T
type HelmChart = {
  name: string
  version: string
}

type Kustomization = {
  resources: string[]
  helmCharts: HelmChart[]
  patches: Array<{
    patch?: string
    path?: string
    target: {
      group?: string
      version: string
      kind: string
      name?: string
    }
  }>
}

type ResourceRequirements = {
  limits: { memory: string }
  requests: { cpu: string; memory: string }
}

type Driver = {
  name: string
  enabled: boolean
  grpcTimeout: number
  snapshotPolicy: string
  cephFsClientType: string
  nodePlugin: {
    imagePullPolicy: string
    updateStrategy: { type: string; rollingUpdate: { maxUnavailable: number } }
    topology: { domainLabels: string[] }
    resources: {
      liveness: ResourceRequirements
      plugin: { limits: { memory: string } }
    }
  }
  controllerPlugin: {
    hostNetwork: boolean
    replicas: number
    imagePullPolicy: string
    resources: { liveness: ResourceRequirements }
  }
}

test('keeps the Rook v1.20 operator, CSI, and cluster charts aligned', () => {
  const kustomization = readYaml<Kustomization>('argocd/applications/rook-ceph/kustomization.yaml')

  expect(kustomization.helmCharts).toMatchObject([
    { name: 'rook-ceph', version: 'v1.20.7' },
    { name: 'ceph-csi-drivers', version: '1.0.4' },
    { name: 'rook-ceph-cluster', version: 'v1.20.7' },
  ])
  expect(kustomization.resources).not.toContain('csi-legacy-service-account-bridge.yaml')

  const csiOwnershipPatches = kustomization.patches.filter(
    ({ target }) => target.group === 'csi.ceph.io' && target.version === 'v1',
  )
  expect(csiOwnershipPatches.map(({ target }) => target.kind).sort()).toEqual(['Driver', 'OperatorConfig'])
  for (const { patch } of csiOwnershipPatches) {
    expect(YAML.parse(patch ?? '')).toEqual([
      {
        op: 'add',
        path: '/metadata/annotations',
        value: { 'argocd.argoproj.io/sync-wave': '2' },
      },
    ])
  }

  const preOperatorIdentityPatches = kustomization.patches.filter(({ target }) =>
    target.name?.startsWith('rook-ceph-(cephfs|rbd)-csi-ceph-com-'),
  )
  expect(preOperatorIdentityPatches.map(({ target }) => target.kind).sort()).toEqual([
    'ClusterRole',
    'ClusterRoleBinding',
    'Role',
    'RoleBinding',
    'ServiceAccount',
  ])
  for (const { patch } of preOperatorIdentityPatches) {
    expect(YAML.parse(patch ?? '')).toEqual([
      {
        op: 'add',
        path: '/metadata/annotations',
        value: { 'argocd.argoproj.io/sync-wave': '-1' },
      },
    ])
  }

  const managerCutoverPatch = kustomization.patches.find(
    ({ target }) =>
      target.group === 'apps' && target.kind === 'Deployment' && target.name === 'ceph-csi-controller-manager',
  )
  expect(YAML.parse(managerCutoverPatch?.patch ?? '')).toMatchObject({
    spec: {
      template: {
        metadata: {
          annotations: { 'storage.proompteng.ai/csi-service-account-generation': 'normalized-v1' },
        },
      },
    },
  })

  const cephClusterPatch = kustomization.patches.find(({ target }) => target.kind === 'CephCluster')
  expect(cephClusterPatch?.path).toBe('cephcluster-osd-config-rollout.yaml')
  const cephClusterPatchResource = readYaml<{
    metadata: { annotations: { 'argocd.argoproj.io/sync-wave': string } }
  }>('argocd/applications/rook-ceph/cephcluster-osd-config-rollout.yaml')
  expect(cephClusterPatchResource).toMatchObject({
    metadata: {
      annotations: { 'argocd.argoproj.io/sync-wave': '3' },
    },
  })
})

test('preserves the Ceph data plane and live CSI behavior after the v1.20 migration', () => {
  const operatorValues = readYaml<{
    image: { repository: string; tag: string }
    csi: Record<string, unknown>
    monitoring?: { enabled: boolean }
    'ceph-csi-operator'?: unknown
  }>('argocd/applications/rook-ceph/operator-values.yaml')
  const clusterValues = readYaml<{
    cephImage: { repository: string; tag: string }
    monitoring: { enabled: boolean; createPrometheusRules: boolean }
    cephClusterSpec: {
      cephConfig: { rgw: { rgw_s3_auth_use_sts: string } }
      security: {
        cephx: {
          daemon: { keyRotationPolicy: string; keyGeneration: number }
          csi: {
            keyRotationPolicy: string
            keyGeneration: number
            keepPriorKeyCountMax: number
            keyType: string
          }
          rbdMirrorPeer: {
            keyRotationPolicy: string
            keyGeneration: number
            keyType: string
          }
        }
      }
      upgradeOSDRequiresHealthyPGs: boolean
      csi: { cephfs: { kernelMountOptions: string } }
    }
  }>('argocd/applications/rook-ceph/cluster-values.yaml')
  const driverValues = readYaml<{
    operatorConfig: {
      driverSpecDefaults: {
        clusterName: string
        cephFsClientType: string
        grpcTimeout: number
        controllerPlugin: { hostNetwork: boolean; replicas: number }
      }
    }
    drivers: {
      rbd: Driver
      cephfs: Driver
      nfs: { enabled: boolean }
      nvmeof: { enabled: boolean }
    }
  }>('argocd/applications/rook-ceph/csi-driver-values.yaml')

  expect(operatorValues.image).toMatchObject({ repository: 'docker.io/rook/ceph', tag: 'v1.20.7' })
  expect(operatorValues.csi).toEqual({ installCsiOperator: true })
  expect(operatorValues.monitoring?.enabled ?? false).toBe(false)
  expect(operatorValues['ceph-csi-operator']).toBeUndefined()
  expect(clusterValues.cephImage).toMatchObject({
    repository: 'quay.io/ceph/ceph',
    tag: 'v20.2.4-20260818',
  })
  expect(clusterValues.cephClusterSpec.cephConfig.rgw.rgw_s3_auth_use_sts).toBe('false')
  expect(clusterValues.cephClusterSpec.security.cephx.daemon).toEqual({
    keyRotationPolicy: 'KeyGeneration',
    keyGeneration: 2,
  })
  expect(clusterValues.cephClusterSpec.security.cephx.csi).toEqual({
    keyRotationPolicy: 'KeyGeneration',
    keyGeneration: 2,
    keepPriorKeyCountMax: 1,
    keyType: 'aes',
  })
  expect(clusterValues.cephClusterSpec.security.cephx.rbdMirrorPeer).toEqual({
    keyRotationPolicy: 'KeyGeneration',
    keyGeneration: 2,
    keyType: 'aes256k',
  })
  expect(clusterValues.monitoring).toEqual({ enabled: false, createPrometheusRules: false })
  expect(clusterValues.cephClusterSpec.upgradeOSDRequiresHealthyPGs).toBe(true)
  expect(clusterValues.cephClusterSpec.csi.cephfs.kernelMountOptions).toBe('ms_mode=crc')
  expect(driverValues.operatorConfig.driverSpecDefaults).toMatchObject({
    clusterName: 'rook-ceph',
    cephFsClientType: 'autodetect',
    grpcTimeout: 150,
    controllerPlugin: { hostNetwork: true, replicas: 2 },
  })

  for (const driver of [driverValues.drivers.rbd, driverValues.drivers.cephfs]) {
    expect(driver.enabled).toBe(true)
    expect(driver.grpcTimeout).toBe(150)
    expect(driver.cephFsClientType).toBe('autodetect')
    expect(driver.nodePlugin.updateStrategy).toEqual({
      type: 'RollingUpdate',
      rollingUpdate: { maxUnavailable: 1 },
    })
    expect(driver.nodePlugin.imagePullPolicy).toBe('')
    expect(driver.nodePlugin.topology.domainLabels).toEqual(['kubernetes.io/hostname'])
    expect(driver.controllerPlugin).toMatchObject({ hostNetwork: true, replicas: 2, imagePullPolicy: '' })
    const expectedLivenessResources = {
      limits: { memory: '256Mi' },
      requests: { cpu: '50m', memory: '128Mi' },
    }
    expect(driver.nodePlugin.resources.liveness).toEqual(expectedLivenessResources)
    expect(driver.controllerPlugin.resources.liveness).toEqual(expectedLivenessResources)
  }

  expect(driverValues.drivers.rbd).toMatchObject({
    name: 'rook-ceph.rbd.csi.ceph.com',
    snapshotPolicy: 'volumeSnapshot',
  })
  expect(driverValues.drivers.rbd.nodePlugin.resources.plugin.limits.memory).toBe('1Gi')
  expect(driverValues.drivers.cephfs).toMatchObject({
    name: 'rook-ceph.cephfs.csi.ceph.com',
    snapshotPolicy: 'volumeGroupSnapshot',
  })
  expect(driverValues.drivers.cephfs.nodePlugin.resources.plugin.limits.memory).toBe('4Gi')
  expect(driverValues.drivers.nfs.enabled).toBe(false)
  expect(driverValues.drivers.nvmeof.enabled).toBe(false)
})

test('removes the temporary legacy CSI identity bridge after CSI node plugins use rolling updates', () => {
  const kustomization = readYaml<Kustomization>('argocd/applications/rook-ceph/kustomization.yaml')

  expect(kustomization.resources).not.toContain('csi-legacy-service-account-bridge.yaml')
  expect(existsSync(new URL('argocd/applications/rook-ceph/csi-legacy-service-account-bridge.yaml', repoRoot))).toBe(
    false,
  )
})

test('runs retained storage acceptance PVCs through ordered Argo PostSync hooks', () => {
  const rookKustomization = readYaml<Kustomization>('argocd/applications/rook-ceph/kustomization.yaml')
  const acceptanceKustomization = readYaml<{ namespace: string; resources: string[] }>(
    'argocd/applications/storage-upgrade-acceptance/kustomization.yaml',
  )

  expect(rookKustomization.resources).not.toContain('storage-canary.yaml')
  expect(acceptanceKustomization).toEqual({
    apiVersion: 'kustomize.config.k8s.io/v1beta1',
    kind: 'Kustomization',
    namespace: 'rook-ceph',
    resources: ['storage-canary.yaml'],
  })
  expect(existsSync(new URL('argocd/applications/rook-ceph/storage-canary.yaml', repoRoot))).toBe(false)

  const resources = YAML.parseAllDocuments(
    readFileSync(new URL('argocd/applications/storage-upgrade-acceptance/storage-canary.yaml', repoRoot), 'utf8'),
  )
    .map((document) => document.toJSON())
    .filter(Boolean) as Array<{
    kind: string
    metadata: {
      name: string
      namespace: string
      annotations?: Record<string, string>
    }
    spec: {
      accessModes?: string[]
      activeDeadlineSeconds?: number
      annotations?: Record<string, string>
    }
  }>

  expect(resources.some(({ kind }) => kind === 'Namespace')).toBe(false)
  expect(resources.every(({ metadata }) => metadata.namespace === 'rook-ceph')).toBe(true)

  const pvcNames = resources.filter(({ kind }) => kind === 'PersistentVolumeClaim').map(({ metadata }) => metadata.name)
  expect(pvcNames).toEqual(['storage-rbd-canary', 'storage-cephfs-canary'])
  for (const pvc of resources.filter(({ kind }) => kind === 'PersistentVolumeClaim')) {
    expect(pvc.metadata.annotations).toMatchObject({
      'argocd.argoproj.io/sync-options': 'Prune=false,Delete=false',
    })
    expect(pvc.spec.accessModes).toEqual(['ReadWriteOncePod'])
  }

  const jobs = resources.filter(({ kind }) => kind === 'Job')
  expect(jobs).toHaveLength(5)
  expect(jobs.map(({ metadata }) => metadata.annotations?.['argocd.argoproj.io/hook'])).toEqual([
    'PostSync',
    'PostSync',
    'PostSync',
    'PostSync',
    'PostSync',
  ])
  expect(jobs.map(({ metadata }) => metadata.annotations?.['argocd.argoproj.io/sync-wave'])).toEqual([
    '20',
    '21',
    '20',
    '21',
    '22',
  ])
  for (const job of jobs) {
    expect(job.metadata.annotations?.['argocd.argoproj.io/hook-delete-policy']).toBe('BeforeHookCreation,HookSucceeded')
    expect(job.spec.activeDeadlineSeconds).toBe(300)
  }
})
