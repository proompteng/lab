import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { repoRoot } from '../../shared/cli'
import { __private } from '../update-manifests'

const createFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'torghut-manifests-test-'))
  const serviceManifestPath = join(dir, 'knative-service.yaml')
  const simpleServiceManifestPath = join(dir, 'knative-service-simple.yaml')
  const simulationServiceManifestPath = join(dir, 'knative-service-sim.yaml')
  const migrationManifestPath = join(dir, 'db-migrations-job.yaml')
  const leanRunnerManifestPath = join(dir, 'lean-runner-deployment.yaml')
  const historicalWorkflowManifestPath = join(dir, 'historical-simulation-workflowtemplate.yaml')
  const empiricalWorkflowManifestPath = join(dir, 'empirical-promotion-workflowtemplate.yaml')
  const analysisRuntimeReadyManifestPath = join(dir, 'analysis-template-runtime-ready.yaml')
  const analysisActivityManifestPath = join(dir, 'analysis-template-activity.yaml')
  const analysisTeardownManifestPath = join(dir, 'analysis-template-teardown-clean.yaml')
  const analysisArtifactManifestPath = join(dir, 'analysis-template-artifact-bundle.yaml')
  const empiricalBackfillManifestPath = join(dir, 'empirical-jobs-backfill-job.yaml')
  const forecastManifestPath = join(dir, 'forecast-deployment.yaml')
  const forecastSimulationManifestPath = join(dir, 'forecast-sim-deployment.yaml')
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
    simpleServiceManifestPath,
    `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  annotations:
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
    leanRunnerManifestPath,
    historicalWorkflowManifestPath,
    empiricalWorkflowManifestPath,
    analysisRuntimeReadyManifestPath,
    analysisActivityManifestPath,
    analysisTeardownManifestPath,
    analysisArtifactManifestPath,
    empiricalBackfillManifestPath,
    forecastManifestPath,
    forecastSimulationManifestPath,
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
`,
      'utf8',
    )
  }
  for (const path of [optionsCatalogManifestPath, optionsEnricherManifestPath]) {
    writeFileSync(
      path,
      `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: torghut-options-${path === optionsCatalogManifestPath ? 'catalog' : 'enricher'}
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
  return {
    dir,
    serviceManifestPath,
    simpleServiceManifestPath,
    simulationServiceManifestPath,
    migrationManifestPath,
    leanRunnerManifestPath,
    historicalWorkflowManifestPath,
    empiricalWorkflowManifestPath,
    analysisRuntimeReadyManifestPath,
    analysisActivityManifestPath,
    analysisTeardownManifestPath,
    analysisArtifactManifestPath,
    empiricalBackfillManifestPath,
    forecastManifestPath,
    forecastSimulationManifestPath,
    optionsCatalogManifestPath,
    optionsEnricherManifestPath,
  }
}

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

  it('updates service and migration image digest, rollout timestamp, and metadata env values', () => {
    const fixture = createFixture()
    const result = __private.updateTorghutManifests({
      imageName: 'registry.ide-newton.ts.net/lab/torghut',
      digest: 'sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
      version: 'v0.600.0',
      commit: '1234567890abcdef1234567890abcdef12345678',
      rolloutTimestamp: '2026-02-21T04:00:00Z',
      manifestPath: relative(repoRoot, fixture.serviceManifestPath),
      simpleManifestPath: relative(repoRoot, fixture.simpleServiceManifestPath),
      simulationManifestPath: relative(repoRoot, fixture.simulationServiceManifestPath),
      migrationManifestPath: relative(repoRoot, fixture.migrationManifestPath),
      leanRunnerManifestPath: relative(repoRoot, fixture.leanRunnerManifestPath),
      historicalSimulationWorkflowManifestPath: relative(repoRoot, fixture.historicalWorkflowManifestPath),
      empiricalPromotionWorkflowManifestPath: relative(repoRoot, fixture.empiricalWorkflowManifestPath),
      analysisRuntimeReadyManifestPath: relative(repoRoot, fixture.analysisRuntimeReadyManifestPath),
      analysisActivityManifestPath: relative(repoRoot, fixture.analysisActivityManifestPath),
      analysisTeardownManifestPath: relative(repoRoot, fixture.analysisTeardownManifestPath),
      analysisArtifactManifestPath: relative(repoRoot, fixture.analysisArtifactManifestPath),
      empiricalBackfillManifestPath: relative(repoRoot, fixture.empiricalBackfillManifestPath),
      forecastManifestPath: relative(repoRoot, fixture.forecastManifestPath),
      forecastSimulationManifestPath: relative(repoRoot, fixture.forecastSimulationManifestPath),
      optionsCatalogManifestPath: relative(repoRoot, fixture.optionsCatalogManifestPath),
      optionsEnricherManifestPath: relative(repoRoot, fixture.optionsEnricherManifestPath),
    })

    const serviceManifest = readFileSync(fixture.serviceManifestPath, 'utf8')
    const simpleServiceManifest = readFileSync(fixture.simpleServiceManifestPath, 'utf8')
    const simulationServiceManifest = readFileSync(fixture.simulationServiceManifestPath, 'utf8')
    const migrationManifest = readFileSync(fixture.migrationManifestPath, 'utf8')
    const leanRunnerManifest = readFileSync(fixture.leanRunnerManifestPath, 'utf8')
    const historicalWorkflowManifest = readFileSync(fixture.historicalWorkflowManifestPath, 'utf8')
    const empiricalWorkflowManifest = readFileSync(fixture.empiricalWorkflowManifestPath, 'utf8')
    const analysisRuntimeReadyManifest = readFileSync(fixture.analysisRuntimeReadyManifestPath, 'utf8')
    const analysisActivityManifest = readFileSync(fixture.analysisActivityManifestPath, 'utf8')
    const analysisTeardownManifest = readFileSync(fixture.analysisTeardownManifestPath, 'utf8')
    const analysisArtifactManifest = readFileSync(fixture.analysisArtifactManifestPath, 'utf8')
    const empiricalBackfillManifest = readFileSync(fixture.empiricalBackfillManifestPath, 'utf8')
    const forecastManifest = readFileSync(fixture.forecastManifestPath, 'utf8')
    const forecastSimulationManifest = readFileSync(fixture.forecastSimulationManifestPath, 'utf8')
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
    expect(simpleServiceManifest).toContain('client.knative.dev/updateTimestamp: "2026-02-21T04:00:00Z"')
    expect(simpleServiceManifest).toContain(
      'image: registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    expect(simpleServiceManifest).not.toContain('serving.knative.dev/lastModifier:')
    expect(simpleServiceManifest).toContain('value: v0.600.0')
    expect(simpleServiceManifest).toContain('value: 1234567890abcdef1234567890abcdef12345678')
    expect(simulationServiceManifest).toContain('client.knative.dev/updateTimestamp: "2026-02-21T04:00:00Z"')
    expect(simulationServiceManifest).toContain('value: v0.600.0')
    expect(simulationServiceManifest).toContain('value: 1234567890abcdef1234567890abcdef12345678')
    expect(migrationManifest).toContain(
      'image: registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    for (const manifest of [
      leanRunnerManifest,
      historicalWorkflowManifest,
      empiricalWorkflowManifest,
      analysisRuntimeReadyManifest,
      analysisActivityManifest,
      analysisTeardownManifest,
      analysisArtifactManifest,
      empiricalBackfillManifest,
      forecastManifest,
      forecastSimulationManifest,
    ]) {
      expect(manifest).toContain(
        'image: registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
      )
    }
    for (const manifest of [optionsCatalogManifest, optionsEnricherManifest]) {
      expect(manifest).toContain(
        'image: registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
      )
      expect(manifest).toContain('value: v0.600.0')
      expect(manifest).toContain('value: 1234567890abcdef1234567890abcdef12345678')
    }
    expect(result.changed).toBe(true)
    expect(result.imageRef).toBe(
      'registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    expect(result.changedPaths.length).toBe(16)

    rmSync(fixture.dir, { recursive: true, force: true })
  })

  it('returns changed=false when manifests already match requested state', () => {
    const fixture = createFixture()
    const options = {
      imageName: 'registry.ide-newton.ts.net/lab/torghut',
      digest: 'sha256:ef4a4f754c30705019667f7aa6c89ca95b8ca4f2f1539ca0f8ce62d56a4be63c',
      version: 'v0.601.0',
      commit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      rolloutTimestamp: '2026-02-21T05:00:00Z',
      manifestPath: relative(repoRoot, fixture.serviceManifestPath),
      simpleManifestPath: relative(repoRoot, fixture.simpleServiceManifestPath),
      simulationManifestPath: relative(repoRoot, fixture.simulationServiceManifestPath),
      migrationManifestPath: relative(repoRoot, fixture.migrationManifestPath),
      leanRunnerManifestPath: relative(repoRoot, fixture.leanRunnerManifestPath),
      historicalSimulationWorkflowManifestPath: relative(repoRoot, fixture.historicalWorkflowManifestPath),
      empiricalPromotionWorkflowManifestPath: relative(repoRoot, fixture.empiricalWorkflowManifestPath),
      analysisRuntimeReadyManifestPath: relative(repoRoot, fixture.analysisRuntimeReadyManifestPath),
      analysisActivityManifestPath: relative(repoRoot, fixture.analysisActivityManifestPath),
      analysisTeardownManifestPath: relative(repoRoot, fixture.analysisTeardownManifestPath),
      analysisArtifactManifestPath: relative(repoRoot, fixture.analysisArtifactManifestPath),
      empiricalBackfillManifestPath: relative(repoRoot, fixture.empiricalBackfillManifestPath),
      forecastManifestPath: relative(repoRoot, fixture.forecastManifestPath),
      forecastSimulationManifestPath: relative(repoRoot, fixture.forecastSimulationManifestPath),
      optionsCatalogManifestPath: relative(repoRoot, fixture.optionsCatalogManifestPath),
      optionsEnricherManifestPath: relative(repoRoot, fixture.optionsEnricherManifestPath),
    }

    __private.updateTorghutManifests(options)
    const second = __private.updateTorghutManifests(options)
    expect(second.changed).toBe(false)

    rmSync(fixture.dir, { recursive: true, force: true })
  })
})
