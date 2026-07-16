import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { repoRoot } from '../../shared/cli'
import { __private } from '../update-manifests'

const createFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'torghut-manifests-test-'))
  const serviceManifestPath = join(dir, 'knative-service.yaml')
  const schedulerManifestPath = join(dir, 'scheduler-deployment.yaml')
  const simulationServiceManifestPath = join(dir, 'knative-service-sim.yaml')
  const migrationManifestPath = join(dir, 'db-migrations-job.yaml')
  const historicalWorkflowManifestPath = join(dir, 'historical-simulation-workflowtemplate.yaml')
  const analysisRuntimeReadyManifestPath = join(dir, 'analysis-template-runtime-ready.yaml')
  const analysisActivityManifestPath = join(dir, 'analysis-template-activity.yaml')
  const analysisTeardownManifestPath = join(dir, 'analysis-template-teardown-clean.yaml')
  const analysisArtifactManifestPath = join(dir, 'analysis-template-artifact-bundle.yaml')
  const generatedResourceRetentionManifestPath = join(dir, 'generated-resource-retention-cronjob.yaml')
  const brokerEconomicLedgerReconciliationManifestPath = join(dir, 'broker-economic-ledger-reconciliation-cronjob.yaml')
  const tigerBeetleSmokeManifestPath = join(dir, 'tigerbeetle-smoke-job.yaml')
  const hyperliquidRuntimeManifestPath = join(dir, 'hyperliquid-runtime-deployment.yaml')
  const hyperliquidRuntimeMigrationManifestPath = join(dir, 'hyperliquid-runtime-db-migrations-job.yaml')
  const optionsArchiveManifestPath = join(dir, 'options-archive-deployment.yaml')
  const optionsCatalogManifestPath = join(dir, 'options-catalog-deployment.yaml')
  const optionsEnricherManifestPath = join(dir, 'options-enricher-deployment.yaml')
  writeFileSync(
    serviceManifestPath,
    `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  annotations:
    serving.knative.dev/creator: system:serviceaccount:argocd:argocd-application-controller
    serving.knative.dev/lastModifier: admin
spec:
  template:
    metadata:
      annotations:
        client.knative.dev/updateTimestamp: "2025-01-01T00:00:00Z"
    spec:
      containers:
        - name: user-container
          image: registry.ide-newton.ts.net/lab/torghut@sha256:1111111111111111111111111111111111111111111111111111111111111111
          env:
            - name: TORGHUT_VERSION
              value: old-version
            - name: TORGHUT_COMMIT
              value: old-commit
`,
    'utf8',
  )
  writeFileSync(
    schedulerManifestPath,
    `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: torghut-scheduler
          image: registry.ide-newton.ts.net/lab/torghut@sha256:1111111111111111111111111111111111111111111111111111111111111111
          env:
            - name: TORGHUT_VERSION
              value: old-version
            - name: TORGHUT_COMMIT
              value: old-commit
            - name: TORGHUT_IMAGE_DIGEST
              value: sha256:1111111111111111111111111111111111111111111111111111111111111111
            - name: TORGHUT_REQUIRED_IMAGE_PLATFORMS
              value: linux/amd64
            - name: TORGHUT_OBSERVED_IMAGE_PLATFORMS
              value: linux/amd64
`,
    'utf8',
  )
  writeFileSync(
    simulationServiceManifestPath,
    `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  annotations:
    serving.knative.dev/lastModifier: admin
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "1"
    spec:
      containers:
        - name: user-container
          image: registry.ide-newton.ts.net/lab/torghut@sha256:1111111111111111111111111111111111111111111111111111111111111111
          env:
            - name: TORGHUT_VERSION
              value: old-version
            - name: TORGHUT_COMMIT
              value: old-commit
`,
    'utf8',
  )
  writeFileSync(
    migrationManifestPath,
    `apiVersion: batch/v1
kind: Job
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: registry.ide-newton.ts.net/lab/torghut@sha256:1111111111111111111111111111111111111111111111111111111111111111
`,
    'utf8',
  )
  for (const path of [
    historicalWorkflowManifestPath,
    analysisRuntimeReadyManifestPath,
    analysisActivityManifestPath,
    analysisTeardownManifestPath,
    analysisArtifactManifestPath,
    generatedResourceRetentionManifestPath,
    brokerEconomicLedgerReconciliationManifestPath,
    tigerBeetleSmokeManifestPath,
  ]) {
    writeFileSync(
      path,
      `apiVersion: v1
kind: ConfigMap
spec:
  template:
    spec:
      containers:
        - name: torghut
          image: registry.ide-newton.ts.net/lab/torghut@sha256:1111111111111111111111111111111111111111111111111111111111111111
          env:
            - name: TORGHUT_IMAGE_DIGEST
              value: sha256:1111111111111111111111111111111111111111111111111111111111111111
`,
      'utf8',
    )
  }
  const optionsManifests = [
    { path: optionsArchiveManifestPath, container: 'torghut-options-archive' },
    { path: optionsCatalogManifestPath, container: 'torghut-options-catalog' },
    { path: optionsEnricherManifestPath, container: 'torghut-options-enricher' },
  ]
  for (const { path, container } of optionsManifests) {
    writeFileSync(
      path,
      `apiVersion: apps/v1
kind: Deployment
spec:
${container === 'torghut-options-archive' ? '  replicas: 0\n' : ''}  template:
    spec:
      initContainers:
        - name: await-options-schema
          image: registry.ide-newton.ts.net/lab/torghut@sha256:1111111111111111111111111111111111111111111111111111111111111111
      containers:
        - name: ${container}
          image: registry.ide-newton.ts.net/lab/torghut@sha256:1111111111111111111111111111111111111111111111111111111111111111
          env:
            - name: TORGHUT_OPTIONS_VERSION
              value: old-version
            - name: TORGHUT_OPTIONS_COMMIT
              value: old-commit
`,
      'utf8',
    )
  }
  writeFileSync(
    hyperliquidRuntimeManifestPath,
    `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: torghut-hyperliquid-runtime
          image: registry.ide-newton.ts.net/lab/torghut:latest
          env:
            - name: TORGHUT_COMMIT
              value: old-commit
            - name: TORGHUT_IMAGE_DIGEST
              value: sha256:1111111111111111111111111111111111111111111111111111111111111111
`,
    'utf8',
  )
  writeFileSync(
    hyperliquidRuntimeMigrationManifestPath,
    `apiVersion: batch/v1
kind: Job
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: registry.ide-newton.ts.net/lab/torghut:latest
          env:
            - name: TORGHUT_COMMIT
              value: old-commit
            - name: TORGHUT_IMAGE_DIGEST
              value: sha256:1111111111111111111111111111111111111111111111111111111111111111
`,
    'utf8',
  )
  return {
    dir,
    serviceManifestPath,
    schedulerManifestPath,
    simulationServiceManifestPath,
    migrationManifestPath,
    historicalWorkflowManifestPath,
    analysisRuntimeReadyManifestPath,
    analysisActivityManifestPath,
    analysisTeardownManifestPath,
    analysisArtifactManifestPath,
    generatedResourceRetentionManifestPath,
    brokerEconomicLedgerReconciliationManifestPath,
    tigerBeetleSmokeManifestPath,
    hyperliquidRuntimeManifestPath,
    hyperliquidRuntimeMigrationManifestPath,
    optionsArchiveManifestPath,
    optionsCatalogManifestPath,
    optionsEnricherManifestPath,
  }
}

type UpdateOptions = Parameters<typeof __private.updateTorghutManifests>[0]

const updateOptionsForFixture = (
  fixture: ReturnType<typeof createFixture>,
  overrides: Partial<UpdateOptions> = {},
): UpdateOptions => ({
  imageName: 'registry.ide-newton.ts.net/lab/torghut',
  digest: 'sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
  version: 'v0.600.0',
  commit: '1234567890abcdef1234567890abcdef12345678',
  rolloutTimestamp: '2026-02-21T04:00:00Z',
  manifestPath: relative(repoRoot, fixture.serviceManifestPath),
  schedulerManifestPath: relative(repoRoot, fixture.schedulerManifestPath),
  simulationManifestPath: relative(repoRoot, fixture.simulationServiceManifestPath),
  migrationManifestPath: relative(repoRoot, fixture.migrationManifestPath),
  historicalSimulationWorkflowManifestPath: relative(repoRoot, fixture.historicalWorkflowManifestPath),
  analysisRuntimeReadyManifestPath: relative(repoRoot, fixture.analysisRuntimeReadyManifestPath),
  analysisActivityManifestPath: relative(repoRoot, fixture.analysisActivityManifestPath),
  analysisTeardownManifestPath: relative(repoRoot, fixture.analysisTeardownManifestPath),
  analysisArtifactManifestPath: relative(repoRoot, fixture.analysisArtifactManifestPath),
  generatedResourceRetentionManifestPath: relative(repoRoot, fixture.generatedResourceRetentionManifestPath),
  brokerEconomicLedgerReconciliationManifestPath: relative(
    repoRoot,
    fixture.brokerEconomicLedgerReconciliationManifestPath,
  ),
  tigerBeetleSmokeManifestPath: relative(repoRoot, fixture.tigerBeetleSmokeManifestPath),
  hyperliquidRuntimeManifestPath: relative(repoRoot, fixture.hyperliquidRuntimeManifestPath),
  hyperliquidRuntimeMigrationManifestPath: relative(repoRoot, fixture.hyperliquidRuntimeMigrationManifestPath),
  optionsArchiveManifestPath: relative(repoRoot, fixture.optionsArchiveManifestPath),
  optionsCatalogManifestPath: relative(repoRoot, fixture.optionsCatalogManifestPath),
  optionsEnricherManifestPath: relative(repoRoot, fixture.optionsEnricherManifestPath),
  ...overrides,
})

describe('update-manifests', () => {
  it('keeps workflow template postgres password injection logic in repo', () => {
    const historicalWorkflowManifest = readFileSync(
      join(repoRoot, 'argocd/applications/torghut/historical-simulation-workflowtemplate.yaml'),
      'utf8',
    )

    expect(historicalWorkflowManifest).toContain('- name: TORGHUT_POSTGRES_ADMIN_PASSWORD')
    expect(historicalWorkflowManifest).toContain('name: torghut-db-superuser')
    expect(historicalWorkflowManifest).toContain('def _with_password_if_missing')
    expect(historicalWorkflowManifest).toContain('admin_dsn_password_env')
    expect(historicalWorkflowManifest).toContain('simulation_dsn_password_env')
    expect(historicalWorkflowManifest).toContain('runtime_simulation_dsn_password_env')
  })

  it('keeps the migration hook gated on database readiness', () => {
    const migrationManifest = readFileSync(join(repoRoot, 'argocd/applications/torghut/db-migrations-job.yaml'), 'utf8')

    expect(migrationManifest).toContain('backoffLimit: 6')
    expect(migrationManifest).toContain('activeDeadlineSeconds: 3600')
    expect(migrationManifest).toContain("migration's 45-minute statement timeout")
    expect(migrationManifest).toContain('wait_for_database()')
    expect(migrationManifest).toContain("connection.execute(text('select 1'))")
    expect(migrationManifest).toContain('wait_for_database "torghut app database" "${DB_DSN}" 300')
    expect(migrationManifest).toContain(
      'wait_for_database "postgres superuser database" "${TORGHUT_POSTGRES_ADMIN_URI}" 300 postgres',
    )
    expect(migrationManifest).toContain('DB_WAIT_DATABASE="${database}"')
    expect(migrationManifest).toContain('dsn = database_url(dsn, database)')
    expect(migrationManifest).toContain('missing_relations = connection.execute')
    expect(migrationManifest).toContain("has_table_privilege(:runtime_role, c.oid, 'SELECT')")
    expect(migrationManifest).toContain("has_sequence_privilege(:runtime_role, c.oid, 'USAGE')")
    expect(migrationManifest).toContain("has_function_privilege(:runtime_role, p.oid, 'EXECUTE')")
    expect(migrationManifest).toContain('GRANT ALL PRIVILEGES ON TABLE {object_name} TO {quoted_role}')
    expect(migrationManifest).toContain('granted missing simulation runtime privileges')
    expect(migrationManifest).not.toContain('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public')
    expect(migrationManifest).not.toContain('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public')
    expect(migrationManifest).not.toContain('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public')
  })

  it('updates service and migration image digest, rollout timestamp, and metadata env values', () => {
    const fixture = createFixture()
    const result = __private.updateTorghutManifests(updateOptionsForFixture(fixture))

    const serviceManifest = readFileSync(fixture.serviceManifestPath, 'utf8')
    const schedulerManifest = readFileSync(fixture.schedulerManifestPath, 'utf8')
    const simulationServiceManifest = readFileSync(fixture.simulationServiceManifestPath, 'utf8')
    const migrationManifest = readFileSync(fixture.migrationManifestPath, 'utf8')
    const historicalWorkflowManifest = readFileSync(fixture.historicalWorkflowManifestPath, 'utf8')
    const analysisRuntimeReadyManifest = readFileSync(fixture.analysisRuntimeReadyManifestPath, 'utf8')
    const analysisActivityManifest = readFileSync(fixture.analysisActivityManifestPath, 'utf8')
    const analysisTeardownManifest = readFileSync(fixture.analysisTeardownManifestPath, 'utf8')
    const analysisArtifactManifest = readFileSync(fixture.analysisArtifactManifestPath, 'utf8')
    const generatedResourceRetentionManifest = readFileSync(fixture.generatedResourceRetentionManifestPath, 'utf8')
    const brokerEconomicLedgerReconciliationManifest = readFileSync(
      fixture.brokerEconomicLedgerReconciliationManifestPath,
      'utf8',
    )
    const tigerBeetleSmokeManifest = readFileSync(fixture.tigerBeetleSmokeManifestPath, 'utf8')
    const hyperliquidRuntimeManifest = readFileSync(fixture.hyperliquidRuntimeManifestPath, 'utf8')
    const hyperliquidRuntimeMigrationManifest = readFileSync(fixture.hyperliquidRuntimeMigrationManifestPath, 'utf8')
    const optionsArchiveManifest = readFileSync(fixture.optionsArchiveManifestPath, 'utf8')
    const optionsCatalogManifest = readFileSync(fixture.optionsCatalogManifestPath, 'utf8')
    const optionsEnricherManifest = readFileSync(fixture.optionsEnricherManifestPath, 'utf8')
    expect(serviceManifest).toContain('client.knative.dev/updateTimestamp: "2026-02-21T04:00:00Z"')
    expect(serviceManifest).toContain(
      'image: registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    expect(serviceManifest).toContain(
      'serving.knative.dev/creator: system:serviceaccount:argocd:argocd-application-controller',
    )
    expect(serviceManifest).not.toContain('serving.knative.dev/lastModifier:')
    expect(serviceManifest).toContain('value: v0.600.0')
    expect(serviceManifest).toContain('value: 1234567890abcdef1234567890abcdef12345678')
    expect(serviceManifest).toContain('value: sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e')
    expect(serviceManifest).toContain('value: linux/amd64,linux/arm64')
    expect(schedulerManifest).toContain(
      'image: registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    expect(schedulerManifest).toContain('value: v0.600.0')
    expect(schedulerManifest).toContain('value: 1234567890abcdef1234567890abcdef12345678')
    expect(schedulerManifest).toContain(
      'value: sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    expect(schedulerManifest.match(/value: linux\/amd64,linux\/arm64/g)?.length).toBe(2)
    expect(simulationServiceManifest).toContain('client.knative.dev/updateTimestamp: "2026-02-21T04:00:00Z"')
    expect(simulationServiceManifest).toContain('value: v0.600.0')
    expect(simulationServiceManifest).toContain('value: 1234567890abcdef1234567890abcdef12345678')
    expect(simulationServiceManifest).toContain(
      'value: sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    expect(simulationServiceManifest).toContain('value: linux/amd64,linux/arm64')
    expect(migrationManifest).toContain(
      'image: registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    for (const manifest of [
      historicalWorkflowManifest,
      analysisRuntimeReadyManifest,
      analysisActivityManifest,
      analysisTeardownManifest,
      analysisArtifactManifest,
      generatedResourceRetentionManifest,
      brokerEconomicLedgerReconciliationManifest,
      tigerBeetleSmokeManifest,
      hyperliquidRuntimeManifest,
      hyperliquidRuntimeMigrationManifest,
    ]) {
      expect(manifest).toContain(
        'image: registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
      )
      expect(manifest).toContain('value: sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e')
    }
    expect(hyperliquidRuntimeManifest).toContain('value: 1234567890abcdef1234567890abcdef12345678')
    expect(hyperliquidRuntimeMigrationManifest).toContain('value: 1234567890abcdef1234567890abcdef12345678')
    for (const manifest of [optionsArchiveManifest, optionsCatalogManifest, optionsEnricherManifest]) {
      expect(manifest).toContain(
        'image: registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
      )
      expect(
        manifest.match(
          /image: registry\.ide-newton\.ts\.net\/lab\/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e/g,
        )?.length,
      ).toBe(2)
      expect(manifest).toContain('value: v0.600.0')
      expect(manifest).toContain('value: 1234567890abcdef1234567890abcdef12345678')
    }
    expect(optionsArchiveManifest).toContain('  replicas: 0')
    expect(result.changed).toBe(true)
    expect(result.imageRef).toBe(
      'registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    expect(result.changedPaths.length).toBe(17)

    rmSync(fixture.dir, { recursive: true, force: true })
  })

  it('can skip options manifests when explicitly disabled', () => {
    const fixture = createFixture()
    const result = __private.updateTorghutManifests(
      updateOptionsForFixture(fixture, {
        includeOptionsManifests: false,
      }),
    )
    const optionsArchiveManifest = readFileSync(fixture.optionsArchiveManifestPath, 'utf8')
    const optionsCatalogManifest = readFileSync(fixture.optionsCatalogManifestPath, 'utf8')
    const optionsEnricherManifest = readFileSync(fixture.optionsEnricherManifestPath, 'utf8')

    for (const manifest of [optionsArchiveManifest, optionsCatalogManifest, optionsEnricherManifest]) {
      expect(manifest).toContain(
        'image: registry.ide-newton.ts.net/lab/torghut@sha256:1111111111111111111111111111111111111111111111111111111111111111',
      )
      expect(
        manifest.match(
          /image: registry\.ide-newton\.ts\.net\/lab\/torghut@sha256:1111111111111111111111111111111111111111111111111111111111111111/g,
        )?.length,
      ).toBe(2)
      expect(manifest).toContain('value: old-version')
      expect(manifest).toContain('value: old-commit')
    }
    expect(result.changedPaths.length).toBe(14)

    rmSync(fixture.dir, { recursive: true, force: true })
  })

  it('returns changed=false when manifests already match requested state', () => {
    const fixture = createFixture()
    const options = updateOptionsForFixture(fixture, {
      digest: 'sha256:ef4a4f754c30705019667f7aa6c89ca95b8ca4f2f1539ca0f8ce62d56a4be63c',
      version: 'v0.601.0',
      commit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      rolloutTimestamp: '2026-02-21T05:00:00Z',
    })

    __private.updateTorghutManifests(options)
    const second = __private.updateTorghutManifests(options)
    expect(second.changed).toBe(false)

    rmSync(fixture.dir, { recursive: true, force: true })
  })
})
