import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { updateBaynManifests, type UpdateBaynManifestOptions } from './update-manifests'

const currentSnapshotId = '0945e3331d67437a072d5eb33f65e469b9883a5e762e29e80f7acb389864c79f'
const strategyBehaviorHash = '1'.repeat(64)
const strategyParameterHash = '2'.repeat(64)
const qualificationRunId = '9'.repeat(64)
const currentBindings = {
  BAYN_SIGNAL_SNAPSHOT_ID: currentSnapshotId,
  BAYN_SIGNAL_PUBLICATION_ASOF: '2026-07-22',
  BAYN_SIGNAL_CALENDAR_VERSION: 'alpaca-us-equity-calendar-v1',
  BAYN_SIGNAL_DATA_START: '2022-01-27',
  BAYN_SIGNAL_DATA_END: '2026-07-22',
  BAYN_SIGNAL_LOOKBACK_START: '2022-01-27',
  BAYN_SIGNAL_EVALUATION_START: '2023-01-30',
  BAYN_SIGNAL_EVALUATION_END: '2026-07-22',
  BAYN_TIGERBEETLE_CLUSTER_ID: '122731676035874920802382025803517750735',
  BAYN_TIGERBEETLE_ADDRESSES:
    'ledger-0.ledger-headless.bayn.svc.cluster.local:3000,ledger-1.ledger-headless.bayn.svc.cluster.local:3000,ledger-2.ledger-headless.bayn.svc.cluster.local:3000',
  BAYN_TIGERBEETLE_LEDGER: '7001',
} as const

interface FixtureOptions {
  readonly snapshotId?: string
  readonly publicationAsOf?: string
  readonly tigerBeetleClusterId?: string
  readonly tigerBeetleAddresses?: string
  readonly behaviorHash?: string
  readonly parameterHash?: string
  readonly qualificationRunId?: string | undefined
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
  const dossierGenerator =
    pin === undefined
      ? ''
      : `configMapGenerator:\n  - name: bayn-qualification-dossier\n    files:\n      - qualification-dossier.json=qualification-dossiers/${pin}.json\n`
  const dossierMounts =
    pin === undefined
      ? ''
      : `          volumeMounts:\n            - name: qualification-dossier\n              mountPath: /var/run/bayn/qualification\n              readOnly: true\n      volumes:\n        - name: qualification-dossier\n          configMap:\n            name: bayn-qualification-dossier\n            defaultMode: 0444\n            items:\n              - key: qualification-dossier.json\n                path: qualification-dossier.json\n`
  const environment = [
    environmentBlock('BAYN_CODE_REVISION', '0'.repeat(40)),
    environmentBlock('BAYN_IMAGE_REPOSITORY', 'registry.ide-newton.ts.net/lab/bayn'),
    environmentBlock('BAYN_IMAGE_DIGEST', `sha256:${'0'.repeat(64)}`),
    environmentBlock('BAYN_STRATEGY_BEHAVIOR_HASH', options.behaviorHash ?? strategyBehaviorHash),
    environmentBlock('BAYN_STRATEGY_PARAMETER_HASH', options.parameterHash ?? strategyParameterHash),
    pin === undefined ? '' : environmentBlock('BAYN_QUALIFICATION_RUN_ID', pin),
    ...Object.entries(bindings).map(([name, value]) => environmentBlock(name, value)),
  ].join('')

  writeFileSync(
    paths.kustomizationPath,
    `${dossierGenerator}images:\n  - name: registry.ide-newton.ts.net/lab/bayn\n    newName: registry.ide-newton.ts.net/lab/bayn\n    newTag: bootstrap\n`,
  )
  writeFileSync(
    paths.deploymentPath,
    `metadata:\n  template:\n    metadata:\n      annotations:\n        kubectl.kubernetes.io/restartedAt: "old"\n    spec:\n      containers:\n        - env:\n${environment}${dossierMounts}`,
  )
  writeFileSync(
    paths.applicationSetPath,
    'elements:\n              - name: bayn\n                path: argocd/applications/bayn\n                enabled: "false"\n              - name: next\n                enabled: "true"\n',
  )
  return paths
}

const promote = (
  paths: FixturePaths,
  overrides: Partial<Pick<UpdateBaynManifestOptions, 'strategyBehaviorHash' | 'strategyParameterHash'>> = {},
  sourceSha = 'a'.repeat(40),
) => {
  return updateBaynManifests({
    sourceSha,
    tag: `sha-${sourceSha}`,
    digest: `sha256:${'b'.repeat(64)}`,
    strategyBehaviorHash: overrides.strategyBehaviorHash ?? strategyBehaviorHash,
    strategyParameterHash: overrides.strategyParameterHash ?? strategyParameterHash,
    rolloutTimestamp: '2026-07-22T10:00:00Z',
    ...paths,
  })
}

describe('Bayn manifest promotion', () => {
  test('preserves a qualification pin only for identical strategy and runtime bindings', () => {
    const paths = makeFixture()
    const result = promote(paths)

    expect(result).toMatchObject({
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
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toContain('bayn-qualification-dossier')
    expect(readFileSync(paths.deploymentPath, 'utf8')).toContain('/var/run/bayn/qualification')
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toContain('enabled: "true"')
  })

  test('rejects an incompatible strategy against an already-qualified snapshot without writing files', () => {
    const paths = makeFixture()
    const before = Object.values(paths).map((path) => readFileSync(path, 'utf8'))

    expect(() => promote(paths, { strategyParameterHash: '3'.repeat(64) })).toThrow(
      'qualification replacement requires a fresh BAYN_SIGNAL_SNAPSHOT_ID',
    )
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

    expect(promote(paths)).toMatchObject({
      qualificationMode: 'preserve',
      qualificationBindingsMatch: true,
      snapshotChanged: false,
    })
    expect(readFileSync(paths.deploymentPath, 'utf8')).toContain(
      environmentBlock('BAYN_QUALIFICATION_RUN_ID', qualificationRunId).trim(),
    )
    expect(readFileSync(paths.deploymentPath, 'utf8')).toContain(
      environmentBlock('BAYN_TIGERBEETLE_ADDRESSES', currentBindings.BAYN_TIGERBEETLE_ADDRESSES).trim(),
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
      qualificationMode: 'replace',
      hadQualificationPin: true,
      qualificationBindingsMatch: false,
      snapshotChanged: true,
      deployedSnapshotId: '4'.repeat(64),
      candidateSnapshotId: currentSnapshotId,
    })
    expect(readFileSync(paths.deploymentPath, 'utf8')).not.toContain('BAYN_QUALIFICATION_RUN_ID')
    expect(readFileSync(paths.kustomizationPath, 'utf8')).not.toContain('bayn-qualification-dossier')
    expect(readFileSync(paths.deploymentPath, 'utf8')).not.toContain('qualification-dossier')
    expect(readFileSync(paths.deploymentPath, 'utf8')).toContain(
      environmentBlock('BAYN_SIGNAL_SNAPSHOT_ID', currentSnapshotId).trim(),
    )

    expect(promote(paths, { strategyParameterHash: changedParameterHash })).toMatchObject({
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
