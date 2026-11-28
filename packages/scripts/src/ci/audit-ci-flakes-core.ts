import { stripVTControlCharacters } from 'node:util'
import { z } from 'zod'

const id = z.int().positive()
const name = z.string().min(1)
const date = z.iso.datetime({ offset: true }).nullish()
const conclusion = z
  .enum([
    'success',
    'failure',
    'timed_out',
    'cancelled',
    'startup_failure',
    'action_required',
    'skipped',
    'neutral',
    'stale',
  ])
  .nullable()

export const runSchema = z.object({ id, workflow_id: id, name, run_attempt: id })
export const jobSchema = z.object({
  id,
  run_attempt: id,
  name,
  status: z.string(),
  conclusion,
  labels: z.array(z.string()),
  steps: z
    .array(z.object({ number: z.int().nonnegative(), name, conclusion, started_at: date, completed_at: date }))
    .default([]),
})
export const fixtureSchema = z.object({
  runs: z.array(runSchema.extend({ jobs: z.array(jobSchema.extend({ log: z.string().optional() })) })),
})

type Job = z.infer<typeof jobSchema>
type Conclusion = z.infer<typeof conclusion>
type TimeoutLog = { jobTimedOut: boolean; timedOutSteps: Set<number> }
type AuditedJob = Job & { timeoutLog?: TimeoutLog | null }
export type AuditRun = z.infer<typeof runSchema> & { jobs: AuditedJob[] }

const failed = (result: Conclusion) =>
  result === 'failure' || result === 'startup_failure' || result === 'action_required'
const affected = (result: Conclusion) => failed(result) || result === 'timed_out' || result === 'cancelled'
const hasTimeoutConclusion = (job: Job) =>
  job.conclusion === 'timed_out' || job.steps.some((step) => step.conclusion === 'timed_out')

export const needsFailureLog = (job: Job) =>
  !hasTimeoutConclusion(job) &&
  (failed(job.conclusion) || (job.conclusion === 'cancelled' && job.steps.some((step) => affected(step.conclusion))))

const runnerTimeout =
  /^##\[error\](?:(.+) has timed out after \d+ minutes?|The job(?: running on runner .+)? has exceeded the maximum execution time.*)\.?$/i
const processTimeout =
  /^(?:\^\s*)?(?:error:\s*)?(?:(?:this )?test|subprocess|(?:child )?process|command) timed out after \d+(?:\.\d+)?\s*(?:ms|s|m|seconds?|minutes?)\.?$/i

export const withFailureLog = (job: Job, log?: string): AuditedJob => {
  if (!needsFailureLog(job)) return job
  if (log === undefined) return { ...job, timeoutLog: null }

  const windows = job.steps.flatMap((step) =>
    step.started_at && step.completed_at
      ? [{ step, start: Date.parse(step.started_at), end: Date.parse(step.completed_at) }]
      : [],
  )
  const timeoutLog: TimeoutLog = { jobTimedOut: false, timedOutSteps: new Set() }
  for (const line of log.split('\n')) {
    const separator = line.indexOf(' ')
    if (separator === -1) continue
    const message = stripVTControlCharacters(line.slice(separator + 1)).trim()
    const runner = runnerTimeout.exec(message)
    if (!runner && !processTimeout.test(message)) continue
    const time = Date.parse(line.slice(0, separator))
    if (!Number.isFinite(time)) continue
    // Job metadata rounds to seconds; log lines include fractional seconds.
    const matching = windows.filter(({ start, end }) => time >= start && time < end + 1000)
    if (runner || (matching.length > 0 && matching.every(({ step }) => affected(step.conclusion)))) {
      timeoutLog.jobTimedOut = true
      const namedStep = runner?.[1]?.replace(/^The action '(.+)'$/i, '$1')
      const candidates = namedStep
        ? job.steps.filter((step) => step.name === namedStep)
        : matching.map(({ step }) => step)
      if (candidates.length === 1 && affected(candidates[0].conclusion)) {
        timeoutLog.timedOutSteps.add(candidates[0].number)
      }
    }
  }
  return { ...job, timeoutLog }
}

const trackedLabels = ['arc-amd64', 'arc-arm64', 'ubuntu-latest'] as const
const buckets = [...trackedLabels, 'other'] as const
type RunnerLabel = (typeof buckets)[number]
const runnerLabels = (job: Job): RunnerLabel[] => {
  const labels = trackedLabels.filter((label) => job.labels.includes(label))
  return labels.length ? labels : ['other']
}

const remediation = [
  {
    classification: 'deterministic_regression',
    priority: 'P1',
    action: 'Reproduce the failing step on the same revision; keep the check required until the cause is verified.',
  },
  {
    classification: 'runner_timeout',
    priority: 'P2',
    action:
      'Compare the failing step and runner pool; inspect subprocess startup, image pulls and preload budgets before raising limits.',
  },
  {
    classification: 'flake_retry_passed',
    priority: 'P3',
    action:
      'Compare the failed and passing attempts; isolate the unstable test or dependency and track a fix with its owner.',
  },
  {
    classification: 'infra_cancelled',
    priority: 'P4',
    action:
      'Check concurrency supersession, manual cancellation and runner loss before attributing this to a code change.',
  },
] as const

type Diagnosis =
  | { classification: 'runner_timeout'; evidence: 'conclusion' | 'log' }
  | { classification: 'infra_cancelled' | 'deterministic_regression' }
  | { classification: 'flake_retry_passed'; passedOnAttempt: number }

const diagnose = (
  result: Conclusion,
  timeout: 'conclusion' | 'log' | undefined,
  passedOnAttempt?: number,
): Diagnosis => {
  if (timeout) return { classification: 'runner_timeout', evidence: timeout }
  if (result === 'cancelled') return { classification: 'infra_cancelled' }
  if (passedOnAttempt !== undefined) return { classification: 'flake_retry_passed', passedOnAttempt }
  return { classification: 'deterministic_regression' }
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byAttempt = (a: Job, b: Job) => a.run_attempt - b.run_attempt || a.id - b.id
const displayName = (value: string): string => {
  const plain = stripVTControlCharacters(value)
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
  // Only metadata display names are reportable, and never if they resemble credentials or connection strings.
  if (
    /:\/\/|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?|jdbc|sqlite):|-----BEGIN .*PRIVATE KEY/i.test(
      plain,
    ) ||
    /\b(?:github_pat_|gh[pousr]_|sk-|xox[baprs]-|nvapi-|auto_ontology_)[\w-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[\w-]{35}\b|\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/i.test(
      plain,
    ) ||
    /\b(?:basic|bearer)\s+\S+|\b[\w-]*(?:password|passwd|secret|token|api[_-]?key|database[_-]?url)["']?\s*[:=]/i.test(
      plain,
    )
  ) {
    return '[redacted]'
  }
  return plain
}

const observationsForRun = (run: AuditRun, workflow: string) => {
  const jobs = run.jobs
    .filter((job) => job.run_attempt <= run.run_attempt && job.status === 'completed')
    .sort(byAttempt)
  const byName = Map.groupBy(jobs, (job) => job.name)
  return jobs
    .filter((job) => job.conclusion === 'success' || affected(job.conclusion))
    .map((job) => {
      const runner = runnerLabels(job)
      if (job.conclusion === 'success') return { runner, finding: null }

      // A rerun can omit jobs, and matrix entries can have indistinguishable names.
      const sameName = byName.get(job.name) ?? []
      const attempts = Map.groupBy(sameName, (candidate) => candidate.run_attempt)
      const retries =
        attempts.get(job.run_attempt)?.length === 1
          ? sameName.filter(
              (candidate) =>
                candidate.run_attempt > job.run_attempt && attempts.get(candidate.run_attempt)?.length === 1,
            )
          : []
      const passed = retries.find((candidate) => candidate.conclusion === 'success')
      const timeout = hasTimeoutConclusion(job) ? 'conclusion' : job.timeoutLog?.jobTimedOut ? 'log' : undefined
      return {
        runner,
        finding: {
          workflowId: run.workflow_id,
          workflow,
          runId: run.id,
          attempt: job.run_attempt,
          jobId: job.id,
          job: job.name,
          runnerLabels: runner,
          ...diagnose(job.conclusion, timeout, passed?.run_attempt),
          failureLogUnavailable: job.timeoutLog === null,
          steps: job.steps
            .filter((step) => affected(step.conclusion))
            .sort((a, b) => a.number - b.number || compareText(a.name, b.name))
            .map((step) => {
              const passed = retries.find((candidate) =>
                candidate.steps.some(
                  (retry) => retry.number === step.number && retry.name === step.name && retry.conclusion === 'success',
                ),
              )
              const timeout =
                step.conclusion === 'timed_out'
                  ? 'conclusion'
                  : job.timeoutLog?.timedOutSteps.has(step.number)
                    ? 'log'
                    : undefined
              return {
                number: step.number,
                step: displayName(step.name),
                ...diagnose(step.conclusion, timeout, passed?.run_attempt),
              }
            }),
        },
      }
    })
}

type Observation = ReturnType<typeof observationsForRun>[number]

const summarize = (observations: Observation[]) => {
  const findings = observations.flatMap(({ finding }) => (finding ? [finding] : []))
  const failures = findings.filter((finding) => finding.classification !== 'infra_cancelled')
  const timedOut = failures.filter((finding) => finding.classification === 'runner_timeout').length
  const cancelled = findings.length - failures.length
  const completed = observations.length - cancelled
  const recurring = [...Map.groupBy(failures, ({ workflowId, job }) => JSON.stringify([workflowId, job])).values()]
    .filter((group) => group.length > 1)
    .map(([first, ...rest]) => ({
      workflowId: first.workflowId,
      workflow: first.workflow,
      job: first.job,
      failures: 1 + rest.length,
    }))
    .sort(
      (a, b) =>
        b.failures - a.failures ||
        compareText(a.workflow, b.workflow) ||
        a.workflowId - b.workflowId ||
        compareText(a.job, b.job),
    )
    .slice(0, 5)
    .map((entry) => ({ ...entry, job: displayName(entry.job) }))

  return {
    jobAttempts: observations.length,
    failed: failures.length,
    timedOut,
    cancelled,
    failureRate: completed ? failures.length / completed : null,
    timeoutRate: completed ? timedOut / completed : null,
    topFailingJobs: recurring,
  }
}

export const auditCIFlakes = (runs: AuditRun[]) => {
  const groups = [...Map.groupBy(runs, (run) => run.workflow_id)]
    .map(([workflowId, group]) => {
      const ordered = group.sort((a, b) => b.id - a.id)
      const workflow = displayName(ordered[0].name)
      return {
        workflowId,
        workflow,
        runs: group.length,
        observations: ordered.flatMap((run) => observationsForRun(run, workflow)),
      }
    })
    .sort((a, b) => compareText(a.workflow, b.workflow) || a.workflowId - b.workflowId)
  const observations = groups.flatMap((group) => group.observations)
  const findings = observations.flatMap(({ finding }) =>
    finding ? [{ ...finding, job: displayName(finding.job) }] : [],
  )
  return {
    runs: runs.length,
    failureLogsUnavailable: findings.filter((finding) => finding.failureLogUnavailable).length,
    byWorkflow: groups.map(({ observations, ...group }) => ({ ...group, ...summarize(observations) })),
    byRunnerLabel: buckets.map((label) => ({
      label,
      ...summarize(observations.filter(({ runner }) => runner.includes(label))),
    })),
    priorities: remediation.flatMap((item) => {
      const jobAttempts = findings.filter((finding) => finding.classification === item.classification).length
      return jobAttempts ? [{ ...item, jobAttempts }] : []
    }),
    findings,
  }
}

type Report = ReturnType<typeof auditCIFlakes>
const cell = (value: string) => value.replace(/[&<>[\]|\\`*_~]/g, (character) => `&#${character.charCodeAt(0)};`)
const row = (...values: (string | number)[]) => `| ${values.join(' | ')} |`
const percent = (rate: number | null) => (rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`)
const metrics = (stats: ReturnType<typeof summarize>) => [
  stats.jobAttempts,
  stats.failed,
  stats.timedOut,
  stats.cancelled,
  percent(stats.failureRate),
  percent(stats.timeoutRate),
  stats.topFailingJobs.map((entry) => cell(`${entry.workflow} / ${entry.job} (${entry.failures})`)).join('; ') || '—',
]
const diagnosisText = (result: Diagnosis) => {
  if ('passedOnAttempt' in result) return `${result.classification} (passed on attempt ${result.passedOnAttempt})`
  if ('evidence' in result) return `${result.classification} (${result.evidence})`
  return result.classification
}

export const formatMarkdown = (report: Report) => {
  const headers = [
    'Jobs',
    'Failed',
    'Timed out',
    'Cancelled',
    'Failure rate',
    'Timeout rate',
    'Recurring jobs (failures)',
  ]
  return [
    '# CI flake and timeout triage',
    '',
    `Sample: ${report.runs} workflow runs. Failure logs unavailable: ${report.failureLogsUnavailable}.`,
    '',
    '## Remediation priorities',
    '',
    ...(report.priorities.length
      ? report.priorities.map(
          ({ priority, classification, action, jobAttempts }) =>
            `- **${priority} \`${classification}\`** (${jobAttempts} job attempts): ${action}`,
        )
      : ['No failing or cancelled job attempts in this sample.']),
    '',
    '## By workflow',
    '',
    row('Workflow (ID)', 'Runs', ...headers),
    row(...Array.from({ length: headers.length + 2 }, () => '---')),
    ...report.byWorkflow.map((stats) =>
      row(cell(`${stats.workflow} (${stats.workflowId})`), stats.runs, ...metrics(stats)),
    ),
    '',
    '## By runner label',
    '',
    row('Label', ...headers),
    row(...Array.from({ length: headers.length + 1 }, () => '---')),
    ...report.byRunnerLabel.map((stats) => row(stats.label, ...metrics(stats))),
    '',
    '## Findings',
    '',
    '| Workflow (ID) | Run | Attempt | Job (ID) | Runner labels | Classification | Affected steps |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.findings.map((finding) =>
      row(
        cell(`${finding.workflow} (${finding.workflowId})`),
        finding.runId,
        finding.attempt,
        cell(`${finding.job} (${finding.jobId})`),
        finding.runnerLabels.join(', '),
        cell(diagnosisText(finding)) + (finding.failureLogUnavailable ? ' (log unavailable)' : ''),
        finding.steps.map((step) => cell(`${step.number}. ${step.step}: ${diagnosisText(step)}`)).join('; ') || '—',
      ),
    ),
    '',
  ].join('\n')
}
