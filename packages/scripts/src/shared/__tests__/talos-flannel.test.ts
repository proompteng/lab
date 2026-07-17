import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

const manifestPath = 'devices/galactic/manifests/flannel-v0.28.5-mtu1400.yaml'
const cniPatchPath = 'devices/galactic/manifests/custom-flannel-cni.patch.yaml'
const cniPatch = YAML.parse(readFileSync(cniPatchPath, 'utf8')) as {
  cluster?: { network?: { cni?: { name?: string; urls?: string[] } } }
}
const resources = YAML.parseAllDocuments(readFileSync(manifestPath, 'utf8')).map((document) =>
  document.toJSON(),
) as Array<{
  apiVersion?: string
  kind?: string
  metadata?: { annotations?: Record<string, string>; name?: string; namespace?: string }
  data?: Record<string, string>
  spec?: {
    template?: {
      spec?: {
        containers?: Array<{ env?: Array<{ name?: string; value?: string | number }>; image?: string; name?: string }>
        initContainers?: Array<{ image?: string; name?: string }>
      }
    }
  }
}>

const resource = (kind: string, name: string) => {
  const found = resources.find((candidate) => candidate.kind === kind && candidate.metadata?.name === name)
  if (!found) throw new Error(`Missing ${kind}/${name} in ${manifestPath}`)
  return found
}

describe('Talos-owned custom Flannel manifest', () => {
  it('pins Talos custom CNI ownership to the immutable manifest commit', () => {
    const cni = cniPatch.cluster?.network?.cni

    expect(cni?.name).toBe('custom')
    expect(cni?.urls).toEqual([
      'https://raw.githubusercontent.com/proompteng/lab/15f59fd037dd45ecd79cf69031215d1e79b6b479/devices/galactic/manifests/flannel-v0.28.5-mtu1400.yaml',
    ])
    expect(cni?.urls?.[0]).toMatch(/\/proompteng\/lab\/[0-9a-f]{40}\//)
  })

  it('contains the complete Talos Flannel resource set without a Namespace', () => {
    expect(resources.map(({ kind, metadata }) => `${kind}/${metadata?.name}`)).toEqual([
      'ClusterRole/flannel',
      'ClusterRoleBinding/flannel',
      'ServiceAccount/flannel',
      'ConfigMap/kube-flannel-cfg',
      'DaemonSet/kube-flannel',
    ])
    expect(resources.some(({ kind }) => kind === 'Namespace')).toBe(false)
  })

  it('sets only the required pod MTU while retaining Talos VXLAN defaults', () => {
    const configMap = resource('ConfigMap', 'kube-flannel-cfg')
    const cni = JSON.parse(configMap.data?.['cni-conf.json'] ?? '{}') as {
      plugins?: Array<{ delegate?: { hairpinMode?: boolean; isDefaultGateway?: boolean; mtu?: number }; type?: string }>
    }
    const network = JSON.parse(configMap.data?.['net-conf.json'] ?? '{}') as {
      Backend?: { Port?: number; Type?: string }
      Network?: string
    }

    expect(configMap.metadata?.namespace).toBe('kube-system')
    expect(configMap.metadata?.annotations).toBeUndefined()
    expect(cni.plugins?.[0]).toEqual({
      type: 'flannel',
      delegate: { hairpinMode: true, isDefaultGateway: true, mtu: 1400 },
    })
    expect(cni.plugins?.[1]?.type).toBe('portmap')
    expect(network).toEqual({ Network: '10.244.0.0/16', Backend: { Type: 'vxlan', Port: 4789 } })
  })

  it('pins the Talos 1.13.6 Flannel image and preserves the KubePrism endpoint', () => {
    const daemonSet = resource('DaemonSet', 'kube-flannel')
    const podSpec = daemonSet.spec?.template?.spec
    const flannel = podSpec?.containers?.find(({ name }) => name === 'kube-flannel')
    const installConfig = podSpec?.initContainers?.find(({ name }) => name === 'install-config')
    const environment = Object.fromEntries(flannel?.env?.map(({ name, value }) => [name, String(value)]) ?? [])

    expect(flannel?.image).toBe('ghcr.io/siderolabs/flannel:v0.28.5')
    expect(installConfig?.image).toBe('ghcr.io/siderolabs/flannel:v0.28.5')
    expect(environment.KUBERNETES_SERVICE_HOST).toBe('127.0.0.1')
    expect(environment.KUBERNETES_SERVICE_PORT).toBe('7445')
  })
})
