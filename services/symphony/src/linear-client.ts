import type * as ParseResult from '@effect/schema/ParseResult'
import * as Schema from '@effect/schema/Schema'
import * as TreeFormatter from '@effect/schema/TreeFormatter'
import { Context, Effect, Layer } from 'effect'

import { ConfigError, TrackerError, WorkflowError, toLogError } from './errors'
import type { Issue } from './types'
import { normalizeState, parseIsoTimestamp } from './utils'
import { WorkflowService } from './workflow'
import type { Logger } from './logger'

const PAGE_SIZE = 50
const REQUEST_TIMEOUT_MS = 30_000
const singleOperationPattern = /\b(query|mutation|subscription)\b/g

const NullableStringSchema = Schema.optionalWith(Schema.String, { nullable: true })

const IssueNodeSchema = Schema.Struct({
  id: NullableStringSchema,
  identifier: NullableStringSchema,
  title: NullableStringSchema,
  description: NullableStringSchema,
  priority: Schema.optionalWith(Schema.Union(Schema.Number, Schema.String), { nullable: true }),
  branchName: NullableStringSchema,
  url: NullableStringSchema,
  createdAt: NullableStringSchema,
  updatedAt: NullableStringSchema,
  state: Schema.optionalWith(
    Schema.Struct({
      name: NullableStringSchema,
    }),
    { nullable: true },
  ),
  labels: Schema.optionalWith(
    Schema.Struct({
      nodes: Schema.optionalWith(
        Schema.Array(
          Schema.Struct({
            name: NullableStringSchema,
          }),
        ),
        { nullable: true },
      ),
    }),
    { nullable: true },
  ),
  inverseRelations: Schema.optionalWith(
    Schema.Struct({
      nodes: Schema.optionalWith(
        Schema.Array(
          Schema.Struct({
            type: NullableStringSchema,
            issue: Schema.optionalWith(
              Schema.Struct({
                id: NullableStringSchema,
                identifier: NullableStringSchema,
                state: Schema.optionalWith(
                  Schema.Struct({
                    name: NullableStringSchema,
                  }),
                  { nullable: true },
                ),
              }),
              { nullable: true },
            ),
            sourceIssue: Schema.optionalWith(
              Schema.Struct({
                id: NullableStringSchema,
                identifier: NullableStringSchema,
                state: Schema.optionalWith(
                  Schema.Struct({
                    name: NullableStringSchema,
                  }),
                  { nullable: true },
                ),
              }),
              { nullable: true },
            ),
          }),
        ),
        { nullable: true },
      ),
    }),
    { nullable: true },
  ),
})

const IssuesPageSchema = Schema.Struct({
  issues: Schema.Struct({
    nodes: Schema.optionalWith(Schema.Array(IssueNodeSchema), { nullable: true }),
    pageInfo: Schema.optionalWith(
      Schema.Struct({
        hasNextPage: Schema.optionalWith(Schema.Boolean, { nullable: true }),
        endCursor: NullableStringSchema,
      }),
      { nullable: true },
    ),
  }),
})

const GraphqlEnvelopeSchema = Schema.Struct({
  data: Schema.optionalWith(Schema.Unknown, { nullable: true }),
  errors: Schema.optionalWith(Schema.Unknown, { nullable: true }),
})

type IssueNode = typeof IssueNodeSchema.Type
type IssuesPage = typeof IssuesPageSchema.Type

const decodeIssuesPage = Schema.decodeUnknown(IssuesPageSchema)
const decodeGraphqlEnvelope = Schema.decodeUnknown(GraphqlEnvelopeSchema)

const formatSchemaError = (error: ParseResult.ParseError): string => TreeFormatter.formatErrorSync(error)

const readText = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const normalizePriority = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value)
    ? value
    : typeof value === 'string' && /^-?\d+$/.test(value)
      ? Number.parseInt(value, 10)
      : null

const normalizeLabels = (node: IssueNode): string[] =>
  (node.labels?.nodes ?? []).map((entry) => entry.name?.trim().toLowerCase() ?? '').filter((entry) => entry.length > 0)

const normalizeBlockedBy = (node: IssueNode) =>
  (node.inverseRelations?.nodes ?? [])
    .filter((entry) => normalizeState(entry.type) === 'blocks')
    .map((entry) => {
      const blocker = entry.issue ?? entry.sourceIssue ?? null
      return {
        id: blocker?.id ?? null,
        identifier: blocker?.identifier ?? null,
        state: blocker?.state?.name ?? null,
      }
    })

const normalizeIssue = (node: IssueNode): Issue => ({
  id: node.id ?? '',
  identifier: node.identifier ?? '',
  title: node.title ?? '',
  description: readText(node.description),
  priority: normalizePriority(node.priority),
  state: node.state?.name ?? '',
  branchName: readText(node.branchName),
  url: readText(node.url),
  labels: normalizeLabels(node),
  blockedBy: normalizeBlockedBy(node),
  createdAt: parseIsoTimestamp(node.createdAt),
  updatedAt: parseIsoTimestamp(node.updatedAt),
})

const mapSchemaError = (error: ParseResult.ParseError) =>
  new TrackerError('linear_unknown_payload', formatSchemaError(error), error)

const validateOperationCount = (query: string): Effect.Effect<void, TrackerError, never> => {
  const matches = query.match(singleOperationPattern) ?? []
  return matches.length > 1
    ? Effect.fail(
        new TrackerError(
          'linear_graphql_invalid_input',
          'linear_graphql accepts exactly one GraphQL operation per call',
        ),
      )
    : Effect.void
}

const requestGraphql = (
  endpoint: string,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Effect.Effect<unknown, TrackerError, never> =>
  Effect.gen(function* () {
    const controller = new AbortController()

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: apiKey,
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        }),
      catch: (error) => new TrackerError('linear_api_request', 'Linear API request failed', error),
    }).pipe(
      Effect.timeoutFail({
        duration: REQUEST_TIMEOUT_MS,
        onTimeout: () => {
          controller.abort()
          return new TrackerError('linear_api_request', `Linear API request timed out after ${REQUEST_TIMEOUT_MS}ms`)
        },
      }),
    )

    const bodyText = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error) => new TrackerError('linear_api_request', 'failed to read Linear API response', error),
    })

    if (!response.ok) {
      return yield* Effect.fail(
        new TrackerError('linear_api_status', `Linear API returned ${response.status}`, bodyText),
      )
    }

    const rawJson = yield* Effect.try({
      try: () => (bodyText.length === 0 ? {} : JSON.parse(bodyText)),
      catch: (error) => new TrackerError('linear_unknown_payload', 'Linear API returned invalid JSON', error),
    })

    const envelope = yield* decodeGraphqlEnvelope(rawJson).pipe(Effect.mapError(mapSchemaError))
    if (envelope.errors) {
      return yield* Effect.fail(
        new TrackerError('linear_graphql_errors', 'Linear GraphQL request returned errors', envelope.errors),
      )
    }
    if (envelope.data === null || envelope.data === undefined) {
      return yield* Effect.fail(
        new TrackerError('linear_unknown_payload', 'Linear GraphQL response did not include a data object', rawJson),
      )
    }

    return envelope.data
  })

export interface IssueTrackerClient {
  readonly fetchCandidateIssues: Effect.Effect<Issue[], WorkflowError | ConfigError | TrackerError>
  readonly fetchIssuesByStates: (states: string[]) => Effect.Effect<Issue[], WorkflowError | ConfigError | TrackerError>
  readonly fetchIssueStatesByIds: (
    issueIds: string[],
  ) => Effect.Effect<Issue[], WorkflowError | ConfigError | TrackerError>
  readonly executeLinearGraphql: (
    query: string,
    variables?: Record<string, unknown>,
  ) => Effect.Effect<Record<string, unknown>, WorkflowError | ConfigError | TrackerError>
}

export class TrackerService extends Context.Tag('symphony/TrackerService')<TrackerService, IssueTrackerClient>() {}

const issueSelection = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  labels { nodes { name } }
  inverseRelations {
    nodes {
      type
      issue {
        id
        identifier
        state { name }
      }
      sourceIssue {
        id
        identifier
        state { name }
      }
    }
  }
`

export const makeTrackerLayer = (logger: Logger) =>
  Layer.effect(
    TrackerService,
    Effect.gen(function* () {
      const workflow = yield* WorkflowService
      const trackerLogger = logger.child({ component: 'linear-tracker' })

      const fetchIssuesByFilter = (stateNames: string[], options?: { issueIds?: string[] }) =>
        Effect.gen(function* () {
          if (stateNames.length === 0) return [] as Issue[]

          const config = yield* workflow.config
          const query = `
            query SymphonyIssues($projectSlug: String!, $stateNames: [String!], $after: String, $issueIds: [ID!]) {
              issues(
                first: ${PAGE_SIZE},
                after: $after,
                filter: {
                  project: { slugId: { eq: $projectSlug } }
                  state: { name: { in: $stateNames } }
                  id: { in: $issueIds }
                }
              ) {
                nodes {
                  ${issueSelection}
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          `

          const issues: Issue[] = []
          let cursor: string | null = null
          let hasNextPage = true

          while (hasNextPage) {
            const rawData: unknown = yield* requestGraphql(
              config.tracker.endpoint,
              config.tracker.apiKey ?? '',
              query,
              {
                projectSlug: config.tracker.projectSlug,
                stateNames,
                after: cursor,
                issueIds: options?.issueIds && options.issueIds.length > 0 ? options.issueIds : null,
              },
            )

            const page: IssuesPage = yield* decodeIssuesPage(rawData).pipe(Effect.mapError(mapSchemaError))
            for (const node of page.issues.nodes ?? []) {
              const normalized = normalizeIssue(node)
              if (normalized.id && normalized.identifier && normalized.title && normalized.state) {
                issues.push(normalized)
              }
            }

            hasNextPage = Boolean(page.issues.pageInfo?.hasNextPage)
            cursor = page.issues.pageInfo?.endCursor ?? null
            if (hasNextPage && !cursor) {
              return yield* Effect.fail(
                new TrackerError(
                  'linear_missing_end_cursor',
                  'Linear pagination reported hasNextPage=true without endCursor',
                ),
              )
            }
          }

          return issues
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              trackerLogger.log('warn', 'linear_request_failed', {
                states: stateNames,
                issue_ids: options?.issueIds ?? null,
                ...toLogError(error),
              })
            }),
          ),
        )

      const service: IssueTrackerClient = {
        fetchCandidateIssues: workflow.config.pipe(
          Effect.flatMap((config) => fetchIssuesByFilter(config.tracker.activeStates)),
        ),
        fetchIssuesByStates: (states) => {
          if (states.length === 0) return Effect.succeed([])
          return fetchIssuesByFilter(states)
        },
        fetchIssueStatesByIds: (issueIds) =>
          Effect.gen(function* () {
            if (issueIds.length === 0) return [] as Issue[]
            const config = yield* workflow.config
            const normalizedStates = Array.from(
              new Set([...config.tracker.activeStates, ...config.tracker.terminalStates]),
            )
            const issues = yield* fetchIssuesByFilter(normalizedStates, { issueIds })
            const byId = new Map(issues.map((issue) => [issue.id, issue]))
            return issueIds.map((issueId) => byId.get(issueId)).filter((issue): issue is Issue => Boolean(issue))
          }),
        executeLinearGraphql: (query, variables = {}) =>
          Effect.gen(function* () {
            const config = yield* workflow.config
            if (config.tracker.kind !== 'linear' || !config.tracker.apiKey) {
              return yield* Effect.fail(new TrackerError('missing_tracker_api_key', 'Linear auth is not configured'))
            }
            yield* validateOperationCount(query)
            const data = yield* requestGraphql(config.tracker.endpoint, config.tracker.apiKey, query, variables)
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
              return yield* Effect.fail(
                new TrackerError('linear_unknown_payload', 'Linear GraphQL response was not an object', data),
              )
            }
            return data as Record<string, unknown>
          }),
      }

      return service
    }),
  )
