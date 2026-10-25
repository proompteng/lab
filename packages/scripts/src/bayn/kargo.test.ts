import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const root = new URL('../../../../', import.meta.url)
const read = (path: string) => YAML.parse(readFileSync(new URL(path, root), 'utf8'))
const stages = YAML.parseAllDocuments(readFileSync(new URL('argocd/applications/kargo/stages.yaml', root), 'utf8'))
const stage = stages.find((document) => document.getIn(['metadata', 'name']) === 'bayn')?.toJSON()
const steps = stage.spec.promotionTemplate.spec.steps
const build = read('.github/workflows/bayn-build-push.yml')

test('installs error-tracking configuration before every runtime that consumes it', () => {
  const config = read('argocd/applications/bayn/glitchtip-dsns.yaml')
  expect(config.kind).toBe('ConfigMap')
  expect(read('argocd/applications/bayn/kustomization.yaml').resources).toContain('glitchtip-dsns.yaml')
  const configWave = Number(config.metadata.annotations?.['argocd.argoproj.io/sync-wave'] ?? 0)
  for (const file of ['deployment', 'execution-controller', 'execution-activation', 'research-worker']) {
    const runtime = read(`argocd/applications/bayn/${file}.yaml`)
    const reference = runtime.spec.template.spec.containers[0].env.find(
      (entry: { name: string }) => entry.name === 'BAYN_GLITCHTIP_DSN',
    ).valueFrom.configMapKeyRef
    expect(reference.name).toBe(config.metadata.name)
    expect(Object.hasOwn(config.data, reference.key)).toBe(true)
    expect(configWave).toBeLessThan(Number(runtime.metadata.annotations?.['argocd.argoproj.io/sync-wave'] ?? 0))
  }
})

test('a newer unpublished main commit cannot hold a verified Bayn image or mix its source binding', () => {
  const warehouses = YAML.parseAllDocuments(
    readFileSync(new URL('argocd/applications/kargo/warehouses.yaml', root), 'utf8'),
  )
  const warehouse = warehouses.find((document) => document.getIn(['metadata', 'name']) === 'bayn')?.toJSON()
  expect(warehouse.spec.subscriptions.some((subscription: { git?: unknown }) => subscription.git !== undefined)).toBe(
    false,
  )
  expect(steps[0].config.checkout[0].commit).toBe(
    "${{ imageFrom(vars.imageRepo).Annotations['org.opencontainers.image.revision'] }}",
  )
  expect(JSON.stringify(steps)).not.toContain('commitFrom(vars.gitRepo)')
})

test('delivers the sealed Jev credential only to the worker without blocking independent recovery when absent', () => {
  const secret = read('argocd/applications/bayn/jev-sealedsecret.yaml')
  expect(secret.metadata).toMatchObject({
    name: 'bayn-jev-auth',
    namespace: 'bayn',
    annotations: {
      'argocd.argoproj.io/sync-wave': '-2',
      'argocd.proompteng.ai/wait-for-sealed-secret': 'true',
    },
  })
  expect(Object.keys(secret.spec.encryptedData)).toEqual(['api-key'])
  expect(secret.spec.encryptedData['api-key'].length).toBeGreaterThan(100)
  expect(read('argocd/applications/bayn/kustomization.yaml').resources).toContain('jev-sealedsecret.yaml')
  for (const file of ['deployment', 'execution-controller', 'execution-activation']) {
    const environment = read(`argocd/applications/bayn/${file}.yaml`).spec.template.spec.containers[0].env
    const key = environment.filter((entry: { name: string }) => entry.name === 'BAYN_JEV_API_KEY')
    expect(key).toEqual(
      file === 'execution-controller'
        ? [
            {
              name: 'BAYN_JEV_API_KEY',
              valueFrom: { secretKeyRef: { name: 'bayn-jev-auth', key: 'api-key', optional: true } },
            },
          ]
        : [],
    )
    const brokerKeys = environment.filter((entry: { name: string }) =>
      ['BAYN_ALPACA_KEY_ID', 'BAYN_ALPACA_SECRET_KEY'].includes(entry.name),
    )
    expect(brokerKeys).toHaveLength(2)
    expect(
      brokerKeys.every(
        (entry: { valueFrom: { secretKeyRef: { optional?: boolean } } }) =>
          entry.valueFrom.secretKeyRef.optional !== true,
      ),
    ).toBe(true)
  }
})

test('binds PAPER authority to the sealed strategy and lineage, or requires explicit OBSERVE', () => {
  const secret = read('argocd/applications/bayn/alpaca-sealedsecret.yaml')
  const encodedIdentity = secret.metadata.annotations?.['proompteng.ai/bayn.mandate-identity']
  const request = secret.spec.encryptedData['capital-activation-request']
  if (request === undefined) {
    expect(encodedIdentity).toBeUndefined()
    expect(steps.some((step: { uses: string; as?: string }) => step.uses === 'yaml-parse' && step.as === 'bayn')).toBe(
      false,
    )
    for (const file of ['deployment', 'execution-controller', 'execution-activation']) {
      const environment = read(`argocd/applications/bayn/${file}.yaml`).spec.template.spec.containers[0].env
      expect(
        environment.filter((entry: { name: string }) =>
          [
            'BAYN_CAPITAL_ACTIVATION_REQUEST',
            'BAYN_CAPITAL_ACTIVATION_KIND',
            'BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE',
          ].includes(entry.name),
        ),
      ).toEqual([])
      expect(environment.find((entry: { name: string }) => entry.name === 'BAYN_BROKER_ACCESS')?.value).toBe(
        'read-only',
      )
      expect(environment.find((entry: { name: string }) => entry.name === 'BAYN_CAPITAL_AUTHORITY')?.value).toBe('none')
    }
    return
  }
  expect(typeof encodedIdentity).toBe('string')
  const identity = JSON.parse(encodedIdentity)
  expect(identity.ciphertextHash).toBe(
    createHash('sha256').update(secret.spec.encryptedData['capital-activation-request']).digest('hex'),
  )
  const nix = readFileSync(new URL('nix/images/bayn.nix', root), 'utf8')
  for (const [field, constant] of [
    ['name', 'strategyName'],
    ['behaviorHash', 'strategyBehaviorHash'],
    ['parameterHash', 'strategyParameterHash'],
    ['protocolHash', 'strategyProtocolHash'],
  ]) {
    const matches = [...nix.matchAll(new RegExp(`^  ${constant} = "([^"]+)";`, 'gm'))]
    expect(matches).toHaveLength(1)
    expect(identity.strategy[field]).toBe(matches[0]?.[1])
  }
  for (const file of ['deployment', 'execution-controller', 'execution-activation']) {
    const environment = read(`argocd/applications/bayn/${file}.yaml`).spec.template.spec.containers[0].env
    const lineage = JSON.parse(
      environment.find((entry: { name: string }) => entry.name === 'BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE').value,
    )
    expect(lineage.requestHash).toBe(identity.requestHash)
    expect(lineage.authoredActivation).toEqual(identity.authoredActivation)
  }
})

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

test('discovers only immutable main-published Bayn images with matching source annotations', () => {
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
  expect(build.jobs.image.with.publish_on_dispatch).toBe(false)
  expect(build.on.push.paths).toEqual(
    expect.arrayContaining(['services/bayn/**', 'nix/images/bayn.nix', 'argocd/applications/bayn/**']),
  )
  expect(warehouse.spec.subscriptions).toHaveLength(1)
  expect(warehouse.spec.subscriptions[0].image).toMatchObject({
    repoURL: 'registry.ide-newton.ts.net/lab/bayn',
    imageSelectionStrategy: 'NewestBuild',
    allowTagsRegexes: ['^kargo-sha-[0-9a-f]{40}$'],
    cacheByTag: true,
  })
  const image = "imageFrom('registry.ide-newton.ts.net/lab/bayn')"
  expect(warehouse.spec.freightCreationCriteria.expression).toContain(
    `${image}.Tag == 'kargo-sha-' + ${image}.Annotations['org.opencontainers.image.revision']`,
  )
  expect(warehouse.spec.freightCreationCriteria.expression).toContain(
    `${image}.Annotations['org.opencontainers.image.source'] == 'https://github.com/proompteng/lab'`,
  )
})

test('writes source, digest, and research lineage into the correct field in every runtime', () => {
  const lineageValues: string[] = []
  for (const file of ['deployment', 'execution-controller', 'execution-activation']) {
    const path = `argocd/applications/bayn/${file}.yaml`
    const manifest = read(path)
    const environment = manifest.spec.template.spec.containers[0].env
    const updates = steps.filter(
      (step: { uses: string; config: { path: string } }) =>
        step.uses === 'yaml-update' && step.config.path === `./out/${path}`,
    )
    const update = updates.find((step: { if?: string }) => step.if === undefined)
    expect(update).toBeDefined()
    const configuredLineage = environment.some(
      (entry: { name: string }) => entry.name === 'BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE',
    )
    const assignments = new Map<string, string>()
    for (const change of updates
      .filter((step: { if?: string }) => step.if === undefined || configuredLineage)
      .flatMap((step: { config: { updates: { key: string; value: string }[] } }) => step.config.updates)) {
      if (!change.key.includes('spec.template.spec.containers.0.env.')) continue
      const match =
        /^\$\{\{ 'spec\.template\.spec\.containers\.0\.env\.' \+ string\(outputs\.(\w+)\.(\w+)\) \+ '\.value' \}\}$/.exec(
          change.key,
        )
      if (match === null) throw new Error(`Environment update must resolve its named source field: ${change.key}`)
      const parse = steps.find(
        (step: { uses: string; as?: string }) => step.uses === 'yaml-parse' && step.as === match[1],
      )
      expect(parse.config.path).toBe(`./src/${path}`)
      expect(steps.indexOf(parse)).toBeLessThan(steps.indexOf(update))
      const output = parse.config.outputs.find((candidate: { name: string }) => candidate.name === match[2])
      const field = /^string\(findIndex\(spec\.template\.spec\.containers\[0\]\.env, \.name == '(\w+)'\)\)$/.exec(
        output.fromExpression,
      )
      if (field === null)
        throw new Error(`Environment index must persist as a string resolved by name: ${output.fromExpression}`)
      expect(environment.filter((entry: { name: string }) => entry.name === field[1])).toHaveLength(1)
      assignments.set(field[1], change.value)
    }
    expect(assignments.get('BAYN_CODE_REVISION')).toBe(
      "${{ imageFrom(vars.imageRepo).Annotations['org.opencontainers.image.revision'] }}",
    )
    expect(assignments.get('BAYN_IMAGE_DIGEST')).toBe('${{ imageFrom(vars.imageRepo).Digest }}')
    const lineage = assignments.get('BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE')
    expect(typeof lineage).toBe(configuredLineage ? 'string' : 'undefined')
    if (lineage) lineageValues.push(lineage)
    expect(assignments.has('BAYN_BROKER_ACCESS')).toBe(false)
    expect(assignments.has('BAYN_CAPITAL_AUTHORITY')).toBe(false)
    expect(assignments.has('BAYN_CAPITAL_ACTIVATION_REQUEST')).toBe(false)
    expect(assignments.has('BAYN_GLITCHTIP_DSN')).toBe(false)
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
      expect(
        environment.find((entry: { name: string }) => entry.name === 'BAYN_EXECUTION_ACTIVATION_ATTEMPT_ID'),
      ).toEqual({
        name: 'BAYN_EXECUTION_ACTIVATION_ATTEMPT_ID',
        valueFrom: {
          fieldRef: { apiVersion: 'v1', fieldPath: "metadata.labels['batch.kubernetes.io/controller-uid']" },
        },
      })
      expect(assignments.has('BAYN_EXECUTION_ACTIVATION_ATTEMPT_ID')).toBe(false)
    }
  }
  const hasMandate =
    read('argocd/applications/bayn/alpaca-sealedsecret.yaml').spec.encryptedData['capital-activation-request'] !==
    undefined
  expect(lineageValues).toHaveLength(hasMandate ? 3 : 0)
  expect(new Set(lineageValues).size).toBe(hasMandate ? 1 : 0)
})

test('OBSERVE-only source skips mandate lookup and updates while retaining all image bindings', () => {
  const lineageParse = steps.find((step: { as?: string }) => step.as === 'baynLineage')
  expect(lineageParse.if).toBe('${{ outputs.baynDeployment.hasLineage }}')
  for (const [file, owner] of [
    ['deployment', 'baynDeployment'],
    ['execution-controller', 'baynController'],
    ['execution-activation', 'baynActivation'],
  ]) {
    const source = read(`argocd/applications/bayn/${file}.yaml`)
    const environment = source.spec.template.spec.containers[0].env.filter(
      (entry: { name: string }) =>
        ![
          'BAYN_CAPITAL_ACTIVATION_REQUEST',
          'BAYN_CAPITAL_ACTIVATION_KIND',
          'BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE',
        ].includes(entry.name),
    )
    expect(
      environment.findIndex((entry: { name: string }) => entry.name === 'BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE'),
    ).toBe(-1)
    const updates = steps.filter(
      (step: { uses: string; config: { path: string } }) =>
        step.uses === 'yaml-update' && step.config.path === `./out/argocd/applications/bayn/${file}.yaml`,
    )
    const lineageUpdate = updates.find((step: { if?: string }) => step.if !== undefined)
    expect(lineageUpdate.if).toBe('${{ outputs.' + owner + '.hasLineage }}')
    const parse = steps.find((step: { as?: string }) => step.as === owner)
    expect(parse.config.outputs).toContainEqual({
      name: 'hasLineage',
      fromExpression: "any(spec.template.spec.containers[0].env, .name == 'BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE')",
    })
    expect(lineageUpdate.config.updates).toHaveLength(1)
    const imageUpdate = updates.find((step: { if?: string }) => step.if === undefined)
    expect(imageUpdate.config.updates.some((change: { key: string }) => change.key.includes('.sourceIndex'))).toBe(true)
    expect(imageUpdate.config.updates.some((change: { key: string }) => change.key.includes('.digestIndex'))).toBe(true)
    expect(imageUpdate.config.updates.some((change: { key: string }) => change.key.includes('.lineageIndex'))).toBe(
      false,
    )
  }
})

test.each([
  '231623095676dfd33097df91c6ca8406ebabeedd',
  `012345678901${'a'.repeat(28)}`,
  `1234567890e2${'b'.repeat(28)}`,
])('keeps activation version labels as YAML strings for revision %s', (revision) => {
  const activation = steps.find(
    (step: { uses: string; if?: string; config: { path: string } }) =>
      step.uses === 'yaml-update' &&
      step.if === undefined &&
      step.config.path === './out/argocd/applications/bayn/execution-activation.yaml',
  )
  const labels = activation.config.updates.filter((update: { key: string }) =>
    update.key.endsWith('labels.app\\.kubernetes\\.io/version'),
  )
  expect(labels).toHaveLength(2)
  for (const update of labels) {
    const expanded = update.value.replace(
      "${{ imageFrom(vars.imageRepo).Annotations['org.opencontainers.image.revision'][0:12] }}",
      revision.slice(0, 12),
    )
    const rendered = YAML.parse(`version: ${expanded}`).version
    expect(typeof rendered).toBe('string')
    expect(rendered).toBe(`sha-${revision.slice(0, 12)}`)
  }
})
