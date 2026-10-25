import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import YAML from 'yaml'
const root = new URL('../../../../../', import.meta.url)
const source = (file: string) => readFileSync(new URL(file, root), 'utf8')
const manifests = (file: string) => YAML.parseAllDocuments(source(file)).map((document) => document.toJSON())

test('the registered Kubernetes namespaces match the executor RBAC without granting clients cluster credentials', () => {
  const config = JSON.parse(source('argocd/applications/relay/config.json'))
  const namespaces = config.connectors[0].namespaces.map((namespace: { name: string }) => namespace.name).sort()
  const rbac = manifests('argocd/applications/relay/rbac.yaml')
  expect(
    rbac
      .filter((resource) => resource.kind === 'Role')
      .map((resource) => resource.metadata.namespace)
      .sort(),
  ).toEqual(namespaces)
  for (const role of rbac.filter((resource) => resource.kind === 'Role')) {
    expect(role.rules).toEqual([
      { apiGroups: [''], resources: ['pods', 'events'], verbs: ['get', 'list'] },
      { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
    ])
  }
  const namespaceRole = rbac.find((resource) => resource.kind === 'ClusterRole')
  namespaceRole.rules[0].resourceNames.sort()
  expect(namespaceRole.rules).toEqual([
    { apiGroups: [''], resources: ['namespaces'], resourceNames: namespaces, verbs: ['get'] },
  ])
  for (const binding of rbac.filter((resource) => resource.kind.endsWith('Binding')))
    expect(binding.subjects).toEqual([{ kind: 'ServiceAccount', name: 'relay', namespace: 'relay' }])
  const development = manifests('argocd/applications/opencode/server.yaml').find(
    (resource) => resource.kind === 'Deployment',
  )
  expect(development.spec.template.spec.serviceAccountName).toBe('opencode')
  expect(development.spec.template.spec.automountServiceAccountToken).toBe(false)
  expect(development.spec.template.spec.volumes.some((volume: { projected?: unknown }) => volume.projected)).toBe(false)
  const research = manifests('argocd/applications/opencode/research.yaml').find(
    (resource) => resource.kind === 'Deployment',
  )
  expect(research.spec.template.spec.volumes.some((volume: { csi?: unknown }) => volume.csi)).toBe(false)
  const registry = JSON.parse(source('services/ofz/platform/services.json'))
  expect(registry.services.find((service: { id: string }) => service.id === 'opencode').identities).toEqual([
    'spiffe://proompteng.ai/ns/opencode/sa/opencode',
  ])
  expect(registry.services.some((service: { id: string }) => service.id === 'opencode-research')).toBe(false)
})

test('the platform release validates both clients before publishing its immutable image', () => {
  const workflow = YAML.parse(source('.github/workflows/relay.yml'))
  expect(workflow.on.push.branches).toEqual(['main'])
  expect(workflow.jobs.image.needs).toBe('validate')
  expect(workflow.jobs.image.with.publish_kargo_tag).toBe(true)
  const checks = workflow.jobs.validate.steps.map((step: { run?: string }) => step.run || '').join('\n')
  expect(checks).toContain('bash services/ofz/test-control.sh platform')
  expect(checks).toContain('bash services/relay/test-client.sh')
  const onboarding = YAML.parse(source('argocd/applications/ofz/control-plane/policies.yaml'))
  expect(onboarding.spec.template.spec.containers[0].args).toEqual(['onboard-policies'])
  expect(onboarding.spec.template.spec.serviceAccountName).toBe('ofz-migrator')
  expect(onboarding.metadata.annotations['argocd.argoproj.io/hook']).toBe('PostSync')
})
