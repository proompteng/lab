import { parseArgs } from 'node:util'
import { ArcAuditError, type ArcAuditReport, auditArcRunnerPools } from './audit-arc-runner-pools-core'

const help = `Usage: bun run packages/scripts/src/galactic/audit-arc-runner-pools.ts
       (--context <kubectl-context> [--namespace <namespace>] | --fixture <path>)
       [--format json|markdown] [--fail-on-saturated]

Read ARC runner sets and runners in one namespace (default: arc) and list pods
and nodes cluster-wide to estimate placement headroom. Fixtures run offline.
Output defaults to markdown. Exit 1 on errors, or 2 on saturation when requested.`

function options(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: {
        context: { type: 'string' },
        namespace: { type: 'string' },
        fixture: { type: 'string' },
        format: { type: 'string', default: 'markdown' },
        'fail-on-saturated': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values
  } catch {
    throw new ArcAuditError('invalid options; use --help')
  }
}

async function snapshotFromFixture(file: string): Promise<unknown> {
  try {
    return await Bun.file(file).json()
  } catch {
    throw new ArcAuditError('could not read fixture as JSON')
  }
}

async function snapshotFromKubectl(context: string, namespace: string) {
  const kubectl = Bun.which('kubectl')
  if (!kubectl) throw new ArcAuditError('kubectl is not on PATH')
  const list = async (resource: string, ...scope: string[]): Promise<unknown> => {
    const process = Bun.spawn(
      [kubectl, `--context=${context}`, '--request-timeout=30s', 'get', resource, ...scope, '-o', 'json'],
      {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
      },
    )
    const [exit, raw] = await Promise.all([process.exited, new Response(process.stdout).text()])
    if (exit !== 0)
      throw new ArcAuditError(`could not list ${resource} (kubectl exit ${exit}); check context and list access`)
    try {
      return JSON.parse(raw)
    } catch {
      throw new ArcAuditError(`kubectl did not return JSON for ${resource}`)
    }
  }
  const scope = `--namespace=${namespace}`
  const [runnerSets, ephemeralRunners, pods, nodes] = await Promise.all([
    list('autoscalingrunnersets.actions.github.com', scope),
    list('ephemeralrunners.actions.github.com', scope),
    list('pods', '--all-namespaces'),
    list('nodes'),
  ])
  return { observedAt: new Date().toISOString(), runnerSets, ephemeralRunners, pods, nodes }
}

const reasonLabel: Record<ArcAuditReport['topBottleneck']['reason'], string> = {
  'max-runners': 'maxRunners cap',
  'node-cpu': 'node CPU requests',
  'node-memory': 'node memory requests',
  'node-pods': 'node pod limit',
  'pod-cidr': 'estimated PodCIDR IPs',
  'pending-scheduling': 'pending scheduling / no eligible nodes',
  'pool-outdated': 'ARC scale set Outdated',
  unknown: 'unknown (incomplete headroom data)',
}
const number = (value: number | null) => value ?? 'unknown'
const gib = (value: number | null) => (value == null ? 'unknown' : (value / 2 ** 30).toFixed(2))

function markdown(report: ArcAuditReport) {
  const { topBottleneck: top } = report
  const lines = [
    '# ARC runner pool saturation',
    '',
    `Observed at ${report.observedAt}. Saturated: **${report.saturated ? 'yes' : 'no'}**.`,
    `Top bottleneck: **${reasonLabel[top.reason]}** (${top.runnerSet}).`,
    `Pending runners become stuck after ${report.stuckAfterSeconds}s. Unmatched active runners: ${report.unmatchedActiveRunners}.`,
    '',
    'These are declared requests and estimated scale-out slots, not resource usage or GitHub queue depth.',
    '',
    '| Runner set | Active / max | Utilization | Assigned | Ready idle | Pending / stuck / scheduling blocked | Failed / terminating | Cap slots | Node fit | Scale-out slots | Bottleneck | Saturated |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |',
  ]
  for (const pool of report.runnerSets) {
    const utilization = pool.utilizationPercent == null ? 'n/a' : `${pool.utilizationPercent}%`
    lines.push(
      `| ${pool.name} | ${pool.active} / ${pool.maxRunners ?? 'unset'} | ${utilization} | ${pool.assigned} | ${pool.readyIdle} | ${pool.pending.length} / ${pool.stuck} / ${pool.schedulingBlocked} | ${pool.failed} / ${pool.terminating} | ${pool.capSlots ?? 'uncapped'} | ${number(pool.physicalSlots)} | ${number(pool.estimatedAdditionalSlots)} | ${reasonLabel[pool.bottleneck]} | ${pool.saturated ? 'yes' : 'no'} |`,
    )
  }
  lines.push(
    '',
    '## Node footprint',
    '',
    '| Node | State | Pods (requested / allocatable; runners) | CPU (m; requested / allocatable; runners) | Memory (GiB; requested / allocatable; runners) | Runner tmpfs (GiB capped; volumes; uncapped) | PodCIDR (assigned / usable; free estimate; bound without allocatable IP) |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
  )
  for (const node of report.nodes) {
    const { pods, cpuMillis: cpu, memoryBytes: mem, runnerTmpfs: tmpfs, podCidr } = node
    const addresses = podCidr
      ? `${podCidr.cidr}: ${podCidr.assignedIps} / ${podCidr.usableIpsEstimate}; ${podCidr.freeIpsEstimate}; ${podCidr.boundWithoutInRangeIp}`
      : 'unknown'
    lines.push(
      `| ${node.name} | ${node.ready ? 'ready' : 'not ready'}${node.cordoned ? ', cordoned' : ''} | ${pods.requested} / ${number(pods.allocatable)}; ${pods.runners} | ${cpu.requested} / ${number(cpu.allocatable)}; ${cpu.runners} | ${gib(mem.requested)} / ${gib(mem.allocatable)}; ${gib(mem.runners)} | ${gib(tmpfs.boundedBytes)}; ${tmpfs.volumes}; ${tmpfs.unboundedVolumes} | ${addresses} |`,
    )
  }
  lines.push(
    '',
    '## Additional runner slots by eligible node',
    '',
    '| Runner set | Node | CPU | Memory | Pod limit | PodCIDR | Minimum |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
  )
  for (const pool of report.runnerSets) {
    if (!pool.nodeFits.length) lines.push(`| ${pool.name} | None | — | — | — | — | 0 |`)
    for (const fit of pool.nodeFits) {
      const display = (limit: keyof typeof fit.ceilings) =>
        fit.ceilings[limit] === undefined ? 'n/a' : number(fit.ceilings[limit])
      lines.push(
        `| ${pool.name} | ${fit.node} | ${display('node-cpu')} | ${display('node-memory')} | ${display('node-pods')} | ${display('pod-cidr')} | ${number(fit.slots)} |`,
      )
    }
  }
  if (report.runnerSets.some((pool) => pool.pending.length)) {
    lines.push(
      '',
      '## Pending runners',
      '',
      '| Runner set | Runner | Pod | Stage | Age (s) | Stuck | Scheduling blocked |',
      '| --- | --- | --- | --- | ---: | --- | --- |',
    )
    for (const pool of report.runnerSets) {
      for (const runner of pool.pending) {
        lines.push(
          `| ${pool.name} | ${runner.name} | ${runner.pod ?? '—'} | ${runner.stage} | ${number(runner.ageSeconds)} | ${runner.stuck ? 'yes' : 'no'} | ${runner.blocked ? 'yes' : 'no'} |`,
        )
      }
    }
  }
  return lines.join('\n')
}

async function main() {
  const args = options(Bun.argv.slice(2))
  if (args.help) {
    console.log(help)
    return
  }
  if (args.format !== 'json' && args.format !== 'markdown') throw new ArcAuditError('--format must be json or markdown')
  let snapshot: unknown
  if (args.fixture !== undefined) {
    if (!args.fixture || args.context !== undefined || args.namespace !== undefined) {
      throw new ArcAuditError('--fixture requires a path and cannot be combined with --context or --namespace')
    }
    snapshot = await snapshotFromFixture(args.fixture)
  } else {
    if (!args.context?.trim()) throw new ArcAuditError('live mode requires an explicit --context')
    if (args.namespace === '') throw new ArcAuditError('--namespace cannot be empty')
    snapshot = await snapshotFromKubectl(args.context, args.namespace ?? 'arc')
  }
  const report = auditArcRunnerPools(snapshot)
  console.log(args.format === 'json' ? JSON.stringify(report, null, 2) : markdown(report))
  if (args['fail-on-saturated'] && report.saturated) process.exitCode = 2
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(`ARC audit: ${error instanceof ArcAuditError ? error.message : 'unexpected audit failure'}`)
    process.exitCode = 1
  }
}
