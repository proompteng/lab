import { describe, expect, it } from 'vitest'

import {
  __private,
  listTorghutSimulationPresets,
  parseTorghutSimulationCampaignRequest,
  parseTorghutSimulationRunRequest,
} from '~/server/torghut-simulation-control-plane'

describe('torghut simulation control plane', () => {
  it('parses a valid simulation submission request', () => {
    const parsed = parseTorghutSimulationRunRequest({
      runId: 'sim-demo',
      manifest: {
        dataset_id: 'dataset-a',
        window: {
          start: '2026-03-06T14:30:00Z',
          end: '2026-03-06T15:30:00Z',
        },
      },
      cachePolicy: 'refresh',
      profile: 'hourly',
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.runId).toBe('sim-demo')
    expect(parsed.value.cachePolicy).toBe('refresh')
    expect(parsed.value.profile).toBe('hourly')
  })

  it('normalizes manifest defaults for Jangar submissions', () => {
    const manifest = __private.normalizeSimulationManifest(
      {
        dataset_id: 'dataset-a',
        window: {
          start: '2026-03-06T14:30:00Z',
          end: '2026-03-06T15:30:00Z',
        },
      },
      {
        runId: 'sim-demo-compact',
        outputRoot: '/tmp/torghut-sim',
        cachePolicy: 'require_cache',
        profile: 'compact',
      },
    )

    expect(manifest.runtime).toMatchObject({ output_root: '/tmp/torghut-sim', use_warm_lane: true })
    expect(manifest.performance).toMatchObject({
      replayProfile: 'compact',
      dumpFormat: 'jsonl.zst',
    })
    expect(manifest.ta_restore).toMatchObject({ mode: 'stateless' })
    expect(manifest.cachePolicy).toBe('require_cache')
    expect(manifest.kafka).toMatchObject({
      bootstrap_servers: 'kafka-kafka-bootstrap.kafka.svc.cluster.local:9092',
      runtime_bootstrap_servers: 'kafka-kafka-bootstrap.kafka.svc.cluster.local:9092',
      sasl_password_env: 'TORGHUT_SIM_KAFKA_PASSWORD',
      runtime_sasl_password_env: 'TORGHUT_SIM_KAFKA_PASSWORD',
    })
    expect(manifest.clickhouse).toMatchObject({
      http_url: 'http://torghut-clickhouse.torghut.svc.cluster.local:8123',
      simulation_database: 'torghut_sim_default',
    })
    expect(manifest.postgres).toMatchObject({
      admin_dsn: 'postgresql://postgres@torghut-db-rw.torghut.svc.cluster.local:5432/postgres',
      admin_dsn_password_env: 'TORGHUT_POSTGRES_ADMIN_PASSWORD',
      simulation_dsn: 'postgresql://torghut_app@torghut-db-rw.torghut.svc.cluster.local:5432/torghut_sim_default',
      runtime_simulation_dsn:
        'postgresql://torghut_app@torghut-db-rw.torghut.svc.cluster.local:5432/torghut_sim_default',
      migrations_command: '/opt/venv/bin/alembic upgrade heads',
    })
    expect(manifest.rollouts).toMatchObject({
      enabled: true,
      namespace: 'torghut',
      runtime_template: 'torghut-simulation-runtime-ready',
      activity_template: 'torghut-simulation-activity',
      teardown_template: 'torghut-simulation-teardown-clean',
      artifact_template: 'torghut-simulation-artifact-bundle',
    })
    expect(manifest.argocd).toMatchObject({
      manage_automation: true,
      app_name: 'torghut',
      desired_mode_during_run: 'manual',
    })
  })

  it('derives isolated simulation databases when warm lanes are disabled', () => {
    const manifest = __private.normalizeSimulationManifest(
      {
        dataset_id: 'dataset-a',
        lane: 'options',
        runtime: {
          target_mode: 'dedicated_service',
          use_warm_lane: false,
        },
        window: {
          start: '2026-03-06T14:30:00Z',
          end: '2026-03-06T15:30:00Z',
        },
      },
      {
        runId: 'sim-options-proof',
        profile: 'hourly',
      },
    )

    expect(manifest.clickhouse).toMatchObject({
      simulation_database: 'torghut_sim_sim_options_proof',
    })
    expect(manifest.postgres).toMatchObject({
      simulation_dsn:
        'postgresql://torghut_app@torghut-db-rw.torghut.svc.cluster.local:5432/torghut_sim_sim_options_proof',
      runtime_simulation_dsn:
        'postgresql://torghut_app@torghut-db-rw.torghut.svc.cluster.local:5432/torghut_sim_sim_options_proof',
    })
  })

  it('rewrites stale run-scoped databases when warm lanes are enabled', () => {
    const manifest = __private.normalizeSimulationManifest(
      {
        dataset_id: 'dataset-a',
        window: {
          start: '2026-03-06T14:30:00Z',
          end: '2026-03-06T14:45:00Z',
        },
        runtime: {
          target_mode: 'dedicated_service',
          use_warm_lane: true,
        },
        clickhouse: {
          simulation_database: 'torghut_sim_old_run',
        },
        postgres: {
          simulation_dsn: 'postgresql://torghut_app@torghut-db-rw.torghut.svc.cluster.local:5432/torghut_sim_old_run',
          runtime_simulation_dsn:
            'postgresql://torghut_app@torghut-db-rw.torghut.svc.cluster.local:5432/torghut_sim_old_run',
        },
      },
      {
        runId: 'sim-warm-proof',
        profile: 'compact',
      },
    )

    expect(manifest.clickhouse).toMatchObject({
      simulation_database: 'torghut_sim_default',
    })
    expect(manifest.postgres).toMatchObject({
      simulation_dsn: 'postgresql://torghut_app@torghut-db-rw.torghut.svc.cluster.local:5432/torghut_sim_default',
      runtime_simulation_dsn:
        'postgresql://torghut_app@torghut-db-rw.torghut.svc.cluster.local:5432/torghut_sim_default',
    })
  })

  it('resolves a writable workflow output root for relative artifact paths', () => {
    expect(__private.resolveWorkflowOutputRoot('artifacts/torghut/simulations')).toBe(
      '/tmp/torghut-simulations/artifacts/torghut/simulations',
    )
    expect(__private.resolveWorkflowOutputRoot('/tmp/custom-output')).toBe('/tmp/custom-output')
  })

  it('derives expected artifact paths from run id and dump format', () => {
    const artifacts = __private.expectedArtifactsForRun('Sim-2026/03/06#Open', '/tmp/runs', 'jsonl.gz')
    const dump = artifacts.find((artifact) => artifact.name.endsWith('.jsonl.gz'))

    expect(dump?.path).toBe('/tmp/runs/sim_2026_03_06_open/source-dump.jsonl.gz')
  })

  it('parses a valid simulation campaign submission request', () => {
    const parsed = parseTorghutSimulationCampaignRequest({
      campaignId: 'open-hour-campaign',
      name: 'Open hour robustness',
      manifest: {
        dataset_id: 'dataset-a',
        strategy_spec_ref: 'strategy-specs/intraday_tsmom_v1@1.1.0.json',
      },
      windows: [
        {
          start: '2026-03-06T14:30:00Z',
          end: '2026-03-06T15:30:00Z',
          label: 'open-1',
        },
      ],
      candidateRef: 'intraday_tsmom_v1@candidate',
      candidateRefs: ['intraday_tsmom_v1@candidate', 'intraday_tsmom_v1@baseline'],
      baselineCandidateRef: 'intraday_tsmom_v1@baseline',
      strategyRef: 'strategy-specs/intraday_tsmom_v1@1.1.0.json',
      windowSetRef: 'windows/open-hour',
      simulationProfile: 'hourly',
      costModelVersion: 'cost-model-v3',
      artifactRoot: 'artifacts/torghut/simulations/campaigns/open-hour-campaign',
      gateConfigRef: 'gates/tsmom-profitability-v1.json',
      campaignMode: 'baseline_vs_candidate',
      profile: 'hourly',
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.candidateRef).toBe('intraday_tsmom_v1@candidate')
    expect(parsed.value.candidateRefs).toEqual(['intraday_tsmom_v1@candidate', 'intraday_tsmom_v1@baseline'])
    expect(parsed.value.strategyRef).toBe('strategy-specs/intraday_tsmom_v1@1.1.0.json')
    expect(parsed.value.windows[0]?.label).toBe('open-1')
  })

  it('builds deterministic campaign run ids', () => {
    expect(
      __private.buildCampaignRunId('autonomy-ramp', 'intraday_tsmom_v1@candidate', {
        start: '2026-03-06T14:30:00Z',
        end: '2026-03-06T15:30:00Z',
        label: 'open-1',
      }),
    ).toBe('autonomy_ramp-intraday_tsmom_v1_candidate-2026_03_06t14_30_00z-open_1')
  })

  it('exposes TSMOM-focused presets only', async () => {
    const presets = await listTorghutSimulationPresets()
    expect(presets.length).toBeGreaterThan(0)
    expect(presets.every((preset) => JSON.stringify(preset.manifest).includes('intraday_tsmom_v1'))).toBe(true)
  })
})
