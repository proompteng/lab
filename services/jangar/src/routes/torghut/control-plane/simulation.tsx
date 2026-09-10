import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@proompteng/design/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

type SimulationRun = {
  runId: string
  status: string
  workflowPhase: string | null
  profile: string
  cachePolicy: string
  candidateRef: string | null
  strategyRef: string | null
  datasetId: string | null
  artifactRoot: string | null
  updatedAt: string
}

type SimulationArtifact = {
  name: string
  path: string
  kind: string
  updatedAt: string
}

type SimulationCampaign = {
  campaignId: string
  name: string
  status: string
  createdAt: string
  updatedAt: string
  summary: {
    totalRuns?: number
    statuses?: Record<string, number>
    runIds?: string[]
    candidateRefs?: string[]
  }
}

type SimulationPreset = {
  id: string
  name: string
  description: string
  profile: string
  cachePolicy: string
  manifest: Record<string, unknown>
}

const defaultManifest = {
  dataset_id: 'torghut-smoke-open-hour-20260306',
  candidate_id: 'intraday_tsmom_v1@prod',
  baseline_candidate_id: 'intraday_tsmom_v1@baseline',
  strategy_spec_ref: 'strategy-specs/intraday_tsmom_v1@1.1.0.json',
  model_refs: ['rules/intraday_tsmom_v1'],
  window: {
    start: '2026-03-06T14:30:00Z',
    end: '2026-03-06T15:30:00Z',
  },
  performance: {
    replayProfile: 'hourly',
    dumpFormat: 'jsonl.zst',
  },
  cachePolicy: 'prefer_cache',
}

const jsonPretty = JSON.stringify(defaultManifest, null, 2)
const defaultCampaignWindows = JSON.stringify(
  [
    {
      start: defaultManifest.window.start,
      end: defaultManifest.window.end,
      label: 'open-hour',
    },
  ],
  null,
  2,
)

export const Route = createFileRoute('/torghut/control-plane/simulation')({
  component: TorghutSimulationControlPlane,
})

const toneByStatus: Record<string, string> = {
  submitted: 'border-zinc-700 bg-zinc-900 text-zinc-200',
  pending: 'border-zinc-700 bg-zinc-900 text-zinc-200',
  running: 'border-sky-500/40 bg-sky-500/10 text-sky-100',
  succeeded: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100',
  degraded: 'border-amber-500/40 bg-amber-500/10 text-amber-100',
  failed: 'border-red-500/40 bg-red-500/10 text-red-100',
  cancelled: 'border-amber-500/40 bg-amber-500/10 text-amber-100',
}

const formatTimestamp = (value: string | null | undefined) => {
  if (!value) return 'n/a'
  return value.replace('T', ' ').replace('Z', ' UTC')
}

function TorghutSimulationControlPlane() {
  const [manifestText, setManifestText] = React.useState(jsonPretty)
  const [runIdInput, setRunIdInput] = React.useState('')
  const [campaignName, setCampaignName] = React.useState('TSMOM robustness')
  const [campaignCandidatesText, setCampaignCandidatesText] = React.useState(
    'intraday_tsmom_v1@candidate\nintraday_tsmom_v1@baseline',
  )
  const [campaignWindowsText, setCampaignWindowsText] = React.useState(defaultCampaignWindows)
  const [runs, setRuns] = React.useState<SimulationRun[]>([])
  const [selectedRun, setSelectedRun] = React.useState<SimulationRun | null>(null)
  const [artifacts, setArtifacts] = React.useState<SimulationArtifact[]>([])
  const [presets, setPresets] = React.useState<SimulationPreset[]>([])
  const [campaigns, setCampaigns] = React.useState<SimulationCampaign[]>([])
  const [selectedCampaign, setSelectedCampaign] = React.useState<SimulationCampaign | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [submittingCampaign, setSubmittingCampaign] = React.useState(false)

  const loadRuns = React.useCallback(async () => {
    const response = await fetch('/api/torghut/simulation/runs?limit=15')
    const payload = (await response.json().catch(() => null)) as { ok?: boolean; runs?: SimulationRun[] } | null
    if (!response.ok || !payload?.ok) {
      throw new Error('Failed to load simulation runs')
    }
    React.startTransition(() => {
      setRuns(payload.runs ?? [])
      if (!selectedRun && payload.runs?.[0]) {
        setSelectedRun(payload.runs[0])
      }
    })
  }, [selectedRun])

  const loadArtifacts = React.useCallback(async (runId: string) => {
    const response = await fetch(`/api/torghut/simulation/artifacts?run_id=${encodeURIComponent(runId)}`)
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean
      artifacts?: SimulationArtifact[]
    } | null
    if (!response.ok || !payload?.ok) {
      throw new Error('Failed to load simulation artifacts')
    }
    React.startTransition(() => {
      setArtifacts(payload.artifacts ?? [])
    })
  }, [])

  const loadPresets = React.useCallback(async () => {
    const response = await fetch('/api/torghut/simulation/presets')
    const payload = (await response.json().catch(() => null)) as { ok?: boolean; presets?: SimulationPreset[] } | null
    if (!response.ok || !payload?.ok) {
      throw new Error('Failed to load simulation presets')
    }
    React.startTransition(() => {
      setPresets(payload.presets ?? [])
    })
  }, [])

  const loadCampaigns = React.useCallback(async () => {
    const response = await fetch('/api/torghut/simulation/campaigns?limit=10')
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean
      campaigns?: SimulationCampaign[]
    } | null
    if (!response.ok || !payload?.ok) {
      throw new Error('Failed to load simulation campaigns')
    }
    React.startTransition(() => {
      setCampaigns(payload.campaigns ?? [])
      if (!selectedCampaign && payload.campaigns?.[0]) {
        setSelectedCampaign(payload.campaigns[0])
      }
    })
  }, [selectedCampaign])

  const applyPreset = React.useCallback((preset: SimulationPreset) => {
    const campaignConfig =
      typeof preset.manifest.campaign === 'object' &&
      preset.manifest.campaign &&
      !Array.isArray(preset.manifest.campaign)
        ? (preset.manifest.campaign as { windows?: unknown })
        : null
    const campaignWindows = Array.isArray(campaignConfig?.windows)
      ? campaignConfig.windows
      : [
          {
            start: (preset.manifest.window as { start?: string } | undefined)?.start ?? defaultManifest.window.start,
            end: (preset.manifest.window as { end?: string } | undefined)?.end ?? defaultManifest.window.end,
            label: preset.id,
          },
        ]
    const candidateRef =
      typeof preset.manifest.candidate_id === 'string' ? preset.manifest.candidate_id : 'intraday_tsmom_v1@candidate'
    const baselineRef =
      typeof preset.manifest.baseline_candidate_id === 'string'
        ? preset.manifest.baseline_candidate_id
        : 'intraday_tsmom_v1@baseline'

    React.startTransition(() => {
      setManifestText(JSON.stringify(preset.manifest, null, 2))
      setCampaignName(preset.name)
      setCampaignCandidatesText(`${candidateRef}\n${baselineRef}`)
      setCampaignWindowsText(JSON.stringify(campaignWindows, null, 2))
    })
  }, [])

  React.useEffect(() => {
    void loadRuns().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load simulation runs')
    })
    void loadPresets().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load simulation presets')
    })
    void loadCampaigns().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load simulation campaigns')
    })
  }, [loadCampaigns, loadPresets, loadRuns])

  React.useEffect(() => {
    if (!selectedRun) return
    void loadArtifacts(selectedRun.runId).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load simulation artifacts')
    })

    const es = new EventSource(`/api/torghut/simulation/stream?run_id=${encodeURIComponent(selectedRun.runId)}`)
    const onMessage = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as
          | { type: 'torghut.simulation.snapshot'; run: SimulationRun | null }
          | { type: 'error'; message: string }
        if (payload.type === 'error') {
          setError(payload.message)
          return
        }
        if (!payload.run) return
        const run = payload.run
        React.startTransition(() => {
          setSelectedRun(run)
          setRuns((current) => {
            const next = [...current]
            const index = next.findIndex((item) => item.runId === run.runId)
            if (index >= 0) next[index] = run
            else next.unshift(run)
            return next.slice(0, 15)
          })
        })
      } catch {
        // ignore malformed stream frames
      }
    }

    es.addEventListener('message', onMessage)
    return () => {
      es.removeEventListener('message', onMessage)
      es.close()
    }
  }, [loadArtifacts, selectedRun?.runId])

  const submitRun = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const manifest = JSON.parse(manifestText) as Record<string, unknown>
      const response = await fetch('/api/torghut/simulation/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: runIdInput || undefined,
          manifest,
        }),
      })
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean
        run?: SimulationRun
        message?: string
      } | null
      if (!response.ok || !payload?.ok || !payload.run) {
        throw new Error(payload?.message ?? 'Simulation submission failed')
      }
      React.startTransition(() => {
        setSelectedRun(payload.run ?? null)
        setRuns((current) =>
          [payload.run!, ...current.filter((item) => item.runId !== payload.run!.runId)].slice(0, 15),
        )
      })
      await loadArtifacts(payload.run.runId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Simulation submission failed')
    } finally {
      setSubmitting(false)
    }
  }

  const submitCampaign = async () => {
    setSubmittingCampaign(true)
    setError(null)
    try {
      const manifest = JSON.parse(manifestText) as Record<string, unknown>
      const windows = JSON.parse(campaignWindowsText) as Array<{ start: string; end: string; label?: string }>
      const candidateRefs = campaignCandidatesText
        .split(/\r?\n|,/)
        .map((value) => value.trim())
        .filter(Boolean)

      const response = await fetch('/api/torghut/simulation/campaigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: campaignName,
          manifest,
          windows,
          candidateRefs,
          profile:
            typeof manifest.performance === 'object' && manifest.performance && !Array.isArray(manifest.performance)
              ? ((manifest.performance as { replayProfile?: string }).replayProfile ?? undefined)
              : undefined,
          cachePolicy: typeof manifest.cachePolicy === 'string' ? manifest.cachePolicy : undefined,
        }),
      })
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean
        campaign?: SimulationCampaign
        runs?: SimulationRun[]
        message?: string
      } | null
      if (!response.ok || !payload?.ok || !payload.campaign) {
        throw new Error(payload?.message ?? 'Simulation campaign submission failed')
      }
      React.startTransition(() => {
        setSelectedCampaign(payload.campaign ?? null)
        setCampaigns((current) =>
          [payload.campaign!, ...current.filter((item) => item.campaignId !== payload.campaign!.campaignId)].slice(
            0,
            10,
          ),
        )
        if (payload.runs?.[0]) {
          setSelectedRun(payload.runs[0])
          setRuns((current) => {
            const next = [...payload.runs!, ...current]
            const deduped = next.filter(
              (item, index, arr) => arr.findIndex((candidate) => candidate.runId === item.runId) === index,
            )
            return deduped.slice(0, 15)
          })
        }
      })
      if (payload.runs?.[0]) {
        await loadArtifacts(payload.runs[0].runId)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Simulation campaign submission failed')
    } finally {
      setSubmittingCampaign(false)
    }
  }

  return (
    <div className="h-full w-full overflow-auto bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Torghut Simulation Control Plane</h1>
            <p className="text-sm text-zinc-400">
              Launch authoritative TSMOM replay runs through Jangar and track workflow-backed status with deterministic
              artifact expectations.
            </p>
          </div>
          <Link
            to="/torghut/control-plane"
            className="inline-flex h-9 items-center rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm hover:bg-zinc-800"
          >
            Back to quant plane
          </Link>
        </div>

        {error ? (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100">{error}</div>
        ) : null}

        <Card className="border-zinc-800/80 bg-zinc-950/70">
          <CardHeader>
            <CardTitle className="text-sm">Presets</CardTitle>
            <CardDescription className="text-zinc-400">
              TSMOM-first presets for fast proof, open-hour validation, and robustness campaigns.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {presets.length === 0 ? (
              <div className="rounded-md border border-dashed border-zinc-700 p-4 text-sm text-zinc-400">
                Presets have not loaded yet.
              </div>
            ) : (
              presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="rounded-md border border-zinc-800 bg-zinc-900/70 p-4 text-left hover:border-zinc-600 hover:bg-zinc-900"
                  onClick={() => applyPreset(preset)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-zinc-100">{preset.name}</div>
                    <Badge variant="outline" className="font-mono text-[0.7rem]">
                      {preset.profile}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-zinc-400">{preset.description}</p>
                  <div className="mt-3 text-xs text-zinc-500">cache: {preset.cachePolicy}</div>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.3fr_0.9fr]">
          <Card className="border-zinc-800/80 bg-zinc-950/70">
            <CardHeader>
              <CardTitle className="text-sm">Launch Replay</CardTitle>
              <CardDescription className="text-zinc-400">
                Submit the manifest object Jangar should send to the historical simulation workflow.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <input
                className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-zinc-500/50"
                placeholder="optional run id"
                value={runIdInput}
                onChange={(event) => setRunIdInput(event.target.value)}
              />
              <textarea
                className="min-h-[420px] rounded-md border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs leading-5 outline-none focus:ring-2 focus:ring-zinc-500/50"
                value={manifestText}
                onChange={(event) => setManifestText(event.target.value)}
                spellCheck={false}
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="inline-flex h-10 items-center rounded-md border border-zinc-700 bg-zinc-100 px-4 text-sm font-medium text-zinc-950 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void submitRun()}
                  disabled={submitting}
                >
                  {submitting ? 'Submitting...' : 'Launch simulation run'}
                </button>
                <button
                  type="button"
                  className="inline-flex h-10 items-center rounded-md border border-zinc-700 bg-zinc-900 px-4 text-sm font-medium hover:bg-zinc-800"
                  onClick={() => setManifestText(jsonPretty)}
                >
                  Reset sample
                </button>
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-4">
            <Card className="border-zinc-800/80 bg-zinc-950/70">
              <CardHeader>
                <CardTitle className="text-sm">Launch Campaign</CardTitle>
                <CardDescription className="text-zinc-400">
                  Submit a deterministic multi-window TSMOM campaign through the same replay backend.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <input
                  className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-zinc-500/50"
                  placeholder="campaign name"
                  value={campaignName}
                  onChange={(event) => setCampaignName(event.target.value)}
                />
                <textarea
                  className="min-h-[96px] rounded-md border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs leading-5 outline-none focus:ring-2 focus:ring-zinc-500/50"
                  value={campaignCandidatesText}
                  onChange={(event) => setCampaignCandidatesText(event.target.value)}
                  spellCheck={false}
                />
                <textarea
                  className="min-h-[150px] rounded-md border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs leading-5 outline-none focus:ring-2 focus:ring-zinc-500/50"
                  value={campaignWindowsText}
                  onChange={(event) => setCampaignWindowsText(event.target.value)}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center rounded-md border border-zinc-700 bg-zinc-100 px-4 text-sm font-medium text-zinc-950 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void submitCampaign()}
                  disabled={submittingCampaign}
                >
                  {submittingCampaign ? 'Submitting campaign...' : 'Launch campaign'}
                </button>
              </CardContent>
            </Card>

            <Card className="border-zinc-800/80 bg-zinc-950/70">
              <CardHeader>
                <CardTitle className="text-sm">Recent Campaigns</CardTitle>
                <CardDescription className="text-zinc-400">
                  Campaign registry for multi-window replay bundles and autonomy evidence.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {campaigns.length === 0 ? (
                  <div className="rounded-md border border-dashed border-zinc-700 p-4 text-sm text-zinc-400">
                    No simulation campaigns recorded yet.
                  </div>
                ) : (
                  campaigns.map((campaign) => (
                    <button
                      key={campaign.campaignId}
                      type="button"
                      className="rounded-md border border-zinc-800 bg-zinc-900/70 p-3 text-left hover:border-zinc-600 hover:bg-zinc-900"
                      onClick={() => setSelectedCampaign(campaign)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium text-zinc-100">{campaign.name}</div>
                        <Badge className={toneByStatus[campaign.status] ?? toneByStatus.submitted}>
                          {campaign.status}
                        </Badge>
                      </div>
                      <div className="mt-2 text-xs text-zinc-400">
                        {campaign.summary.totalRuns ?? 0} runs · {formatTimestamp(campaign.updatedAt)}
                      </div>
                    </button>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-zinc-800/80 bg-zinc-950/70">
              <CardHeader>
                <CardTitle className="text-sm">Recent Runs</CardTitle>
                <CardDescription className="text-zinc-400">
                  Jangar-backed registry of recent simulation submissions.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {runs.length === 0 ? (
                  <div className="rounded-md border border-dashed border-zinc-700 p-4 text-sm text-zinc-400">
                    No simulation runs recorded yet.
                  </div>
                ) : (
                  runs.map((run) => (
                    <button
                      key={run.runId}
                      type="button"
                      className="rounded-md border border-zinc-800 bg-zinc-900/70 p-3 text-left hover:border-zinc-600 hover:bg-zinc-900"
                      onClick={() => setSelectedRun(run)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-mono text-xs text-zinc-200">{run.runId}</div>
                        <Badge className={toneByStatus[run.status] ?? toneByStatus.submitted}>{run.status}</Badge>
                      </div>
                      <div className="mt-2 text-xs text-zinc-400">
                        {run.datasetId ?? 'no dataset'} · {run.profile} · {formatTimestamp(run.updatedAt)}
                      </div>
                    </button>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-zinc-800/80 bg-zinc-950/70">
              <CardHeader>
                <CardTitle className="text-sm">Selected Campaign</CardTitle>
                <CardDescription className="text-zinc-400">
                  Campaign-level status summary and deterministic run bundle.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {selectedCampaign ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className={toneByStatus[selectedCampaign.status] ?? toneByStatus.submitted}>
                        {selectedCampaign.status}
                      </Badge>
                      <Badge variant="outline" className="font-mono text-[0.7rem]">
                        runs: {selectedCampaign.summary.totalRuns ?? 0}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                      <Info label="Campaign id" value={selectedCampaign.campaignId} mono />
                      <Info label="Updated" value={formatTimestamp(selectedCampaign.updatedAt)} />
                    </div>
                    <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
                      <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Status breakdown</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {Object.entries(selectedCampaign.summary.statuses ?? {}).map(([key, value]) => (
                          <Badge key={key} variant="outline" className="font-mono text-[0.7rem]">
                            {key}: {value}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
                      <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Candidates</div>
                      <div className="mt-2 break-all font-mono text-xs text-zinc-300">
                        {(selectedCampaign.summary.candidateRefs ?? []).join(', ') || 'n/a'}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="rounded-md border border-dashed border-zinc-700 p-4 text-sm text-zinc-400">
                    Launch or select a campaign to inspect the run bundle.
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-zinc-800/80 bg-zinc-950/70">
              <CardHeader>
                <CardTitle className="text-sm">Selected Run</CardTitle>
                <CardDescription className="text-zinc-400">
                  Workflow-backed state and expected artifact bundle.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {selectedRun ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className={toneByStatus[selectedRun.status] ?? toneByStatus.submitted}>
                        {selectedRun.status}
                      </Badge>
                      <Badge variant="outline" className="font-mono text-[0.7rem]">
                        workflow: {selectedRun.workflowPhase ?? 'n/a'}
                      </Badge>
                      <Badge variant="outline" className="font-mono text-[0.7rem]">
                        profile: {selectedRun.profile}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
                      <Info label="Run id" value={selectedRun.runId} mono />
                      <Info label="Dataset" value={selectedRun.datasetId ?? 'n/a'} mono />
                      <Info label="Candidate" value={selectedRun.candidateRef ?? 'n/a'} mono />
                      <Info label="Strategy spec" value={selectedRun.strategyRef ?? 'n/a'} mono />
                      <Info label="Cache policy" value={selectedRun.cachePolicy} />
                      <Info label="Artifact root" value={selectedRun.artifactRoot ?? 'n/a'} mono />
                    </div>
                    <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
                      <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Expected artifacts</div>
                      <div className="mt-2 flex flex-col gap-2">
                        {artifacts.map((artifact) => (
                          <div key={artifact.name} className="rounded-md border border-zinc-800 bg-zinc-950/70 p-2">
                            <div className="font-mono text-xs text-zinc-200">{artifact.name}</div>
                            <div className="mt-1 break-all text-[11px] text-zinc-500">{artifact.path}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="rounded-md border border-dashed border-zinc-700 p-4 text-sm text-zinc-400">
                    Select or launch a run to inspect status and artifacts.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

function Info(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">{props.label}</div>
      <div className={`mt-1 text-sm text-zinc-100 ${props.mono ? 'font-mono text-xs' : ''}`}>{props.value}</div>
    </div>
  )
}
