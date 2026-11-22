import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import YAML from 'yaml'
const root = new URL('../../../../../', import.meta.url)
const source = (file: string) => readFileSync(new URL(file, root), 'utf8')
const manifests = (file: string) => YAML.parseAllDocuments(source(file)).map((document) => document.toJSON())

test('the registered Kubernetes namespaces match the executor RBAC without granting clients cluster credentials', () => {
  const config = JSON.parse(source('argocd/applications/relay/config.json'))
  const namespaces = config.connectors
    .filter((connector: { type: string }) => connector.type === 'kubernetes')
    .flatMap((connector: { namespaces: { name: string }[] }) => connector.namespaces.map(({ name }) => name))
    .sort()
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
  expect(workflow.on).toHaveProperty('workflow_call')
  expect(workflow.on).not.toHaveProperty('merge_group')
  expect(workflow.jobs.image.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'")
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

test('queued revisions require the platform suites', () => {
  const workflow = YAML.parse(source('.github/workflows/pull-request.yml'))
  const gate = workflow.jobs['ci-pr']
  for (const [job, file] of [
    ['ofz', 'ofz.yaml'],
    ['relay', 'relay.yml'],
    ['tengri', 'tengri-validation.yml'],
  ]) {
    expect(workflow.jobs[job]).toMatchObject({
      if: "github.event_name == 'merge_group'",
      uses: `./.github/workflows/${file}`,
    })
    expect(workflow.jobs[job].needs).toBeUndefined()
    expect(gate.needs).toContain(job)
  }
  const step = gate.steps.find((entry: { name: string }) => entry.name === 'Enforce selected validation results')
  expect(step.env.OFZ_RESULT).toBe('${{ needs.ofz.result }}')
  expect(step.env.RELAY_RESULT).toBe('${{ needs.relay.result }}')
  expect(step.env.TENGRI_RESULT).toBe('${{ needs.tengri.result }}')
  const run = (full: string, ofz: string, relay: string, tengri: string) =>
    Bun.spawnSync(['bash', '-c', step.run], {
      env: {
        PATH: process.env.PATH ?? '',
        PLAN_RESULT: 'success',
        VALIDATE_RESULT: 'success',
        VALIDATE_EXPECTED: 'success',
        LANDING_RESULT: 'success',
        LANDING_EXPECTED: 'success',
        AGENTS_RESULT: 'success',
        BAYN_RESULT: 'success',
        OFZ_RESULT: ofz,
        RELAY_RESULT: relay,
        TENGRI_RESULT: tengri,
        BUF_RESULT: 'success',
        SCRIPTS_RESULT: 'success',
        TORGHUT_RESULT: 'success',
        TORGHUT_SCHEMA_RESULT: 'success',
        TORGHUT_NOTEBOOKS_RESULT: 'success',
        QUEUE_SERVICES_RESULT: 'success',
        FULL_VALIDATION: full,
        DELEGATED: '[]',
      },
    }).exitCode

  expect(run('false', 'skipped', 'skipped', 'skipped')).toBe(0)
  expect(run('true', 'success', 'success', 'success')).toBe(0)
  for (const result of ['failure', 'cancelled', 'skipped']) {
    expect(run('true', result, 'success', 'success')).toBe(1)
    expect(run('true', 'success', result, 'success')).toBe(1)
    expect(run('true', 'success', 'success', result)).toBe(1)
  }
})
