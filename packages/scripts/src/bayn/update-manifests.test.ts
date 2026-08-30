import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  baynExecutionControllerPlanHash,
  parseUpdateBaynManifestArguments,
  updateBaynManifests,
  type BaynCandidateRuntime,
  type UpdateBaynManifestOptions,
} from './update-manifests'

const currentSnapshotId = '840c75885270b349d4a992e003918ce7e6fe39730f981a20b2e88ae2db45a2e2'
const strategyBehaviorHash = '1'.repeat(64)
const strategyParameterHash = '2'.repeat(64)
const strategyName = 'opening-drive-momentum'
const strategyProtocolHash = '4'.repeat(64)
const executionRiskPolicyHash = '5'.repeat(64)
const qualificationRunId = '9'.repeat(64)
const deployedControllerPlanHash = '7'.repeat(64)
const previousControllerPlanHash = '6'.repeat(64)
const previousControllerSourceRevision = 'e'.repeat(40)
const researchRequestHash = '3'.repeat(64)
const researchBuildLineage = {
  schemaVersion: 'bayn.research-capital-build-lineage.v1',
  requestHash: researchRequestHash,
  authoredActivation: {
    sourceRevision: '0'.repeat(40),
    imageRepository: 'registry.ide-newton.ts.net/lab/bayn',
    imageDigest: `sha256:${'0'.repeat(64)}`,
  },
  activation: {
    sourceRevision: '0'.repeat(40),
    imageRepository: 'registry.ide-newton.ts.net/lab/bayn',
    imageDigest: `sha256:${'0'.repeat(64)}`,
  },
} as const
const currentBindings = {
  BAYN_SIGNAL_SNAPSHOT_ID: currentSnapshotId,
  BAYN_SIGNAL_PUBLICATION_ASOF: '2026-07-22',
  BAYN_SIGNAL_CALENDAR_VERSION: 'alpaca-us-equity-calendar-v1',
  BAYN_SIGNAL_DATA_START: '2016-01-04',
  BAYN_SIGNAL_DATA_END: '2026-07-22',
  BAYN_SIGNAL_LOOKBACK_START: '2016-01-04',
  BAYN_SIGNAL_EVALUATION_START: '2017-01-03',
  BAYN_SIGNAL_EVALUATION_END: '2026-07-22',
  BAYN_TIGERBEETLE_CLUSTER_ID: '122731676035874920802382025803517750735',
  BAYN_TIGERBEETLE_ADDRESSES:
    'ledger-0.ledger-headless.bayn.svc.cluster.local:3000,ledger-1.ledger-headless.bayn.svc.cluster.local:3000,ledger-2.ledger-headless.bayn.svc.cluster.local:3000',
  BAYN_TIGERBEETLE_LEDGER: '7001',
} as const satisfies BaynCandidateRuntime

interface FixtureOptions {
  readonly snapshotId?: string
  readonly publicationAsOf?: string
  readonly tigerBeetleClusterId?: string
  readonly tigerBeetleAddresses?: string
  readonly behaviorHash?: string
  readonly parameterHash?: string
  readonly strategyName?: string
  readonly strategyProtocolHash?: string
  readonly executionRiskPolicyHash?: string
  readonly qualificationRunId?: string | null
  readonly capitalActivationRequest?: boolean
  readonly capitalActivationKind?: 'ResearchCapitalActivationRequest' | 'ResearchCapitalBuildContinuation'
}

interface FixturePaths {
  readonly kustomizationPath: string
  readonly deploymentPath: string
  readonly applicationSetPath: string
}

let directory: string | undefined

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

const environmentBlock = (name: string, value: string): string =>
  `            - name: ${name}\n              value: ${JSON.stringify(value)}\n`

const environmentValueForTest = (manifest: string, name: string): string => {
  const match = manifest.match(new RegExp(`            - name: ${name}\\n              value: ([^\\n]+)\\n`))
  const raw = match?.[1]?.trim()
  if (raw === undefined) throw new Error(`missing ${name}`)
  return raw.startsWith('"') ? String(JSON.parse(raw)) : raw
}

const expectedActivationGeneration = (sourceSha: string, digest: string, requestHash?: string): string => {
  const binding =
    requestHash === undefined
      ? ['bayn.execution-controller-activation.v2', baynExecutionControllerPlanHash, sourceSha, digest]
      : ['bayn.execution-controller-activation.v3', baynExecutionControllerPlanHash, sourceSha, digest, requestHash]
  return createHash('sha256').update(binding.join('\0')).digest('hex')
}

const makeFixture = (options: FixtureOptions = {}): FixturePaths => {
  directory = mkdtempSync(join(tmpdir(), 'bayn-manifest-'))
  const paths = {
    kustomizationPath: join(directory, 'kustomization.yaml'),
    deploymentPath: join(directory, 'deployment.yaml'),
    applicationSetPath: join(directory, 'product.yaml'),
  }
  const bindings = {
    ...currentBindings,
    BAYN_SIGNAL_SNAPSHOT_ID: options.snapshotId ?? currentBindings.BAYN_SIGNAL_SNAPSHOT_ID,
    BAYN_SIGNAL_PUBLICATION_ASOF: options.publicationAsOf ?? currentBindings.BAYN_SIGNAL_PUBLICATION_ASOF,
    BAYN_TIGERBEETLE_CLUSTER_ID: options.tigerBeetleClusterId ?? currentBindings.BAYN_TIGERBEETLE_CLUSTER_ID,
    BAYN_TIGERBEETLE_ADDRESSES: options.tigerBeetleAddresses ?? currentBindings.BAYN_TIGERBEETLE_ADDRESSES,
  }
  const pin = options.qualificationRunId === undefined ? qualificationRunId : options.qualificationRunId
  const capitalActivationKind = options.capitalActivationKind ?? 'ResearchCapitalActivationRequest'
  const environment = [
    environmentBlock('BAYN_CODE_REVISION', '0'.repeat(40)),
    environmentBlock('BAYN_EXPECTED_EXECUTION_CONTROLLER_PLAN_HASH', deployedControllerPlanHash),
    environmentBlock('BAYN_IMAGE_REPOSITORY', 'registry.ide-newton.ts.net/lab/bayn'),
    environmentBlock('BAYN_IMAGE_DIGEST', `sha256:${'0'.repeat(64)}`),
    environmentBlock('BAYN_STRATEGY_BEHAVIOR_HASH', options.behaviorHash ?? strategyBehaviorHash),
    environmentBlock('BAYN_STRATEGY_PARAMETER_HASH', options.parameterHash ?? strategyParameterHash),
    environmentBlock('BAYN_STRATEGY_NAME', options.strategyName ?? strategyName),
    environmentBlock('BAYN_STRATEGY_PROTOCOL_HASH', options.strategyProtocolHash ?? strategyProtocolHash),
    environmentBlock('BAYN_EXECUTION_RISK_POLICY_HASH', options.executionRiskPolicyHash ?? executionRiskPolicyHash),
    pin === null ? '' : environmentBlock('BAYN_QUALIFICATION_RUN_ID', pin),
    options.capitalActivationRequest === undefined
      ? ''
      : `            - name: BAYN_CAPITAL_ACTIVATION_REQUEST\n              valueFrom:\n                secretKeyRef:\n                  name: bayn-alpaca-auth\n                  key: capital-activation-request\n`,
    options.capitalActivationRequest === undefined
      ? ''
      : environmentBlock('BAYN_CAPITAL_ACTIVATION_KIND', capitalActivationKind),
    options.capitalActivationRequest === true && capitalActivationKind === 'ResearchCapitalActivationRequest'
      ? environmentBlock('BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE', JSON.stringify(researchBuildLineage))
      : '',
    ...Object.entries(bindings).map(([name, value]) => environmentBlock(name, value)),
  ].join('')

  writeFileSync(
    paths.kustomizationPath,
    'images:\n  - name: bayn-main\n    newName: registry.ide-newton.ts.net/lab/bayn\n    newTag: bootstrap\n',
  )
  writeFileSync(
    paths.deploymentPath,
    `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: bayn\nspec:\n  template:\n    metadata:\n      annotations:\n        kubectl.kubernetes.io/restartedAt: "old"\n    spec:\n      enableServiceLinks: false\n      containers:\n        - name: bayn\n          env:\n${environment}`,
  )
  writeFileSync(
    paths.applicationSetPath,
    'elements:\n              - name: bayn\n                path: argocd/applications/bayn\n                enabled: "false"\n              - name: next\n                enabled: "true"\n',
  )
  return paths
}

const promote = (
  paths: FixturePaths,
  overrides: Partial<
    Pick<
      UpdateBaynManifestOptions,
      | 'digest'
      | 'strategyBehaviorHash'
      | 'strategyParameterHash'
      | 'candidateRuntime'
      | 'acceptedQualificationRunId'
      | 'researchLineageSourceSha'
    >
  > & { readonly useDeployedRuntime?: boolean } = {},
  sourceSha = 'a'.repeat(40),
) => {
  return updateBaynManifests({
    sourceSha,
    tag: `sha-${sourceSha}`,
    digest: overrides.digest ?? `sha256:${'b'.repeat(64)}`,
    strategyBehaviorHash: overrides.strategyBehaviorHash ?? strategyBehaviorHash,
    strategyParameterHash: overrides.strategyParameterHash ?? strategyParameterHash,
    rolloutTimestamp: '2026-07-22T10:00:00Z',
    ...(overrides.useDeployedRuntime === true
      ? {}
      : { candidateRuntime: overrides.candidateRuntime ?? currentBindings }),
    ...(overrides.acceptedQualificationRunId === undefined
      ? {}
      : { acceptedQualificationRunId: overrides.acceptedQualificationRunId }),
    ...(overrides.researchLineageSourceSha === undefined
      ? {}
      : { researchLineageSourceSha: overrides.researchLineageSourceSha }),
    ...paths,
  })
}

const installNativeExecutionManifests = (
  includeResearchBuildLineage = false,
): {
  readonly executionControllerPath: string
  readonly executionActivationPath: string
} => {
  if (directory === undefined) throw new Error('fixture directory is unavailable')
  const executionControllerPath = join(directory, 'execution-controller.yaml')
  const executionActivationPath = join(directory, 'execution-activation.yaml')
  const immutableEnvironment =
    environmentBlock('BAYN_CODE_REVISION', '0'.repeat(40)) +
    environmentBlock('BAYN_IMAGE_DIGEST', `sha256:${'0'.repeat(64)}`) +
    environmentBlock('BAYN_EXECUTION_PREVIOUS_PLAN_HASH', previousControllerPlanHash) +
    environmentBlock('BAYN_EXECUTION_PREVIOUS_SOURCE_REVISION', previousControllerSourceRevision) +
    environmentBlock('BAYN_STRATEGY_BEHAVIOR_HASH', strategyBehaviorHash) +
    environmentBlock('BAYN_STRATEGY_PARAMETER_HASH', strategyParameterHash) +
    (includeResearchBuildLineage
      ? environmentBlock('BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE', JSON.stringify(researchBuildLineage))
      : '') +
    Object.entries(currentBindings)
      .map(([name, value]) => environmentBlock(name, value))
      .join('')
  writeFileSync(
    executionControllerPath,
    `spec:\n  template:\n    spec:\n      containers:\n        - name: execution-controller\n          image: registry.ide-newton.ts.net/lab/bayn:sha-${'0'.repeat(40)}@sha256:${'0'.repeat(64)}\n          env:\n${immutableEnvironment}`,
  )
  writeFileSync(
    executionActivationPath,
    `metadata:\n  name: bayn-execution-activate-${'0'.repeat(12)}\n  labels:\n    app.kubernetes.io/version: ${'0'.repeat(12)}\nspec:\n  template:\n    metadata:\n      labels:\n        app.kubernetes.io/version: ${'0'.repeat(12)}\n    spec:\n      containers:\n        - name: activate\n          image: registry.ide-newton.ts.net/lab/bayn:sha-${'0'.repeat(40)}@sha256:${'0'.repeat(64)}\n          env:\n${environmentBlock('BAYN_EXECUTION_ACTIVATION_GENERATION', '5'.repeat(64))}${immutableEnvironment}`,
  )
  return { executionControllerPath, executionActivationPath }
}

describe('Bayn manifest promotion', () => {
  test('atomically promotes the status service, native controller, and activation Job', () => {
    const paths = makeFixture({
      qualificationRunId: null,
      capitalActivationRequest: true,
      capitalActivationKind: 'ResearchCapitalBuildContinuation',
    })
    const nativePaths = installNativeExecutionManifests()

    const result = updateBaynManifests({
      sourceSha: 'a'.repeat(40),
      tag: `sha-${'a'.repeat(40)}`,
      digest: `sha256:${'b'.repeat(64)}`,
      strategyBehaviorHash,
      strategyParameterHash,
      rolloutTimestamp: '2026-07-22T10:00:00Z',
      candidateRuntime: currentBindings,
      ...paths,
      ...nativePaths,
    })

    expect(result).toMatchObject({
      promotionAction: 'promote',
      promotionReason: 'eligible',
    })
    const deployment = readFileSync(paths.deploymentPath, 'utf8')
    const controller = readFileSync(nativePaths.executionControllerPath, 'utf8')
    const activation = readFileSync(nativePaths.executionActivationPath, 'utf8')
    for (const manifest of [deployment, controller, activation]) {
      expect(manifest).toContain(`value: ${'a'.repeat(40)}`)
      expect(manifest).toContain(`value: sha256:${'b'.repeat(64)}`)
    }
    expect(deployment).toContain(
      environmentBlock('BAYN_EXPECTED_EXECUTION_CONTROLLER_PLAN_HASH', baynExecutionControllerPlanHash).trim(),
    )
    for (const manifest of [controller, activation]) {
      expect(manifest).toContain(
        `image: registry.ide-newton.ts.net/lab/bayn:sha-${'a'.repeat(40)}@sha256:${'b'.repeat(64)}`,
      )
      expect(manifest).toContain(
        environmentBlock('BAYN_EXECUTION_PREVIOUS_PLAN_HASH', deployedControllerPlanHash).trim(),
      )
      expect(manifest).toContain(
        `- name: BAYN_EXECUTION_PREVIOUS_SOURCE_REVISION\n              value: ${'0'.repeat(40)}`,
      )
    }
    expect(activation).toContain(`name: bayn-execution-activate-${'a'.repeat(12)}`)
    expect(activation).not.toContain(environmentBlock('BAYN_EXECUTION_ACTIVATION_GENERATION', '5'.repeat(64)).trim())
    expect(environmentValueForTest(activation, 'BAYN_EXECUTION_ACTIVATION_GENERATION')).toBe(
      expectedActivationGeneration('a'.repeat(40), `sha256:${'b'.repeat(64)}`),
    )

    updateBaynManifests({
      sourceSha: 'c'.repeat(40),
      tag: `sha-${'c'.repeat(40)}`,
      digest: `sha256:${'d'.repeat(64)}`,
      strategyBehaviorHash,
      strategyParameterHash,
      rolloutTimestamp: '2026-07-23T10:00:00Z',
      candidateRuntime: currentBindings,
      ...paths,
      ...nativePaths,
    })
    for (const manifest of [
      readFileSync(nativePaths.executionControllerPath, 'utf8'),
      readFileSync(nativePaths.executionActivationPath, 'utf8'),
    ]) {
      expect(manifest).toContain(
        environmentBlock('BAYN_EXECUTION_PREVIOUS_PLAN_HASH', deployedControllerPlanHash).trim(),
      )
      expect(manifest).toContain(
        `- name: BAYN_EXECUTION_PREVIOUS_SOURCE_REVISION\n              value: ${'0'.repeat(40)}`,
      )
    }
  })

  test('promotes an explicitly authored research activation over an older deployed build', () => {
    const paths = makeFixture({ qualificationRunId: null, capitalActivationRequest: true })
    const nativePaths = installNativeExecutionManifests(true)
    if (directory === undefined) throw new Error('fixture directory is unavailable')
    const deployedDeploymentPath = join(directory, 'deployed-deployment.yaml')
    writeFileSync(deployedDeploymentPath, readFileSync(paths.deploymentPath, 'utf8'))

    const sourceSha = 'a'.repeat(40)
    const digest = `sha256:${'b'.repeat(64)}`
    const nextBehaviorHash = 'a'.repeat(64)
    const nextParameterHash = 'd'.repeat(64)
    const nextStrategyName = 'opening-drive-momentum-v2'
    const nextStrategyProtocolHash = '8'.repeat(64)
    const nextExecutionRiskPolicyHash = '7'.repeat(64)
    const nextResearchRequestHash = 'c'.repeat(64)
    writeFileSync(
      paths.deploymentPath,
      readFileSync(paths.deploymentPath, 'utf8')
        .replace(
          environmentBlock('BAYN_STRATEGY_BEHAVIOR_HASH', strategyBehaviorHash),
          environmentBlock('BAYN_STRATEGY_BEHAVIOR_HASH', nextBehaviorHash),
        )
        .replace(
          environmentBlock('BAYN_STRATEGY_PARAMETER_HASH', strategyParameterHash),
          environmentBlock('BAYN_STRATEGY_PARAMETER_HASH', nextParameterHash),
        )
        .replace(
          environmentBlock('BAYN_STRATEGY_NAME', strategyName),
          environmentBlock('BAYN_STRATEGY_NAME', nextStrategyName),
        )
        .replace(
          environmentBlock('BAYN_STRATEGY_PROTOCOL_HASH', strategyProtocolHash),
          environmentBlock('BAYN_STRATEGY_PROTOCOL_HASH', nextStrategyProtocolHash),
        )
        .replace(
          environmentBlock('BAYN_EXECUTION_RISK_POLICY_HASH', executionRiskPolicyHash),
          environmentBlock('BAYN_EXECUTION_RISK_POLICY_HASH', nextExecutionRiskPolicyHash),
        ),
    )
    for (const path of [
      paths.deploymentPath,
      nativePaths.executionControllerPath,
      nativePaths.executionActivationPath,
    ]) {
      const candidate = readFileSync(path, 'utf8')
        .replaceAll(`sha256:${'0'.repeat(64)}`, digest)
        .replaceAll('0'.repeat(40), sourceSha)
        .replaceAll(researchRequestHash, nextResearchRequestHash)
      writeFileSync(path, candidate)
    }

    const result = updateBaynManifests({
      sourceSha,
      tag: `sha-${sourceSha}`,
      digest,
      strategyBehaviorHash: nextBehaviorHash,
      strategyParameterHash: nextParameterHash,
      rolloutTimestamp: '2026-07-22T10:00:00Z',
      researchLineageSourceSha: sourceSha,
      deployedDeploymentPath,
      ...paths,
      ...nativePaths,
    })

    expect(result).toMatchObject({
      promotionAction: 'promote',
      promotionReason: 'eligible',
      qualificationMode: 'research',
      hadQualificationPin: false,
    })
    expect(readFileSync(paths.deploymentPath, 'utf8')).toContain(
      `- name: BAYN_CODE_REVISION\n              value: ${sourceSha}`,
    )
    for (const manifest of [
      readFileSync(paths.deploymentPath, 'utf8'),
      readFileSync(nativePaths.executionControllerPath, 'utf8'),
      readFileSync(nativePaths.executionActivationPath, 'utf8'),
    ]) {
      expect(manifest).toContain(environmentBlock('BAYN_STRATEGY_BEHAVIOR_HASH', nextBehaviorHash).trim())
      expect(manifest).toContain(environmentBlock('BAYN_STRATEGY_PARAMETER_HASH', nextParameterHash).trim())
    }
    expect(readFileSync(paths.deploymentPath, 'utf8')).toContain(
      environmentBlock('BAYN_EXPECTED_EXECUTION_CONTROLLER_PLAN_HASH', baynExecutionControllerPlanHash).trim(),
    )
    expect(
      environmentValueForTest(
        readFileSync(nativePaths.executionActivationPath, 'utf8'),
        'BAYN_EXECUTION_ACTIVATION_GENERATION',
      ),
    ).toBe(expectedActivationGeneration(sourceSha, digest, nextResearchRequestHash))
  })

  test('holds an authored identity change when the research request hash was not refreshed', () => {
    const paths = makeFixture({ qualificationRunId: null, capitalActivationRequest: true })
    const nativePaths = installNativeExecutionManifests(true)
    if (directory === undefined) throw new Error('fixture directory is unavailable')
    const deployedDeploymentPath = join(directory, 'deployed-deployment.yaml')
    writeFileSync(deployedDeploymentPath, readFileSync(paths.deploymentPath, 'utf8'))

    const sourceSha = 'a'.repeat(40)
    const digest = `sha256:${'b'.repeat(64)}`
    const nextStrategyName = 'opening-drive-momentum-v2'
    writeFileSync(
      paths.deploymentPath,
      readFileSync(paths.deploymentPath, 'utf8').replace(
        environmentBlock('BAYN_STRATEGY_NAME', strategyName),
        environmentBlock('BAYN_STRATEGY_NAME', nextStrategyName),
      ),
    )
    for (const path of [
      paths.deploymentPath,
      nativePaths.executionControllerPath,
      nativePaths.executionActivationPath,
    ]) {
      writeFileSync(
        path,
        readFileSync(path, 'utf8')
          .replaceAll(`sha256:${'0'.repeat(64)}`, digest)
          .replaceAll('0'.repeat(40), sourceSha),
      )
    }
    const before = [
      ...Object.values(paths),
      nativePaths.executionControllerPath,
      nativePaths.executionActivationPath,
    ].map((path) => readFileSync(path, 'utf8'))

    expect(
      updateBaynManifests({
        sourceSha,
        tag: `sha-${sourceSha}`,
        digest,
        strategyBehaviorHash,
        strategyParameterHash,
        rolloutTimestamp: '2026-07-22T10:00:00Z',
        deployedDeploymentPath,
        ...paths,
        ...nativePaths,
      }),
    ).toMatchObject({
      promotionAction: 'hold',
      promotionReason: 'research-capital-activation-refresh-required',
      qualificationMode: 'research',
    })
    expect(
      [...Object.values(paths), nativePaths.executionControllerPath, nativePaths.executionActivationPath].map((path) =>
        readFileSync(path, 'utf8'),
      ),
    ).toEqual(before)
  })

  test('promotes a freshly authored raw research request over a deployed build continuation', () => {
    const paths = makeFixture({ qualificationRunId: null, capitalActivationRequest: true })
    const nativePaths = installNativeExecutionManifests(true)
    if (directory === undefined) throw new Error('fixture directory is unavailable')
    const deployedDeploymentPath = join(directory, 'deployed-deployment.yaml')
    writeFileSync(
      deployedDeploymentPath,
      readFileSync(paths.deploymentPath, 'utf8')
        .replace(
          environmentBlock('BAYN_CAPITAL_ACTIVATION_KIND', 'ResearchCapitalActivationRequest'),
          environmentBlock('BAYN_CAPITAL_ACTIVATION_KIND', 'ResearchCapitalBuildContinuation'),
        )
        .replace(environmentBlock('BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE', JSON.stringify(researchBuildLineage)), ''),
    )

    const sourceSha = 'a'.repeat(40)
    const digest = `sha256:${'b'.repeat(64)}`
    const nextResearchRequestHash = '8'.repeat(64)
    for (const path of [
      paths.deploymentPath,
      nativePaths.executionControllerPath,
      nativePaths.executionActivationPath,
    ]) {
      writeFileSync(
        path,
        readFileSync(path, 'utf8')
          .replaceAll(`sha256:${'0'.repeat(64)}`, digest)
          .replaceAll('0'.repeat(40), sourceSha)
          .replaceAll(researchRequestHash, nextResearchRequestHash),
      )
    }

    expect(
      updateBaynManifests({
        sourceSha,
        tag: `sha-${sourceSha}`,
        digest,
        strategyBehaviorHash,
        strategyParameterHash,
        rolloutTimestamp: '2026-07-22T10:00:00Z',
        deployedDeploymentPath,
        ...paths,
        ...nativePaths,
      }),
    ).toMatchObject({
      promotionAction: 'promote',
      promotionReason: 'eligible',
      qualificationMode: 'research',
    })
  })

  test('holds an identity-changing raw request over a deployed build continuation without prior request-hash evidence', () => {
    const paths = makeFixture({ qualificationRunId: null, capitalActivationRequest: true })
    const nativePaths = installNativeExecutionManifests(true)
    if (directory === undefined) throw new Error('fixture directory is unavailable')
    const deployedDeploymentPath = join(directory, 'deployed-deployment.yaml')
    writeFileSync(
      deployedDeploymentPath,
      readFileSync(paths.deploymentPath, 'utf8')
        .replace(
          environmentBlock('BAYN_CAPITAL_ACTIVATION_KIND', 'ResearchCapitalActivationRequest'),
          environmentBlock('BAYN_CAPITAL_ACTIVATION_KIND', 'ResearchCapitalBuildContinuation'),
        )
        .replace(environmentBlock('BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE', JSON.stringify(researchBuildLineage)), ''),
    )

    const sourceSha = 'a'.repeat(40)
    const digest = `sha256:${'b'.repeat(64)}`
    const nextStrategyName = 'opening-drive-momentum-v2'
    for (const path of [
      paths.deploymentPath,
      nativePaths.executionControllerPath,
      nativePaths.executionActivationPath,
    ]) {
      writeFileSync(
        path,
        readFileSync(path, 'utf8')
          .replaceAll(`sha256:${'0'.repeat(64)}`, digest)
          .replaceAll('0'.repeat(40), sourceSha)
          .replaceAll(researchRequestHash, '8'.repeat(64))
          .replace(
            environmentBlock('BAYN_STRATEGY_NAME', strategyName),
            environmentBlock('BAYN_STRATEGY_NAME', nextStrategyName),
          ),
      )
    }
    const before = [
      ...Object.values(paths),
      nativePaths.executionControllerPath,
      nativePaths.executionActivationPath,
    ].map((path) => readFileSync(path, 'utf8'))

    expect(
      updateBaynManifests({
        sourceSha,
        tag: `sha-${sourceSha}`,
        digest,
        strategyBehaviorHash,
        strategyParameterHash,
        rolloutTimestamp: '2026-07-22T10:00:00Z',
        deployedDeploymentPath,
        ...paths,
        ...nativePaths,
      }),
    ).toMatchObject({
      promotionAction: 'hold',
      promotionReason: 'research-capital-activation-refresh-required',
      qualificationMode: 'research',
    })
    expect(
      [...Object.values(paths), nativePaths.executionControllerPath, nativePaths.executionActivationPath].map((path) =>
        readFileSync(path, 'utf8'),
      ),
    ).toEqual(before)
  })

  test('atomically advances proved research build lineage across every runtime manifest', () => {
    const paths = makeFixture({ qualificationRunId: null, capitalActivationRequest: true })
    const nativePaths = installNativeExecutionManifests(true)
    const sourceSha = 'a'.repeat(40)
    const digest = `sha256:${'b'.repeat(64)}`

    const result = updateBaynManifests({
      sourceSha,
      tag: `sha-${sourceSha}`,
      digest,
      strategyBehaviorHash,
      strategyParameterHash,
      rolloutTimestamp: '2026-07-22T10:00:00Z',
      candidateRuntime: currentBindings,
      researchLineageSourceSha: '0'.repeat(40),
      ...paths,
      ...nativePaths,
    })

    expect(result).toMatchObject({ promotionAction: 'promote', qualificationMode: 'research' })
    expect(
      environmentValueForTest(
        readFileSync(nativePaths.executionActivationPath, 'utf8'),
        'BAYN_EXECUTION_ACTIVATION_GENERATION',
      ),
    ).toBe(expectedActivationGeneration(sourceSha, digest, researchRequestHash))
    for (const manifestPath of [
      paths.deploymentPath,
      nativePaths.executionControllerPath,
      nativePaths.executionActivationPath,
    ]) {
      const lineage = JSON.parse(
        environmentValueForTest(readFileSync(manifestPath, 'utf8'), 'BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE'),
      ) as typeof researchBuildLineage
      expect(lineage.authoredActivation).toEqual(researchBuildLineage.authoredActivation)
      expect(lineage.activation).toEqual({
        sourceRevision: sourceSha,
        imageRepository: 'registry.ide-newton.ts.net/lab/bayn',
        imageDigest: digest,
      })
    }
  })

  test('rejects a research lineage proof for a different authored source without writing', () => {
    const paths = makeFixture({ qualificationRunId: null, capitalActivationRequest: true })
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

    expect(() => promote(paths, { researchLineageSourceSha: 'f'.repeat(40) })).toThrow(
      'release ancestry proof does not start at the authored research activation',
    )
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })

  test('rejects mismatched native controller and activation image bindings', () => {
    const paths = makeFixture()
    const nativePaths = installNativeExecutionManifests()
    writeFileSync(
      nativePaths.executionActivationPath,
      readFileSync(nativePaths.executionActivationPath, 'utf8').replace(
        environmentBlock('BAYN_CODE_REVISION', '0'.repeat(40)),
        environmentBlock('BAYN_CODE_REVISION', 'f'.repeat(40)),
      ),
    )

    expect(() =>
      updateBaynManifests({
        sourceSha: 'a'.repeat(40),
        tag: `sha-${'a'.repeat(40)}`,
        digest: `sha256:${'b'.repeat(64)}`,
        strategyBehaviorHash,
        strategyParameterHash,
        rolloutTimestamp: '2026-07-22T10:00:00Z',
        candidateRuntime: currentBindings,
        ...paths,
        ...nativePaths,
      }),
    ).toThrow('native execution controller and activation manifests have different immutable image bindings')
  })

  test('atomically promotes candidate runtime into the status service, controller, and activation Job', () => {
    const paths = makeFixture()
    const nativePaths = installNativeExecutionManifests()
    const candidateRuntime = {
      ...currentBindings,
      BAYN_SIGNAL_SNAPSHOT_ID: '4'.repeat(64),
      BAYN_SIGNAL_PUBLICATION_ASOF: '2026-07-23',
      BAYN_SIGNAL_CALENDAR_VERSION: 'alpaca-us-equity-calendar-v2',
      BAYN_SIGNAL_DATA_START: '2016-01-05',
      BAYN_SIGNAL_DATA_END: '2026-07-23',
      BAYN_SIGNAL_LOOKBACK_START: '2016-01-06',
      BAYN_SIGNAL_EVALUATION_START: '2017-01-04',
      BAYN_SIGNAL_EVALUATION_END: '2026-07-23',
      BAYN_TIGERBEETLE_CLUSTER_ID: '1',
      BAYN_TIGERBEETLE_ADDRESSES: 'replacement-ledger.bayn.svc.cluster.local:3000',
      BAYN_TIGERBEETLE_LEDGER: '7002',
    } satisfies BaynCandidateRuntime

    const result = updateBaynManifests({
      sourceSha: 'a'.repeat(40),
      tag: `sha-${'a'.repeat(40)}`,
      digest: `sha256:${'b'.repeat(64)}`,
      strategyBehaviorHash,
      strategyParameterHash,
      rolloutTimestamp: '2026-07-23T10:00:00Z',
      candidateRuntime,
      ...paths,
      ...nativePaths,
    })

    expect(result).toMatchObject({
      promotionAction: 'promote',
      qualificationMode: 'replace',
      snapshotChanged: true,
    })
    for (const manifest of [
      readFileSync(paths.deploymentPath, 'utf8'),
      readFileSync(nativePaths.executionControllerPath, 'utf8'),
      readFileSync(nativePaths.executionActivationPath, 'utf8'),
    ]) {
      for (const [name, value] of Object.entries(candidateRuntime)) {
        expect(manifest).toContain(environmentBlock(name, value).trim())
      }
    }
  })

  test('preserves a qualification pin only for identical strategy and runtime bindings', () => {
    const paths = makeFixture()
    const result = promote(paths)

    expect(result).toMatchObject({
      promotionAction: 'promote',
      promotionReason: 'eligible',
      qualificationMode: 'preserve',
      hadQualificationPin: true,
      qualificationBindingsMatch: true,
      snapshotChanged: false,
      deployedSnapshotId: currentSnapshotId,
      candidateSnapshotId: currentSnapshotId,
    })
    expect(readFileSync(paths.deploymentPath, 'utf8')).toContain(
      environmentBlock('BAYN_QUALIFICATION_RUN_ID', qualificationRunId).trim(),
    )
    expect(readFileSync(paths.kustomizationPath, 'utf8')).not.toContain('qualification-dossier')
    expect(readFileSync(paths.deploymentPath, 'utf8')).not.toContain('qualification-dossier')
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toContain('enabled: "true"')
  })

  test('restores the deployed qualification pin when main carries a different unaccepted pin', () => {
    const paths = makeFixture()
    if (directory === undefined) throw new Error('fixture directory is unavailable')
    const deployedDeploymentPath = join(directory, 'deployed-deployment.yaml')
    const deployed = readFileSync(paths.deploymentPath, 'utf8')
    const unacceptedRunId = '8'.repeat(64)
    writeFileSync(deployedDeploymentPath, deployed)
    writeFileSync(paths.deploymentPath, deployed.replace(qualificationRunId, unacceptedRunId))

    const result = updateBaynManifests({
      sourceSha: 'a'.repeat(40),
      tag: `sha-${'a'.repeat(40)}`,
      digest: `sha256:${'b'.repeat(64)}`,
      strategyBehaviorHash,
      strategyParameterHash,
      rolloutTimestamp: '2026-07-22T10:00:00Z',
      deployedDeploymentPath,
      ...paths,
    })

    expect(result).toMatchObject({ qualificationMode: 'preserve', candidateQualificationRunId: qualificationRunId })
    const updated = readFileSync(paths.deploymentPath, 'utf8')
    expect(updated).toContain(environmentBlock('BAYN_QUALIFICATION_RUN_ID', qualificationRunId).trim())
    expect(updated).not.toContain(unacceptedRunId)
  })

  test('removes a qualification pin added to an unqualified research release on main', () => {
    const paths = makeFixture({
      qualificationRunId: null,
      capitalActivationRequest: true,
      capitalActivationKind: 'ResearchCapitalBuildContinuation',
    })
    if (directory === undefined) throw new Error('fixture directory is unavailable')
    const deployedDeploymentPath = join(directory, 'deployed-deployment.yaml')
    const deployed = readFileSync(paths.deploymentPath, 'utf8')
    writeFileSync(deployedDeploymentPath, deployed)
    writeFileSync(
      paths.deploymentPath,
      deployed.replace(
        environmentBlock('BAYN_STRATEGY_PARAMETER_HASH', strategyParameterHash),
        environmentBlock('BAYN_STRATEGY_PARAMETER_HASH', strategyParameterHash) +
          environmentBlock('BAYN_QUALIFICATION_RUN_ID', qualificationRunId),
      ),
    )

    const result = updateBaynManifests({
      sourceSha: 'a'.repeat(40),
      tag: `sha-${'a'.repeat(40)}`,
      digest: `sha256:${'b'.repeat(64)}`,
      strategyBehaviorHash,
      strategyParameterHash,
      rolloutTimestamp: '2026-07-22T10:00:00Z',
      deployedDeploymentPath,
      ...paths,
    })

    expect(result).toMatchObject({ qualificationMode: 'research', candidateQualificationRunId: null })
    expect(readFileSync(paths.deploymentPath, 'utf8')).not.toContain('BAYN_QUALIFICATION_RUN_ID')
  })

  test('compares candidate runtime bindings with the pre-merge deployed manifest', () => {
    const paths = makeFixture()
    if (directory === undefined) throw new Error('fixture directory is unavailable')
    const deployedDeploymentPath = join(directory, 'deployed-deployment.yaml')
    const deployed = readFileSync(paths.deploymentPath, 'utf8')
    writeFileSync(deployedDeploymentPath, deployed)
    const candidateSnapshotId = '4'.repeat(64)
    writeFileSync(paths.deploymentPath, deployed.replace(currentSnapshotId, candidateSnapshotId))

    const result = updateBaynManifests({
      sourceSha: 'a'.repeat(40),
      tag: `sha-${'a'.repeat(40)}`,
      digest: `sha256:${'b'.repeat(64)}`,
      strategyBehaviorHash,
      strategyParameterHash,
      rolloutTimestamp: '2026-07-22T10:00:00Z',
      deployedDeploymentPath,
      ...paths,
    })

    expect(result).toMatchObject({
      promotionAction: 'promote',
      qualificationMode: 'replace',
      deployedSnapshotId: currentSnapshotId,
      candidateSnapshotId,
      snapshotChanged: true,
    })
    expect(readFileSync(paths.deploymentPath, 'utf8')).not.toContain('BAYN_QUALIFICATION_RUN_ID')
  })

  test('keeps the retired lifecycle bridge absent while updating native promotion fields', () => {
    const paths = makeFixture()
    promote(paths)

    const updated = readFileSync(paths.deploymentPath, 'utf8')
    expect(updated).not.toContain('BAYN_LIFECYCLE_PREVIOUS_SOURCE_REVISION')
    expect(updated).not.toContain('BAYN_LIFECYCLE_OWNER')
    expect(updated).not.toContain('lifecycle-cmd')
    expect(updated).not.toContain('bayn-lifecycle-reviewer')
    expect(updated).toContain(`- name: BAYN_CODE_REVISION\n              value: ${'a'.repeat(40)}`)
    expect(updated).toContain(`- name: BAYN_IMAGE_DIGEST\n              value: sha256:${'b'.repeat(64)}`)
  })

  test('preserves and replaces qualification using only the run-ID pin', () => {
    const paths = makeFixture()

    expect(promote(paths).qualificationMode).toBe('preserve')
    expect(readFileSync(paths.deploymentPath, 'utf8')).toContain(
      environmentBlock('BAYN_QUALIFICATION_RUN_ID', qualificationRunId).trim(),
    )
    expect(readFileSync(paths.kustomizationPath, 'utf8')).not.toContain('qualification-dossier')
    expect(readFileSync(paths.deploymentPath, 'utf8')).not.toContain('qualification-dossier')

    const freshSnapshotId = '4'.repeat(64)
    writeFileSync(
      paths.deploymentPath,
      readFileSync(paths.deploymentPath, 'utf8').replace(currentSnapshotId, freshSnapshotId),
    )

    expect(promote(paths, { strategyParameterHash: '3'.repeat(64) })).toMatchObject({
      qualificationMode: 'replace',
      hadQualificationPin: true,
      snapshotChanged: true,
      deployedSnapshotId: freshSnapshotId,
      candidateSnapshotId: currentSnapshotId,
    })
    expect(readFileSync(paths.deploymentPath, 'utf8')).not.toContain('BAYN_QUALIFICATION_RUN_ID')
    expect(readFileSync(paths.kustomizationPath, 'utf8')).not.toContain('qualification-dossier')
    expect(readFileSync(paths.deploymentPath, 'utf8')).not.toContain('qualification-dossier')
  })

  test('rejects a malformed qualification run ID before preservation', () => {
    const paths = makeFixture({ qualificationRunId: 'not-a-run-id' })
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

    expect(() => promote(paths)).toThrow('invalid deployed BAYN_QUALIFICATION_RUN_ID')
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })

  test('holds an incompatible strategy against an already-qualified snapshot without writing files', () => {
    const paths = makeFixture()
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

    expect(promote(paths, { strategyParameterHash: '3'.repeat(64) })).toMatchObject({
      promotionAction: 'hold',
      promotionReason: 'strategy-identity-change-requires-fresh-snapshot',
      qualificationMode: 'replace',
      hadQualificationPin: true,
      qualificationBindingsMatch: true,
      snapshotChanged: false,
    })
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })

  test('rejects changed runtime bindings against an already-qualified snapshot', () => {
    const paths = makeFixture({ publicationAsOf: '2026-07-19' })

    expect(() => promote(paths)).toThrow('qualification replacement requires a fresh BAYN_SIGNAL_SNAPSHOT_ID')
  })

  test('preserves qualification while restoring replica-index-ordered TigerBeetle transport addresses', () => {
    const paths = makeFixture({
      tigerBeetleAddresses: 'ledger.bayn.svc.cluster.local:3000',
    })
    const runtimeCompatibleAddresses = currentBindings.BAYN_TIGERBEETLE_ADDRESSES.replaceAll(',', ', ')

    expect(
      promote(paths, {
        candidateRuntime: {
          ...currentBindings,
          BAYN_TIGERBEETLE_ADDRESSES: runtimeCompatibleAddresses,
        },
      }),
    ).toMatchObject({
      promotionAction: 'promote',
      promotionReason: 'eligible',
      qualificationMode: 'preserve',
      qualificationBindingsMatch: true,
      snapshotChanged: false,
    })
    expect(readFileSync(paths.deploymentPath, 'utf8')).toContain(
      environmentBlock('BAYN_QUALIFICATION_RUN_ID', qualificationRunId).trim(),
    )
    expect(readFileSync(paths.deploymentPath, 'utf8')).toContain(
      environmentBlock('BAYN_TIGERBEETLE_ADDRESSES', runtimeCompatibleAddresses).trim(),
    )
  })

  test('rejects a TigerBeetle cluster identity change against an already-qualified snapshot', () => {
    const paths = makeFixture({ tigerBeetleClusterId: '2001' })

    expect(() => promote(paths)).toThrow('qualification replacement requires a fresh BAYN_SIGNAL_SNAPSHOT_ID')
  })

  test('replaces a pin for a fresh snapshot and makes an exact unpinned replay a no-op', () => {
    const paths = makeFixture({ snapshotId: '4'.repeat(64), publicationAsOf: '2026-07-19' })
    const changedParameterHash = '3'.repeat(64)
    const first = promote(paths, { strategyParameterHash: changedParameterHash })

    expect(first).toMatchObject({
      promotionAction: 'promote',
      promotionReason: 'eligible',
      qualificationMode: 'replace',
      hadQualificationPin: true,
      qualificationBindingsMatch: false,
      snapshotChanged: true,
      deployedSnapshotId: '4'.repeat(64),
      candidateSnapshotId: currentSnapshotId,
    })
    expect(readFileSync(paths.deploymentPath, 'utf8')).not.toContain('BAYN_QUALIFICATION_RUN_ID')
    expect(readFileSync(paths.deploymentPath, 'utf8')).toContain(
      environmentBlock('BAYN_SIGNAL_SNAPSHOT_ID', currentSnapshotId).trim(),
    )

    const beforeReplay = Object.values(paths).map((path) => readFileSync(path, 'utf8'))
    expect(promote(paths, { strategyParameterHash: changedParameterHash })).toMatchObject({
      promotionAction: 'promote',
      promotionReason: 'eligible',
      qualificationMode: 'replace',
      hadQualificationPin: false,
      snapshotChanged: false,
      deployedSourceSha: 'a'.repeat(40),
    })
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(beforeReplay)
  })

  test('freezes the complete unpinned candidate until its terminal run is pinned', () => {
    const paths = makeFixture({ snapshotId: '4'.repeat(64), publicationAsOf: '2026-07-19' })
    const changedParameterHash = '3'.repeat(64)
    promote(paths, { strategyParameterHash: changedParameterHash })
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))
    const secondSnapshot = {
      ...currentBindings,
      BAYN_SIGNAL_SNAPSHOT_ID: '5'.repeat(64),
      BAYN_SIGNAL_PUBLICATION_ASOF: '2026-07-23',
      BAYN_SIGNAL_DATA_END: '2026-07-23',
      BAYN_SIGNAL_EVALUATION_END: '2026-07-23',
    } satisfies BaynCandidateRuntime

    expect(() =>
      promote(paths, {
        strategyParameterHash: changedParameterHash,
        candidateRuntime: secondSnapshot,
      }),
    ).toThrow('an unpinned qualification candidate is immutable until its terminal run is pinned')
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)

    expect(() => promote(paths, { strategyParameterHash: '6'.repeat(64) })).toThrow(
      'an unpinned qualification candidate is immutable until its terminal run is pinned',
    )
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)

    expect(() =>
      promote(paths, {
        strategyParameterHash: changedParameterHash,
        digest: `sha256:${'c'.repeat(64)}`,
      }),
    ).toThrow('an unpinned qualification candidate is immutable until its terminal run is pinned')
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)

    expect(() =>
      promote(paths, {
        strategyParameterHash: changedParameterHash,
        candidateRuntime: {
          ...currentBindings,
          BAYN_TIGERBEETLE_ADDRESSES: 'different-ledger.bayn.svc.cluster.local:3000',
        },
      }),
    ).toThrow('an unpinned qualification candidate is immutable until its terminal run is pinned')
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)

    expect(() => promote(paths, { strategyParameterHash: changedParameterHash }, 'c'.repeat(40))).toThrow(
      'an unpinned qualification candidate is immutable until its terminal run is pinned',
    )
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
    expect(readFileSync(paths.deploymentPath, 'utf8')).not.toContain('BAYN_QUALIFICATION_RUN_ID')
  })

  test('keeps an unpinned qualification replay bound to the pre-merge deployed build', () => {
    const paths = makeFixture({ qualificationRunId: null })
    if (directory === undefined) throw new Error('fixture directory is unavailable')
    const deployedDeploymentPath = join(directory, 'deployed-deployment.yaml')
    const deployed = readFileSync(paths.deploymentPath, 'utf8')
    writeFileSync(deployedDeploymentPath, deployed)
    writeFileSync(
      paths.deploymentPath,
      deployed
        .replace(
          environmentBlock('BAYN_CODE_REVISION', '0'.repeat(40)),
          environmentBlock('BAYN_CODE_REVISION', 'a'.repeat(40)),
        )
        .replace(
          environmentBlock('BAYN_IMAGE_DIGEST', `sha256:${'0'.repeat(64)}`),
          environmentBlock('BAYN_IMAGE_DIGEST', `sha256:${'b'.repeat(64)}`),
        ),
    )
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

    expect(() =>
      updateBaynManifests({
        sourceSha: 'a'.repeat(40),
        tag: `sha-${'a'.repeat(40)}`,
        digest: `sha256:${'b'.repeat(64)}`,
        strategyBehaviorHash,
        strategyParameterHash,
        rolloutTimestamp: '2026-07-22T10:00:00Z',
        deployedDeploymentPath,
        ...paths,
      }),
    ).toThrow('an unpinned qualification candidate is immutable until its terminal run is pinned')
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })

  test('promotes source-only research capital changes with an explicit build-continuation contract', () => {
    const paths = makeFixture({
      qualificationRunId: null,
      capitalActivationRequest: true,
      capitalActivationKind: 'ResearchCapitalBuildContinuation',
    })

    expect(promote(paths)).toMatchObject({
      promotionAction: 'promote',
      promotionReason: 'eligible',
      qualificationMode: 'research',
      hadQualificationPin: false,
      qualificationBindingsMatch: true,
      snapshotChanged: false,
    })
    expect(readFileSync(paths.deploymentPath, 'utf8')).toContain(
      `- name: BAYN_CODE_REVISION\n              value: ${'a'.repeat(40)}`,
    )
  })

  test.each([
    ['BAYN_STRATEGY_NAME', strategyName, 'opening-drive-momentum-v2'],
    ['BAYN_STRATEGY_PROTOCOL_HASH', strategyProtocolHash, '6'.repeat(64)],
    ['BAYN_EXECUTION_RISK_POLICY_HASH', executionRiskPolicyHash, '6'.repeat(64)],
  ] as const)(
    'holds a research build continuation when request-bound identity %s changes',
    (name, deployedValue, candidateValue) => {
      const paths = makeFixture({
        qualificationRunId: null,
        capitalActivationRequest: true,
        capitalActivationKind: 'ResearchCapitalBuildContinuation',
      })
      if (directory === undefined) throw new Error('fixture directory is unavailable')
      const deployedDeploymentPath = join(directory, 'deployed-deployment.yaml')
      const deployed = readFileSync(paths.deploymentPath, 'utf8')
      writeFileSync(deployedDeploymentPath, deployed)
      writeFileSync(
        paths.deploymentPath,
        deployed.replace(environmentBlock(name, deployedValue), environmentBlock(name, candidateValue)),
      )
      const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

      expect(
        updateBaynManifests({
          sourceSha: 'a'.repeat(40),
          tag: `sha-${'a'.repeat(40)}`,
          digest: `sha256:${'b'.repeat(64)}`,
          strategyBehaviorHash,
          strategyParameterHash,
          rolloutTimestamp: '2026-07-22T10:00:00Z',
          candidateRuntime: currentBindings,
          deployedDeploymentPath,
          ...paths,
        }),
      ).toMatchObject({
        promotionAction: 'hold',
        promotionReason: 'research-capital-activation-refresh-required',
        qualificationMode: 'research',
      })
      expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
    },
  )

  test('promotes a proved strategy-identical descendant while preserving raw research provenance', () => {
    const paths = makeFixture({
      qualificationRunId: null,
      capitalActivationRequest: true,
      capitalActivationKind: 'ResearchCapitalActivationRequest',
    })
    const capitalActivationConfiguration = [
      '            - name: BAYN_CAPITAL_ACTIVATION_REQUEST',
      '              valueFrom:',
      '                secretKeyRef:',
      '                  name: bayn-alpaca-auth',
      '                  key: capital-activation-request',
      environmentBlock('BAYN_CAPITAL_ACTIVATION_KIND', 'ResearchCapitalActivationRequest').trimEnd(),
    ].join('\n')

    expect(promote(paths, { researchLineageSourceSha: '0'.repeat(40) })).toMatchObject({
      promotionAction: 'promote',
      promotionReason: 'eligible',
      qualificationMode: 'research',
    })
    expect(readFileSync(paths.deploymentPath, 'utf8')).toContain(
      `- name: BAYN_CODE_REVISION\n              value: ${'a'.repeat(40)}`,
    )
    expect(readFileSync(paths.deploymentPath, 'utf8')).toContain(capitalActivationConfiguration)
    const updatedLineage = JSON.parse(
      environmentValueForTest(readFileSync(paths.deploymentPath, 'utf8'), 'BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE'),
    ) as typeof researchBuildLineage
    expect(updatedLineage.authoredActivation).toEqual(researchBuildLineage.authoredActivation)
    expect(updatedLineage.activation).toEqual({
      sourceRevision: 'a'.repeat(40),
      imageRepository: 'registry.ide-newton.ts.net/lab/bayn',
      imageDigest: `sha256:${'b'.repeat(64)}`,
    })
  })

  test('promotes a refreshed research request through its proved authored-image descendant', () => {
    const paths = makeFixture({
      qualificationRunId: null,
      capitalActivationRequest: true,
      capitalActivationKind: 'ResearchCapitalActivationRequest',
    })
    if (directory === undefined) throw new Error('fixture directory is unavailable')
    const deployedDeploymentPath = join(directory, 'deployed-deployment.yaml')
    const candidate = readFileSync(paths.deploymentPath, 'utf8')
    const deployedLineage = {
      ...researchBuildLineage,
      requestHash: '8'.repeat(64),
      authoredActivation: {
        ...researchBuildLineage.authoredActivation,
        sourceRevision: 'f'.repeat(40),
        imageDigest: `sha256:${'f'.repeat(64)}`,
      },
      activation: {
        ...researchBuildLineage.activation,
        sourceRevision: 'f'.repeat(40),
        imageDigest: `sha256:${'f'.repeat(64)}`,
      },
    }
    const deployed = candidate
      .replace(
        environmentBlock('BAYN_STRATEGY_BEHAVIOR_HASH', strategyBehaviorHash),
        environmentBlock('BAYN_STRATEGY_BEHAVIOR_HASH', '6'.repeat(64)),
      )
      .replace(
        environmentBlock('BAYN_STRATEGY_PROTOCOL_HASH', strategyProtocolHash),
        environmentBlock('BAYN_STRATEGY_PROTOCOL_HASH', '7'.repeat(64)),
      )
      .replace(
        environmentBlock('BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE', JSON.stringify(researchBuildLineage)),
        environmentBlock('BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE', JSON.stringify(deployedLineage)),
      )
    writeFileSync(deployedDeploymentPath, deployed)

    expect(
      updateBaynManifests({
        sourceSha: 'a'.repeat(40),
        tag: `sha-${'a'.repeat(40)}`,
        digest: `sha256:${'b'.repeat(64)}`,
        strategyBehaviorHash,
        strategyParameterHash,
        rolloutTimestamp: '2026-07-22T10:00:00Z',
        candidateRuntime: currentBindings,
        deployedDeploymentPath,
        researchLineageSourceSha: '0'.repeat(40),
        ...paths,
      }),
    ).toMatchObject({
      promotionAction: 'promote',
      promotionReason: 'eligible',
      qualificationMode: 'research',
    })
  })

  test.each([
    ['BAYN_STRATEGY_BEHAVIOR_HASH', strategyBehaviorHash, '6'.repeat(64)],
    ['BAYN_STRATEGY_PARAMETER_HASH', strategyParameterHash, '6'.repeat(64)],
    ['BAYN_STRATEGY_NAME', strategyName, 'opening-drive-momentum-v2'],
    ['BAYN_STRATEGY_PROTOCOL_HASH', strategyProtocolHash, '6'.repeat(64)],
    ['BAYN_EXECUTION_RISK_POLICY_HASH', executionRiskPolicyHash, '6'.repeat(64)],
  ] as const)(
    'holds a proved raw research descendant when request-bound identity %s changed after the authored activation',
    (name, deployedValue, candidateValue) => {
      const paths = makeFixture({
        qualificationRunId: null,
        capitalActivationRequest: true,
        capitalActivationKind: 'ResearchCapitalActivationRequest',
      })
      if (directory === undefined) throw new Error('fixture directory is unavailable')
      const deployedDeploymentPath = join(directory, 'deployed-deployment.yaml')
      const deployed = readFileSync(paths.deploymentPath, 'utf8')
      writeFileSync(deployedDeploymentPath, deployed)
      writeFileSync(
        paths.deploymentPath,
        deployed.replace(environmentBlock(name, deployedValue), environmentBlock(name, candidateValue)),
      )
      const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

      expect(
        updateBaynManifests({
          sourceSha: 'a'.repeat(40),
          tag: `sha-${'a'.repeat(40)}`,
          digest: `sha256:${'b'.repeat(64)}`,
          strategyBehaviorHash: name === 'BAYN_STRATEGY_BEHAVIOR_HASH' ? candidateValue : strategyBehaviorHash,
          strategyParameterHash: name === 'BAYN_STRATEGY_PARAMETER_HASH' ? candidateValue : strategyParameterHash,
          rolloutTimestamp: '2026-07-22T10:00:00Z',
          candidateRuntime: currentBindings,
          researchLineageSourceSha: '0'.repeat(40),
          deployedDeploymentPath,
          ...paths,
        }),
      ).toMatchObject({
        promotionAction: 'hold',
        promotionReason: 'research-capital-activation-refresh-required',
        qualificationMode: 'research',
      })
      expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
    },
  )

  test('holds a raw research build change without explicit ancestry evidence', () => {
    const paths = makeFixture({ qualificationRunId: null, capitalActivationRequest: true })
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

    expect(promote(paths)).toMatchObject({
      promotionAction: 'hold',
      promotionReason: 'research-capital-activation-refresh-required',
      qualificationMode: 'research',
    })
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })

  test('keeps an exact research capital release eligible', () => {
    const paths = makeFixture({ qualificationRunId: null, capitalActivationRequest: true })

    expect(promote(paths, { digest: `sha256:${'0'.repeat(64)}` }, '0'.repeat(40))).toMatchObject({
      promotionAction: 'promote',
      promotionReason: 'eligible',
      qualificationMode: 'research',
      hadQualificationPin: false,
    })
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toContain('enabled: "true"')
  })

  test('holds research capital strategy and runtime identity changes without writing files', () => {
    const paths = makeFixture({ qualificationRunId: null, capitalActivationRequest: true })
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

    expect(promote(paths, { strategyParameterHash: '6'.repeat(64) })).toMatchObject({
      promotionAction: 'hold',
      promotionReason: 'research-capital-activation-refresh-required',
      qualificationMode: 'research',
    })
    expect(
      promote(paths, {
        candidateRuntime: {
          ...currentBindings,
          BAYN_SIGNAL_SNAPSHOT_ID: '5'.repeat(64),
        },
      }),
    ).toMatchObject({
      promotionAction: 'hold',
      promotionReason: 'research-capital-activation-refresh-required',
      qualificationMode: 'research',
    })
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })

  test('does not install a qualification pin through an existing capital activation request', () => {
    const paths = makeFixture({ qualificationRunId: null, capitalActivationRequest: true })
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

    expect(() =>
      promote(
        paths,
        {
          acceptedQualificationRunId: '8'.repeat(64),
          digest: `sha256:${'0'.repeat(64)}`,
        },
        '0'.repeat(40),
      ),
    ).toThrow('qualification installation cannot reuse a configured capital activation request')
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })

  test('rejects installing an accepted run while replacing a pinned runtime', () => {
    const paths = makeFixture()
    const freshRunId = '8'.repeat(64)
    const freshRuntime = {
      ...currentBindings,
      BAYN_SIGNAL_SNAPSHOT_ID: '4'.repeat(64),
      BAYN_SIGNAL_PUBLICATION_ASOF: '2026-07-23',
      BAYN_SIGNAL_DATA_END: '2026-07-23',
      BAYN_SIGNAL_EVALUATION_END: '2026-07-23',
    } satisfies BaynCandidateRuntime
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

    expect(() =>
      promote(paths, {
        strategyParameterHash: '3'.repeat(64),
        candidateRuntime: freshRuntime,
        acceptedQualificationRunId: freshRunId,
      }),
    ).toThrow('qualification installation requires an already-deployed unpinned runtime')
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })

  test('installs the terminal result of the one allowed unpinned release', () => {
    const paths = makeFixture({ qualificationRunId: null })
    const acceptedRunId = '8'.repeat(64)

    expect(
      promote(
        paths,
        {
          acceptedQualificationRunId: acceptedRunId,
          digest: `sha256:${'0'.repeat(64)}`,
        },
        '0'.repeat(40),
      ),
    ).toMatchObject({
      promotionAction: 'promote',
      qualificationMode: 'install',
      hadQualificationPin: false,
      deployedQualificationRunId: null,
      candidateQualificationRunId: acceptedRunId,
      snapshotChanged: false,
    })
    expect(readFileSync(paths.deploymentPath, 'utf8')).toContain(
      environmentBlock('BAYN_QUALIFICATION_RUN_ID', acceptedRunId).trim(),
    )
  })

  test('rejects using an accepted run to change an unpinned source', () => {
    const paths = makeFixture({ qualificationRunId: null })
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

    expect(() =>
      promote(
        paths,
        {
          acceptedQualificationRunId: '8'.repeat(64),
        },
        'c'.repeat(40),
      ),
    ).toThrow('qualification installation must pin the exact deployed source, image, strategy, and runtime')
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })

  test('rejects using an accepted run to change an unpinned image', () => {
    const paths = makeFixture({ qualificationRunId: null })
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

    expect(() =>
      promote(
        paths,
        {
          acceptedQualificationRunId: '8'.repeat(64),
        },
        '0'.repeat(40),
      ),
    ).toThrow('qualification installation must pin the exact deployed source, image, strategy, and runtime')
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })

  test('rejects using an accepted run to change unpinned transport addresses', () => {
    const paths = makeFixture({
      qualificationRunId: null,
      tigerBeetleAddresses: 'ledger.bayn.svc.cluster.local:3000',
    })
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

    expect(() =>
      promote(
        paths,
        {
          acceptedQualificationRunId: '8'.repeat(64),
          digest: `sha256:${'0'.repeat(64)}`,
        },
        '0'.repeat(40),
      ),
    ).toThrow('qualification installation must pin the exact deployed source, image, strategy, and runtime')
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })

  test('requires an explicit complete runtime before installing an accepted run', () => {
    const paths = makeFixture({ qualificationRunId: null })
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

    expect(() =>
      promote(paths, {
        acceptedQualificationRunId: '8'.repeat(64),
        useDeployedRuntime: true,
      }),
    ).toThrow('installing an accepted qualification run requires an explicit candidate runtime')
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })

  test('rejects replacing a pinned run on the same snapshot', () => {
    const paths = makeFixture()
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

    expect(() =>
      promote(paths, {
        acceptedQualificationRunId: '8'.repeat(64),
      }),
    ).toThrow('qualification installation requires an already-deployed unpinned runtime')
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })

  test('uses the deployed runtime when no explicit candidate is supplied', () => {
    const deployedSnapshotId = '4'.repeat(64)
    const paths = makeFixture({ snapshotId: deployedSnapshotId })

    expect(promote(paths, { useDeployedRuntime: true })).toMatchObject({
      promotionAction: 'promote',
      qualificationMode: 'preserve',
      qualificationBindingsMatch: true,
      snapshotChanged: false,
      deployedSnapshotId,
      candidateSnapshotId: deployedSnapshotId,
    })
  })

  test('parses a complete explicit candidate and accepted run and rejects partial candidates', () => {
    const base = [
      '--source-sha',
      'a'.repeat(40),
      '--tag',
      `sha-${'a'.repeat(40)}`,
      '--digest',
      `sha256:${'b'.repeat(64)}`,
      '--strategy-behavior-hash',
      strategyBehaviorHash,
      '--strategy-parameter-hash',
      strategyParameterHash,
      '--rollout-timestamp',
      '2026-07-23T22:30:00Z',
    ]
    const candidate = [
      '--signal-snapshot-id',
      currentBindings.BAYN_SIGNAL_SNAPSHOT_ID,
      '--signal-publication-asof',
      currentBindings.BAYN_SIGNAL_PUBLICATION_ASOF,
      '--signal-calendar-version',
      currentBindings.BAYN_SIGNAL_CALENDAR_VERSION,
      '--signal-data-start',
      currentBindings.BAYN_SIGNAL_DATA_START,
      '--signal-data-end',
      currentBindings.BAYN_SIGNAL_DATA_END,
      '--signal-lookback-start',
      currentBindings.BAYN_SIGNAL_LOOKBACK_START,
      '--signal-evaluation-start',
      currentBindings.BAYN_SIGNAL_EVALUATION_START,
      '--signal-evaluation-end',
      currentBindings.BAYN_SIGNAL_EVALUATION_END,
      '--tigerbeetle-cluster-id',
      currentBindings.BAYN_TIGERBEETLE_CLUSTER_ID,
      '--tigerbeetle-addresses',
      currentBindings.BAYN_TIGERBEETLE_ADDRESSES,
      '--tigerbeetle-ledger',
      currentBindings.BAYN_TIGERBEETLE_LEDGER,
      '--accepted-qualification-run-id',
      qualificationRunId,
    ]

    expect(
      parseUpdateBaynManifestArguments([
        ...base,
        '--deployed-deployment-path',
        '.artifacts/bayn/deployed-deployment.yaml',
        '--research-lineage-source-sha',
        '0'.repeat(40),
        ...candidate,
      ]),
    ).toMatchObject({
      deployedDeploymentPath: '.artifacts/bayn/deployed-deployment.yaml',
      candidateRuntime: currentBindings,
      acceptedQualificationRunId: qualificationRunId,
      researchLineageSourceSha: '0'.repeat(40),
    })
    expect(() =>
      parseUpdateBaynManifestArguments([...base, '--signal-snapshot-id', currentBindings.BAYN_SIGNAL_SNAPSHOT_ID]),
    ).toThrow('candidate runtime flags must be provided together')
    expect(() =>
      parseUpdateBaynManifestArguments([...base, '--accepted-qualification-run-id', qualificationRunId]),
    ).toThrow('--accepted-qualification-run-id requires the complete candidate runtime')
    expect(() => parseUpdateBaynManifestArguments([...base, ...candidate.slice(0, -1), '   '])).toThrow(
      '--accepted-qualification-run-id is required',
    )
  })

  test('rejects malformed explicit qualification material before writing', () => {
    const paths = makeFixture()
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

    expect(() =>
      promote(paths, {
        candidateRuntime: {
          ...currentBindings,
          BAYN_SIGNAL_SNAPSHOT_ID: 'not-a-snapshot',
        },
      }),
    ).toThrow('invalid candidate Signal snapshot ID')
    expect(() =>
      promote(paths, {
        acceptedQualificationRunId: 'not-a-run',
      }),
    ).toThrow('invalid accepted qualification run ID')
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })

  test('rejects malformed release metadata', () => {
    expect(() =>
      updateBaynManifests({
        sourceSha: 'main',
        tag: 'latest',
        digest: 'sha256:bad',
        strategyBehaviorHash,
        strategyParameterHash,
        rolloutTimestamp: 'now',
        applicationSetPath: 'unused',
      }),
    ).toThrow('invalid source SHA')
  })
})
