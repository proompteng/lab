import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const root = new URL('../../../../', import.meta.url)
const read = (path: string) => YAML.parse(readFileSync(new URL(path, root), 'utf8'))
const stages = YAML.parseAllDocuments(readFileSync(new URL('argocd/applications/kargo/stages.yaml', root), 'utf8'))
const stage = stages.find((document) => document.getIn(['metadata', 'name']) === 'bayn')?.toJSON()
const steps = stage.spec.promotionTemplate.spec.steps
const build = read('.github/workflows/bayn-build-push.yml')

test('keeps the reviewed GitOps identity consistent with the image build', () => {
  // Each architecture's Nix build verifies these constants against its compiled executable.
  // Check the matching GitOps inputs in PR CI instead of introducing a promotion hold.
  const nix = readFileSync(new URL('nix/images/bayn.nix', root), 'utf8')
  const identities = [
    ['BAYN_STRATEGY_BEHAVIOR_HASH', 'strategyBehaviorHash'],
    ['BAYN_STRATEGY_PARAMETER_HASH', 'strategyParameterHash'],
    ['BAYN_STRATEGY_NAME', 'strategyName'],
    ['BAYN_STRATEGY_PROTOCOL_HASH', 'strategyProtocolHash'],
    ['BAYN_EXECUTION_RISK_POLICY_HASH', 'executionRiskPolicyHash'],
  ] as const
  const imageIdentity = new Map(
    identities.map(([environmentName, constant]) => {
      const matches = [...nix.matchAll(new RegExp(`^  ${constant} = "([^"]+)";`, 'gm'))]
      expect(matches).toHaveLength(1)
      return [environmentName, matches[0]?.[1]]
    }),
  )
  for (const file of ['deployment', 'execution-controller', 'execution-activation']) {
    const environment = new Map<string, string>(
      read(`argocd/applications/bayn/${file}.yaml`).spec.template.spec.containers[0].env.map(
        (entry: { name: string; value?: string }) => [entry.name, entry.value],
      ),
    )
    for (const [name, expected] of imageIdentity) {
      if (file === 'deployment' || name === 'BAYN_STRATEGY_BEHAVIOR_HASH' || name === 'BAYN_STRATEGY_PARAMETER_HASH') {
        expect(environment.get(name)).toBe(expected)
      }
    }
  }
})

test('correlates automatic Bayn Freight with the exact immutable build inputs', () => {
  const warehouses = YAML.parseAllDocuments(
    readFileSync(new URL('argocd/applications/kargo/warehouses.yaml', root), 'utf8'),
  )
  const warehouse = warehouses.find((document) => document.getIn(['metadata', 'name']) === 'bayn')?.toJSON()
  expect(build.on.push.branches).toEqual(['main'])
  expect(build.concurrency['cancel-in-progress']).toBe(false)
  expect(build.jobs.image.with).toMatchObject({
    publish_kargo_tag: true,
    source_revision: '${{ github.sha }}',
    tag: 'sha-${{ github.sha }}',
  })
  const paths = build.on.push.paths.map((path: string) => path.replace(/\/\*\*$/, ''))
  expect(warehouse.spec.subscriptions[0].git.includePaths).toEqual(
    paths.map((path: string) => (path.includes('*') ? `glob:${path}` : path)),
  )
})

test('writes source, digest, and research lineage into the correct field in every runtime', () => {
  const lineageValues: string[] = []
  for (const file of ['deployment', 'execution-controller', 'execution-activation']) {
    const path = `argocd/applications/bayn/${file}.yaml`
    const manifest = read(path)
    const environment = manifest.spec.template.spec.containers[0].env
    const update = steps.find(
      (step: { uses: string; config: { path: string } }) =>
        step.uses === 'yaml-update' && step.config.path === `./out/${path}`,
    )
    const assignments = new Map<string, string>()
    for (const change of update.config.updates) {
      const match = /^spec\.template\.spec\.containers\.0\.env\.(\d+)\.value$/.exec(change.key)
      if (match) assignments.set(environment[Number(match[1])].name, change.value)
    }
    expect(assignments.get('BAYN_CODE_REVISION')).toBe('${{ commitFrom(vars.gitRepo).ID }}')
    expect(assignments.get('BAYN_IMAGE_DIGEST')).toBe('${{ imageFrom(vars.imageRepo).Digest }}')
    const lineage = assignments.get('BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE')
    expect(typeof lineage).toBe('string')
    if (lineage) lineageValues.push(lineage)
    expect(assignments.has('BAYN_BROKER_ACCESS')).toBe(false)
    expect(assignments.has('BAYN_CAPITAL_AUTHORITY')).toBe(false)
    expect(assignments.has('BAYN_CAPITAL_ACTIVATION_REQUEST')).toBe(false)
    if (file !== 'deployment') {
      expect(update.config.updates).toContainEqual({
        key: 'spec.template.spec.containers.0.image',
        value: '${{ vars.imageRepo }}@${{ imageFrom(vars.imageRepo).Digest }}',
      })
    }
    if (file === 'execution-activation') {
      expect(assignments.get('BAYN_EXECUTION_ACTIVATION_GENERATION')).toBe(
        "${{ trimPrefix(imageFrom(vars.imageRepo).Digest, 'sha256:') }}",
      )
    }
  }
  expect(lineageValues).toHaveLength(3)
  expect(new Set(lineageValues).size).toBe(1)
})
