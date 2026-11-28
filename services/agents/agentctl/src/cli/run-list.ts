import { Command, Flag } from 'effect/cli'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import { decodeKube } from '../kube/backend'
import { rawList } from '../kube/resources'
import {
  isJobRuntime,
  isTerminalPhase,
  observeRuns,
  readRunResources,
  type RunObservation,
  runtimeType,
  timestamp,
} from '../kube/runs'
import { callUnary, formatAge, outputList, parseJson, renderTable } from '../runtime'
import { TransportService } from '../transport'
import { AgentctlContext } from './context'
import { asAgentctlError, validationError } from './errors'

export const selectorOption = Flag.optional(
  Flag.String('selector').pipe(
    Flag.withAlias('l'),
    Flag.withDescription('Filter resources by Kubernetes label selector.'),
  ),
)

export const runFilters = {
  phase: Flag.optional(Flag.String('phase').pipe(Flag.withDescription('Filter by AgentRun CR phase.'))),
  runtime: Flag.optional(Flag.String('runtime').pipe(Flag.withDescription('Filter by AgentRun runtime type.'))),
  sortBy: Flag.optional(
    Flag.Literals('sort-by', ['age', 'name', 'phase']).pipe(
      Flag.withDescription('Sort runs by age (newest first, default), name, or phase.'),
    ),
  ),
  active: Flag.Boolean('active').pipe(
    Flag.withDefault(false),
    Flag.withDescription('Show runs or pods that have not finished.'),
  ),
  stale: Flag.Boolean('stale').pipe(
    Flag.withDefault(false),
    Flag.withDescription('Show runs whose CR and workload phases disagree (kube only).'),
  ),
  limit: Flag.optional(
    Flag.Int('limit').pipe(Flag.withDescription('Show at most this many runs after filtering and sorting.')),
  ),
}

type RunFilters = { [K in keyof typeof runFilters]: (typeof runFilters)[K] extends Flag.Flag<infer A> ? A : never }

export const hasRunFilters = ({ phase, runtime, sortBy, active, stale, limit }: RunFilters) =>
  active || stale || Option.isSome(phase) || Option.isSome(runtime) || Option.isSome(sortBy) || Option.isSome(limit)

export const renderRunRows = (rows: RunObservation[], output: string) =>
  renderTable(rows, [
    { label: 'NAME', value: (row) => row.name },
    { label: 'AGENT', value: (row) => row.agent ?? '-' },
    { label: 'PHASE', value: (row) => row.phase },
    { label: 'POD_PHASE', value: (row) => row.podPhase ?? '-' },
    { label: 'NODE', value: (row) => row.node ?? '-' },
    { label: 'HEAD', value: (row) => row.head ?? '-' },
    { label: 'AGE', value: (row) => formatAge(row.run.metadata.creationTimestamp) || '-' },
    ...(output === 'wide'
      ? [
          { label: 'SA', value: (row: RunObservation) => row.serviceAccount ?? '-' },
          { label: 'DESYNC', value: (row: RunObservation) => (row.stale ? `${row.phase}->${row.observedPhase}` : '-') },
          {
            label: 'JOB',
            value: (row: RunObservation) =>
              row.job?.metadata.name ??
              (isJobRuntime(runtimeType(row.run)) ? row.run.status?.runtimeRef?.name : undefined) ??
              '-',
          },
        ]
      : []),
  ])

export const listRuns = (filters: RunFilters, selector?: string) =>
  Effect.gen(function* () {
    const {
      resolved: { namespace, output },
    } = yield* AgentctlContext
    const transport = yield* TransportService
    const { active, stale } = filters
    const phase = Option.getOrUndefined(filters.phase)
    const runtime = Option.getOrUndefined(filters.runtime)
    const sortBy = Option.getOrUndefined(filters.sortBy) ?? 'age'
    const limit = Option.getOrUndefined(filters.limit)
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      return yield* Effect.fail(validationError('--limit must be a positive integer.'))
    }
    if (stale && transport.mode !== 'kube') {
      return yield* Effect.fail(validationError('--stale requires Kubernetes mode.'))
    }
    const human = output === 'table' || output === 'wide'
    yield* Effect.tryPromise({
      try: async () => {
        const list =
          transport.mode === 'kube'
            ? await readRunResources(transport.backend, namespace, selector)
            : decodeKube(
                rawList,
                parseJson(
                  (
                    await callUnary<{ json: string }>(
                      transport.client,
                      'ListAgentRuns',
                      { namespace, label_selector: selector, phase, runtime },
                      transport.metadata,
                    )
                  ).json,
                ),
                'AgentRun list',
              )
        const [jobs, pods] =
          transport.mode === 'kube' && list.items.length && (human || active || stale)
            ? await Promise.all([transport.backend.listJobs(namespace), transport.backend.listPods(namespace)])
            : [[], []]
        const rows = observeRuns(list.items, jobs, pods, namespace)
          .filter(
            (row) =>
              (!phase || row.phase === phase) &&
              (!runtime || row.run.spec?.runtime?.type === runtime) &&
              (!active || (transport.mode === 'kube' ? row.active : !isTerminalPhase(row.phase))) &&
              (!stale || row.stale),
          )
          .sort(
            (a, b) =>
              (sortBy === 'phase'
                ? a.phase.localeCompare(b.phase)
                : sortBy === 'age'
                  ? timestamp(b.run.metadata.creationTimestamp) - timestamp(a.run.metadata.creationTimestamp)
                  : 0) || a.name.localeCompare(b.name),
          )
          .slice(0, limit)
        if (human) renderRunRows(rows, output)
        else outputList({ ...list, items: rows.map((row) => row.resource) }, output)
      },
      catch: (error) => asAgentctlError(error, transport.mode === 'kube' ? 'KubeError' : 'GrpcError'),
    })
  })

export const makeRunListCommand = () =>
  Command.make('list', { selector: selectorOption, ...runFilters }, ({ selector, ...filters }) =>
    listRuns(filters, Option.getOrUndefined(selector)),
  ).pipe(Command.withDescription('List AgentRuns with live workload and placement information.'))
