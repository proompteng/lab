#!/usr/bin/env bun

import { parseArgs } from 'node:util'

import { fleetSnapshot, inspectAgentFleetHealth, type FleetReport } from './inspect-agent-fleet-health-core'

const CONTEXT = 'galactic-tailscale'
const usage = `Usage: bun run packages/scripts/src/agents/inspect-agent-fleet-health.ts [options]

Read the Galactic AgentRun fleet using ${CONTEXT}, without mutating the cluster.

  --fixture <path>      Read a local JSON snapshot instead of using kubectl
  --format <format>     markdown (default) or json
  --fail-on-critical   Exit 1 when critical anomalies are present
  --help               Show this help`

class CliError extends Error {}

const get = async (resource: string, path: string): Promise<unknown> => {
  try {
    const child = Bun.spawn(['kubectl', '--context', CONTEXT, '--request-timeout=10s', 'get', `--raw=${path}`], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 12_000,
      killSignal: 'SIGKILL',
    })
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    if (exitCode === 0) return JSON.parse(stdout)
  } catch {
    // kubectl, credential plugins, and JSON parse errors can contain sensitive data.
  }
  throw new CliError(
    `Could not read ${resource} with kubectl on ${CONTEXT}. Check the context, connectivity, and list permissions.`,
  )
}

const readLiveSnapshot = async () => {
  // Explicit API paths also avoid kubectl's discovery cache and implicit namespace selection.
  const [agentRuns, jobs, pods, nodes, podMetrics] = await Promise.all([
    get('AgentRuns', '/apis/agents.proompteng.ai/v1alpha1/agentruns'),
    get('Jobs', '/apis/batch/v1/jobs'),
    get('Pods', '/api/v1/pods'),
    get('Nodes', '/api/v1/nodes'),
    get('PodMetrics', '/apis/metrics.k8s.io/v1beta1/pods').catch(() => null),
  ])
  return { capturedAt: new Date().toISOString(), agentRuns, jobs, pods, nodes, podMetrics }
}

const readFixture = async (path: string): Promise<unknown> => {
  try {
    return await Bun.file(path).json()
  } catch {
    throw new CliError('Could not read the fixture as JSON.')
  }
}

const markdown = ({ capturedAt, summary, nodes, memory, terminalByNamespace, anomalies }: FleetReport) =>
  [
    '# Galactic AgentRun fleet health',
    '',
    `Snapshot: ${capturedAt}`,
    '',
    `- Findings: ${summary.critical} critical, ${summary.warnings} warning`,
    `- AgentRuns: ${summary.agentRuns}; active Pods: ${summary.activePods} (${summary.scheduledActivePods} scheduled, ${summary.unassignedActivePods} unassigned)`,
    `- Memory coverage: ${memory.checkedPods}/${memory.runningPods} running Pods (metrics ${memory.metricsAvailable ? 'available' : 'unavailable'})`,
    '',
    '## Node spread',
    '',
    '| Node | Architecture | Schedulable | Active Pods | Scheduled share | Estimated free pod IPs |',
    '| --- | --- | --- | ---: | ---: | ---: |',
    ...nodes.map(
      (node) =>
        `| ${node.name} | ${node.architecture ?? 'unknown'} | ${node.schedulable ? 'yes' : 'no'} | ${node.activePods} | ${node.scheduledSharePercent}% | ${node.freePodIPs ?? 'unknown'} |`,
    ),
    '',
    `Active Pods on other nodes: ${summary.otherNodeActivePods}`,
    '',
    `## Terminal fleet Pods (${summary.terminalPods})`,
    '',
    ...(terminalByNamespace.length > 0
      ? [
          '| Namespace | Succeeded | Failed | Still reporting a pod IPv4 address |',
          '| --- | ---: | ---: | ---: |',
          ...terminalByNamespace.map(
            ({ namespace, succeeded, failed, withPodIP }) =>
              `| ${namespace} | ${succeeded} | ${failed} | ${withPodIP} |`,
          ),
        ]
      : ['None.']),
    '',
    '## Anomalies',
    '',
    ...(anomalies.length > 0
      ? anomalies.map(
          ({ severity, code, subject, message }) => `- **${severity}** \`${code}\` \`${subject}\`: ${message}`,
        )
      : ['None detected.']),
  ].join('\n')

const options = () => {
  try {
    return parseArgs({
      options: {
        fixture: { type: 'string' },
        format: { type: 'string', default: 'markdown' },
        'fail-on-critical': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values
  } catch {
    throw new CliError('Invalid arguments. Run with --help for usage.')
  }
}

const main = async () => {
  const { fixture, format, help, 'fail-on-critical': failOnCritical } = options()
  if (help) {
    console.log(usage)
    return 0
  }
  if (format !== 'json' && format !== 'markdown') throw new CliError('--format must be json or markdown.')

  const snapshot = await (fixture === undefined ? readLiveSnapshot() : readFixture(fixture))
  const result = fleetSnapshot.safeParse(snapshot)
  if (!result.success) {
    const field = result.error.issues[0]?.path[0]
    throw new CliError(
      typeof field === 'string' && Object.hasOwn(fleetSnapshot.shape, field)
        ? `Invalid fleet snapshot field: ${field}. See the fleet health runbook for the expected shape.`
        : 'Invalid fleet snapshot. See the fleet health runbook for the expected shape.',
    )
  }
  const report = inspectAgentFleetHealth(result.data)
  console.log(format === 'json' ? JSON.stringify(report, null, 2) : markdown(report))
  return failOnCritical && report.summary.critical > 0 ? 1 : 0
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(error instanceof CliError ? error.message : 'Fleet health inspection failed.')
    process.exitCode = 2
  }
}
