#!/usr/bin/env bun
import { parseArgs } from 'node:util'

import { stringify } from 'yaml'

import { CapacityInputError, measureClusterAgentCapacity } from './cluster-agent-capacity-core'

const usage = `Usage: bun run packages/scripts/src/agents/measure-cluster-agent-capacity.ts
  (--fixture <snapshot.json|-> | --context <kubectl-context> --assumptions <assumptions.json>)
  [--format json|markdown] [--target <runs>]

Read-only. Live mode lists nodes, pods, AgentRuns and node metrics. Supply measured
policy, working set, DB and external budgets separately; see docs/agents/galactic-max-agents-study.md.`

const readOptions = (args: string[]) => {
  const { values, tokens } = parseArgs({
    args,
    options: {
      fixture: { type: 'string' },
      context: { type: 'string' },
      assumptions: { type: 'string' },
      format: { type: 'string', default: 'markdown' },
      target: { type: 'string' },
      help: { type: 'boolean' },
    },
    tokens: true,
  })
  if (new Set(tokens.map((token) => (token.kind === 'option' ? token.name : token.kind))).size !== tokens.length) {
    throw new CapacityInputError(usage)
  }
  if (values.help && tokens.length === 1) return { help: true as const }
  const { fixture, context, assumptions, format, target } = values
  if (
    values.help ||
    (format !== 'json' && format !== 'markdown') ||
    (target !== undefined && !/^[1-9]\d{0,6}$/.test(target))
  ) {
    throw new CapacityInputError(usage)
  }
  const output = { help: false as const, format, target: target === undefined ? undefined : Number(target) }
  if (fixture && context === undefined && assumptions === undefined) return { ...output, fixture }
  if (context && assumptions && fixture === undefined) return { ...output, context, assumptions }
  throw new CapacityInputError(usage)
}

const readJson = async (path: string, kind: string): Promise<unknown> => {
  try {
    return await (path === '-' ? Bun.stdin : Bun.file(path)).json()
  } catch {
    throw new CapacityInputError(`Could not read ${kind} JSON`)
  }
}

const liveSnapshot = async (context: string, assumptionsFile: string) => {
  const assumptions = await readJson(assumptionsFile, 'assumptions')
  const get = async (label: string, args: string[]): Promise<unknown> => {
    let process: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>>
    try {
      process = Bun.spawn(['kubectl', `--context=${context}`, '--request-timeout=20s', 'get', ...args], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new CapacityInputError('Could not start kubectl; check the binary and context')
    }
    const [output, error, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    if (code !== 0) {
      const reason = /forbidden|unauthorized/i.test(error)
        ? 'access denied'
        : /timed out|deadline exceeded/i.test(error)
          ? 'timed out'
          : 'request failed'
      throw new CapacityInputError(`kubectl ${label}: ${reason} (exit ${code})`)
    }
    try {
      return JSON.parse(output)
    } catch {
      throw new CapacityInputError(`kubectl ${label}: invalid JSON`)
    }
  }
  const [nodes, pods, nodeMetrics, agentRuns] = await Promise.all([
    get('nodes', ['nodes', '-o', 'json']),
    get('pods', ['pods', '--all-namespaces', '-o', 'json']),
    get('node metrics', ['--raw', '/apis/metrics.k8s.io/v1beta1/nodes']),
    get('AgentRuns', ['agentruns.agents.proompteng.ai', '--all-namespaces', '-o', 'json']),
  ])
  return { capturedAt: new Date().toISOString(), assumptions, kubernetes: { nodes, pods, nodeMetrics, agentRuns } }
}

type Report = ReturnType<typeof measureClusterAgentCapacity>
const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(2)
const bound = (value: number | null) => value ?? '—'

const markdownReport = (report: Report) => {
  const { safe, theoretical, workload } = report
  const lines = [
    '# Galactic AgentRun capacity',
    '',
    `Snapshot: ${report.capturedAt}. ${report.running} running in watched namespaces.`,
    `Profile: ${workload.requests.cpu} CPU, ${workload.requests.memory} memory request; ${gib(report.p95PodWorkingSetBytes)} GiB P95 pod working set (including tmpfs); ${workload.osReservePercent}% extra RAM reserve.`,
    '',
    `**Safe model: ${safe.total} runs (${safe.additional} additional). #1: ${safe.binding}.**`,
    `Theoretical model: ${theoretical.total} runs (${theoretical.additional} additional). #1: ${theoretical.binding}.`,
    ...(safe.bindings.length > 1 ? [`Co-binding safe limits: ${safe.bindings.join(', ')}.`] : []),
    ...(safe.total < report.running ? ['Current running count already exceeds the safe model.'] : []),
    '',
    '| Limit (total runs) | Theoretical | Safe |',
    '| --- | ---: | ---: |',
    ...Object.entries(theoretical.limits).map(
      ([key, limit]) => `| ${key} | ${bound(limit)} | ${bound(safe.limits[key as keyof typeof safe.limits])} |`,
    ),
    '',
    '| Node | Free mCPU | Free request GiB | Safe physical GiB | Active / allowed pods | Succeeded | Failed | Terminal IP claims | Safe free / host IPs | Safe additional | Local binding |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...report.nodes.map(({ name, pods, maxPods, allocatablePods, safe }) => {
      const bindings = Object.entries(safe.limits)
        .filter(([, limit]) => limit === safe.additional)
        .map(([key]) => key)
      return `| ${name} | ${safe.headroom.cpuMillicores} | ${gib(safe.headroom.memoryBytes)} | ${gib(safe.headroom.physicalBytes)} | ${pods.active} / ${Math.min(maxPods, allocatablePods)} | ${pods.succeeded} | ${pods.failed} | ${pods.terminalIpClaims} | ${safe.headroom.podIps} / ${safe.hostIps} | ${safe.additional} | ${bindings.join(', ')} |`
    }),
    '',
    ...report.excludedNodes.map(({ name, reason }) => `- Excluded ${name}: ${reason}.`),
    `- CNPG: ${report.database.steadyUsed} steady / ${report.database.peakUsed} safe peak budgeted of ${report.database.maxConnections} connections before any per-run sessions.`,
    ...Object.entries(report.database.pools).map(
      ([pool, value]) => `  - ${pool}: ${value.steady} steady / ${value.peak} with surge.`,
    ),
    `- GitHub estimate: cold/warm ${theoretical.github.cold}/${theoretical.github.warm} theoretical, ${safe.github.cold}/${safe.github.warm} safe; using ${report.githubCacheEnabled ? 'warm' : 'cold'}.`,
    `- ARC estimate: ${safe.arc.availableRunners} net runner slots at ${safe.arc.runnerToAgentRatio.toFixed(3)} runner slots of demand per agent.`,
    '',
    '| Target | Additional needed | Safe now | Limits below target | Required max_connections | Required ARC maxRunners | Max REST calls/run |',
    '| ---: | ---: | --- | --- | ---: | ---: | ---: |',
    ...report.tiers.map(
      (tier) =>
        `| ${tier.target} | ${tier.additionalNeeded} | ${tier.reachable ? 'yes' : 'no'} | ${tier.blockers.join(', ') || 'none'} | ${tier.requiredMaxConnections} | ${tier.arc.minMaxRunners} | ${tier.maxGithubRequestsPerRun} |`,
    ),
    '',
  ]
  const next = report.tiers.find(({ target }) => target === report.nextTier)
  if (next) {
    lines.push(
      `## ${next.target}-run tier: Agents Helm values to review`,
      '',
      'These settings are not applied, and do not override the non-Helm blockers above. Verify terminal log and artifact retention before shortening Job TTL.',
      '',
      '```yaml',
      stringify(next.valuesYaml).trimEnd(),
      '```',
      '',
    )
    if (next.requiredRepoConcurrency !== null && next.requiredRepoConcurrency > report.controller.repoConcurrency) {
      lines.push(
        `Raise the effective repository concurrency cap for ${workload.repository} to at least ${next.requiredRepoConcurrency}; verify the active controller's rendered environment.`,
        '',
      )
    }
    if (next.conditionalRequestKnobs.length > 0 || next.p95WorkingSetCeilingBytes !== null) {
      lines.push('Conditional ceilings with all other node inputs fixed (not safe defaults):', '')
      for (const { key, maximum } of next.conditionalRequestKnobs) lines.push(`- \`${key}\`: \`${maximum}\``)
      if (next.p95WorkingSetCeilingBytes !== null)
        lines.push(
          `- P95 pod working set: ${gib(next.p95WorkingSetCeilingBytes)} GiB (${next.p95WorkingSetCeilingBytes} bytes).`,
        )
      lines.push('')
    }
    lines.push(
      `ARC scale set: ${next.arc.scaleSet}. Treat the database and ARC figures as sizing requirements, not rollout instructions.`,
      '',
    )
  }
  lines.push(
    'Rates are steady-state estimates, not launch-burst allowances. This is a snapshot model, not rollout or load-test evidence.',
  )
  return lines.join('\n')
}

if (import.meta.main) {
  try {
    let options: ReturnType<typeof readOptions>
    try {
      options = readOptions(Bun.argv.slice(2))
    } catch {
      throw new CapacityInputError(usage)
    }
    if (options.help) {
      console.log(usage)
    } else {
      const snapshot =
        'fixture' in options
          ? await readJson(options.fixture, 'snapshot')
          : await liveSnapshot(options.context, options.assumptions)
      const report = measureClusterAgentCapacity(snapshot, options.target)
      console.log(options.format === 'json' ? JSON.stringify(report, null, 2) : markdownReport(report))
    }
  } catch (error) {
    console.error(error instanceof CapacityInputError ? error.message : 'Capacity measurement failed')
    process.exitCode = 1
  }
}
