import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseUpdateBaynManifestArguments,
  updateBaynManifests,
  type BaynCandidateRuntime,
  type UpdateBaynManifestOptions,
} from './update-manifests'

const currentSnapshotId = '840c75885270b349d4a992e003918ce7e6fe39730f981a20b2e88ae2db45a2e2'
const strategyBehaviorHash = '1'.repeat(64)
const strategyParameterHash = '2'.repeat(64)
const qualificationRunId = '9'.repeat(64)
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
  readonly qualificationRunId?: string | null
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
  const environment = [
    environmentBlock('BAYN_CODE_REVISION', '0'.repeat(40)),
    environmentBlock('BAYN_IMAGE_REPOSITORY', 'registry.ide-newton.ts.net/lab/bayn'),
    environmentBlock('BAYN_IMAGE_DIGEST', `sha256:${'0'.repeat(64)}`),
    environmentBlock('BAYN_STRATEGY_BEHAVIOR_HASH', options.behaviorHash ?? strategyBehaviorHash),
    environmentBlock('BAYN_STRATEGY_PARAMETER_HASH', options.parameterHash ?? strategyParameterHash),
    pin === null ? '' : environmentBlock('BAYN_QUALIFICATION_RUN_ID', pin),
    ...Object.entries(bindings).map(([name, value]) => environmentBlock(name, value)),
  ].join('')

  writeFileSync(
    paths.kustomizationPath,
    'images:\n  - name: registry.ide-newton.ts.net/lab/bayn\n    newName: registry.ide-newton.ts.net/lab/bayn\n    newTag: bootstrap\n',
  )
  writeFileSync(
    paths.deploymentPath,
    `metadata:\n  template:\n    metadata:\n      annotations:\n        kubectl.kubernetes.io/restartedAt: "old"\n    spec:\n      containers:\n        - env:\n${environment}`,
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
      'digest' | 'strategyBehaviorHash' | 'strategyParameterHash' | 'candidateRuntime' | 'acceptedQualificationRunId'
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
    ...paths,
  })
}

describe('Bayn manifest promotion', () => {
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

  test('replaces a pin for a fresh snapshot and rejects a second unpinned source release', () => {
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

    expect(promote(paths, { strategyParameterHash: changedParameterHash })).toMatchObject({
      promotionAction: 'promote',
      promotionReason: 'eligible',
      qualificationMode: 'replace',
      hadQualificationPin: false,
      snapshotChanged: false,
      deployedSourceSha: 'a'.repeat(40),
    })

    const beforeSecondRelease = Object.values(paths).map((path) => readFileSync(path, 'utf8'))
    expect(() => promote(paths, { strategyParameterHash: changedParameterHash }, 'c'.repeat(40))).toThrow(
      'an unpinned qualification snapshot cannot accept a second source release',
    )
    expect(Object.values(paths).map((path) => readFileSync(path, 'utf8'))).toEqual(beforeSecondRelease)
    expect(readFileSync(paths.deploymentPath, 'utf8')).not.toContain('BAYN_QUALIFICATION_RUN_ID')
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

    expect(parseUpdateBaynManifestArguments([...base, ...candidate])).toMatchObject({
      candidateRuntime: currentBindings,
      acceptedQualificationRunId: qualificationRunId,
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
