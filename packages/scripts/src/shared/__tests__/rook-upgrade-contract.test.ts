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
    updateStrategy: { type: string }
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
    { name: 'rook-ceph', version: 'v1.20.3' },
    { name: 'ceph-csi-drivers', version: '1.0.4' },
    { name: 'rook-ceph-cluster', version: 'v1.20.3' },
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
})

test('preserves the Ceph data plane and live CSI behavior after the v1.20 migration', () => {
  const operatorValues = readYaml<{
    image: { repository: string; tag: string }
    csi: Record<string, unknown>
    monitoring: { enabled: boolean }
    'ceph-csi-operator'?: unknown
  }>('argocd/applications/rook-ceph/operator-values.yaml')
  const clusterValues = readYaml<{
    cephImage: { repository: string; tag: string }
    cephClusterSpec: {
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

  expect(operatorValues.image).toMatchObject({ repository: 'docker.io/rook/ceph', tag: 'v1.20.3' })
  expect(operatorValues.csi).toEqual({ installCsiOperator: true })
  expect(operatorValues.monitoring.enabled).toBe(true)
  expect(operatorValues['ceph-csi-operator']).toBeUndefined()
  expect(clusterValues.cephImage).toMatchObject({
    repository: 'quay.io/ceph/ceph',
    tag: 'v20.2.2-20260616',
  })
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
    expect(driver.nodePlugin.updateStrategy.type).toBe('OnDelete')
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

test('removes the temporary legacy CSI identity bridge after every OnDelete pod is rolled', () => {
  const kustomization = readYaml<Kustomization>('argocd/applications/rook-ceph/kustomization.yaml')

  expect(kustomization.resources).not.toContain('csi-legacy-service-account-bridge.yaml')
  expect(existsSync(new URL('argocd/applications/rook-ceph/csi-legacy-service-account-bridge.yaml', repoRoot))).toBe(
    false,
  )
})
