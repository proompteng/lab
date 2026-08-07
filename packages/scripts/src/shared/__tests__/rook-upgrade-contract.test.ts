import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readYaml = <T>(path: string): T => YAML.parse(readFileSync(new URL(path, repoRoot), 'utf8')) as T

type HelmChart = {
  name: string
  version: string
}

type Kustomization = {
  helmCharts: HelmChart[]
  patches: Array<{
    patch?: string
    target: {
      group: string
      version: string
      kind: string
    }
  }>
}

type Driver = {
  name: string
  enabled: boolean
  snapshotPolicy: string
  cephFsClientType: string
  nodePlugin: {
    imagePullPolicy: string
    updateStrategy: { type: string }
    topology: { domainLabels: string[] }
    resources: { plugin: { limits: { memory: string } } }
  }
  controllerPlugin: {
    hostNetwork: boolean
    replicas: number
    imagePullPolicy: string
  }
}

test('orders the Rook v1.20 CSI ownership migration before the unchanged cluster chart', () => {
  const kustomization = readYaml<Kustomization>('argocd/applications/rook-ceph/kustomization.yaml')

  expect(kustomization.helmCharts).toMatchObject([
    { name: 'rook-ceph', version: 'v1.20.3' },
    { name: 'ceph-csi-drivers', version: '1.0.4' },
    { name: 'rook-ceph-cluster', version: 'v1.19.8' },
  ])

  const csiOwnershipPatches = kustomization.patches.filter(
    ({ target }) => target.group === 'csi.ceph.io' && target.version === 'v1',
  )
  expect(csiOwnershipPatches.map(({ target }) => target.kind).sort()).toEqual(['Driver', 'OperatorConfig'])
  for (const { patch } of csiOwnershipPatches) {
    expect(YAML.parse(patch ?? '')).toEqual([
      {
        op: 'add',
        path: '/metadata/annotations',
        value: { 'argocd.argoproj.io/sync-wave': '1' },
      },
    ])
  }
})

test('preserves the Ceph data plane and live CSI behavior during the v1.20 migration', () => {
  const operatorValues = readYaml<{
    image: { repository: string; tag: string }
    csi: Record<string, unknown>
  }>('argocd/applications/rook-ceph/operator-values.yaml')
  const clusterValues = readYaml<{
    cephImage: { repository: string; tag: string }
    cephClusterSpec: { csi: { cephfs: { kernelMountOptions: string } } }
  }>('argocd/applications/rook-ceph/cluster-values.yaml')
  const driverValues = readYaml<{
    operatorConfig: {
      driverSpecDefaults: {
        clusterName: string
        cephFsClientType: string
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
  expect(clusterValues.cephImage).toMatchObject({ repository: 'quay.io/ceph/ceph', tag: 'v19.2.4' })
  expect(clusterValues.cephClusterSpec.csi.cephfs.kernelMountOptions).toBe('ms_mode=crc')
  expect(driverValues.operatorConfig.driverSpecDefaults).toMatchObject({
    clusterName: 'rook-ceph',
    cephFsClientType: 'autodetect',
    controllerPlugin: { hostNetwork: true, replicas: 2 },
  })

  for (const driver of [driverValues.drivers.rbd, driverValues.drivers.cephfs]) {
    expect(driver.enabled).toBe(true)
    expect(driver.cephFsClientType).toBe('autodetect')
    expect(driver.nodePlugin.updateStrategy.type).toBe('OnDelete')
    expect(driver.nodePlugin.imagePullPolicy).toBe('')
    expect(driver.nodePlugin.topology.domainLabels).toEqual(['kubernetes.io/hostname'])
    expect(driver.controllerPlugin).toMatchObject({ hostNetwork: true, replicas: 2, imagePullPolicy: '' })
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
