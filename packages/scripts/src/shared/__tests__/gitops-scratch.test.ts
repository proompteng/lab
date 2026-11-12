import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readYaml = (path: string) => YAML.parse(readFileSync(new URL(path, repoRoot), 'utf8'))

type Volume = { name: string; emptyDir?: { medium?: string; sizeLimit?: string } }
type Container = {
  name?: string
  env?: Array<{ name: string; value?: string }>
  volumeMounts?: Array<{ name: string; mountPath: string }>
  resources?: { requests?: { memory?: string }; limits?: { memory?: string } }
}
type Controller = Container & {
  volumes?: Volume[]
  reconcilers: { maxConcurrentReconciles?: number; warehouses: { maxConcurrentReconciles?: number } }
}

const gib = (quantity: string | undefined): number => {
  expect(quantity).toMatch(/^\d+Gi$/)
  return Number(quantity?.slice(0, -2))
}

const memoryScratch = (volumes: Volume[], names: string[]): number =>
  names.reduce((total, name) => {
    const matches = volumes.filter((volume) => volume.name === name)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.emptyDir?.medium).toBe('Memory')
    const size = gib(matches[0]?.emptyDir?.sizeLimit)
    expect(size).toBeGreaterThan(0)
    return total + size
  }, 0)

const reservedMemory = (container: Container, scratchGi: number, processGi: number) => {
  const request = gib(container.resources?.requests?.memory)
  const limit = gib(container.resources?.limits?.memory)
  expect(request).toBe(limit)
  expect(limit).toBeGreaterThanOrEqual(scratchGi + processGi)
}

test('Kargo reserves memory for retained promotion workspaces and moves Go temporary consumers together', () => {
  const applicationSet = readYaml('argocd/applicationsets/helm-apps.yaml')
  const controller = applicationSet.spec.generators[0].matrix.generators[1].list.elements.find(
    (entry: { name: string }) => entry.name === 'kargo',
  ).valuesObject.controller as Controller
  const tmp = controller.env?.filter((entry) => entry.name === 'TMPDIR')
  expect(tmp).toHaveLength(1)
  expect(tmp?.[0]?.value).toBe('/gitops-tmp')
  expect(controller.volumeMounts).toEqual([{ name: 'gitops-tmp', mountPath: '/gitops-tmp' }])
  // The chart already owns /tmp and tmp-data; appending either duplicates a rendered entry.
  expect(controller.volumes?.map((volume) => volume.name)).toEqual(['gitops-tmp'])
  const scratch = memoryScratch(controller.volumes ?? [], ['gitops-tmp'])
  expect(scratch).toBeGreaterThanOrEqual(32)
  reservedMemory(controller, scratch, 8)
  expect(controller.reconcilers.maxConcurrentReconciles ?? 4).toBe(4)
  expect(controller.reconcilers.warehouses.maxConcurrentReconciles ?? 4).toBe(4)
})

test('repo-server reserves the combined main and Helm tmpfs budget without reducing replicas', () => {
  const deployment = readYaml('argocd/applications/argocd/overlays/argocd-repo-server-deployment.yaml')
  const pod = deployment.spec.template.spec
  const container = pod.containers.find((entry: Container) => entry.name === 'argocd-repo-server') as Container
  const scratch = memoryScratch(pod.volumes ?? [], ['tmp', 'helm-working-dir'])
  reservedMemory(container, scratch, 2)
  expect(deployment.spec.replicas).toBe(2)
  expect(deployment.spec.strategy.rollingUpdate).toEqual({ maxSurge: 0, maxUnavailable: 1 })
})

test('Lovely keeps separate bounded temporary storage and reserves process headroom', () => {
  const deployment = readYaml('argocd/applications/argocd/overlays/argocd-lovely-plugin.yaml')
  const pod = deployment.spec.template.spec
  const container = pod.containers.find((entry: Container) => entry.name === 'lovely-plugin') as Container
  expect(container.volumeMounts?.filter((mount) => mount.mountPath === '/tmp')).toEqual([
    { name: 'lovely-tmp', mountPath: '/tmp' },
  ])
  expect(container.volumeMounts?.some((mount) => ['tmp', 'helm-working-dir'].includes(mount.name))).toBe(false)
  const scratch = memoryScratch(pod.volumes ?? [], ['lovely-tmp'])
  reservedMemory(container, scratch, 4)
  expect(pod.securityContext).toBeUndefined()
  expect(pod.initContainers).toBeUndefined()
})

test('repo RPC budgets cover bounded cold commands, cleanup and lock wait', () => {
  const params = readYaml('argocd/applications/argocd/overlays/argocd-cmd-params-cm.yaml').data
  const deployment = readYaml('argocd/applications/argocd/overlays/argocd-repo-server-deployment.yaml')
  const container = deployment.spec.template.spec.containers.find(
    (entry: Container) => entry.name === 'argocd-repo-server',
  ) as Container
  const seconds = (name: string) => {
    const entries = container.env?.filter((entry) => entry.name === name)
    expect(entries).toHaveLength(1)
    expect(entries?.[0]?.value).toMatch(/^\d+s$/)
    return Number(entries?.[0]?.value?.slice(0, -1))
  }
  const command = seconds('ARGOCD_EXEC_TIMEOUT')
  const cleanup = seconds('ARGOCD_EXEC_FATAL_TIMEOUT')
  expect(command).toBeGreaterThan(90)
  expect(command).toBeLessThanOrEqual(180)
  expect(cleanup).toBe(10)
  const controller = Number(params['controller.repo.server.timeout.seconds'])
  const server = Number(params['server.repo.server.timeout.seconds'])
  expect(controller).toBe(server)
  // One cold command may hold the repository lock before this request proceeds.
  expect(controller).toBeGreaterThanOrEqual(command + cleanup + 60)
  expect(controller).toBeLessThanOrEqual(300)
})

test('repo RPC ConfigMap consumers roll together when the cold-cache budget changes', () => {
  const controller = readYaml('argocd/applications/argocd/overlays/argocd-application-controller-statefulset.yaml')
  const server = readYaml('argocd/applications/argocd/overlays/argocd-server-deployment.yaml')
  const revision = 'gitops.proompteng.ai/repo-budget-revision'
  expect(controller.spec.template.metadata.annotations[revision]).toBe('cold-repo-v1')
  expect(server.spec.template.metadata.annotations[revision]).toBe(
    controller.spec.template.metadata.annotations[revision],
  )
  expect(controller.spec.template.metadata.annotations['gitops.proompteng.ai/config-revision']).toBe(
    'controller-resource-health-persist-v1',
  )
})
