import { Config, Effect, Redacted, Schema } from 'effect'
import { HttpClient, HttpClientRequest, type HttpClientResponse, type HttpMethod } from 'effect/http'

import type { BaynKnowledge } from './auto-ontology-knowledge'
import { AcronymRow, AnalysisRow, NamedRow, OntologySyncError, planUpserts, RuleRow } from './sync-auto-ontology-core'

export const ruleTagName = 'Bayn canonical rule'
const SqlValidation = Schema.Struct({ data: Schema.Struct({ valid: Schema.Boolean, sql: Schema.String }) })
const completePage = <S extends Schema.ConstraintDecoder<unknown>>(row: S) =>
  Schema.Struct({
    data: Schema.Array(row),
    count: Schema.Int,
    total: Schema.Int,
  })
const Acronyms = Schema.Union([Schema.Array(AcronymRow), completePage(AcronymRow)])
const Databases = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: NamedRow.fields.id,
      name: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
})
const DatabaseSchemas = Schema.NullOr(
  Schema.Struct({
    schemas: Schema.Array(
      Schema.Struct({
        id: NamedRow.fields.id,
        schema_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
)

const failure = (operation: string, message: string, cause: unknown) =>
  new OntologySyncError({ operation, message, cause: Redacted.make(cause) })
const configError = (cause: unknown) =>
  failure('configuration', 'Set AUTO_ONTOLOGY_API_URL and AUTO_ONTOLOGY_API_TOKEN for apply', cause)

export const loadApplyConfig = Effect.gen(function* () {
  const url = yield* Config.Redacted('AUTO_ONTOLOGY_API_URL').pipe(Effect.mapError(configError))
  const token = yield* Config.Redacted('AUTO_ONTOLOGY_API_TOKEN').pipe(Effect.mapError(configError))
  const origin = yield* Effect.try({ try: () => new URL(Redacted.value(url)), catch: configError })
  if (
    origin.protocol !== 'https:' ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== ''
  ) {
    return yield* new OntologySyncError({
      operation: 'configuration',
      message: 'AUTO_ONTOLOGY_API_URL must be an HTTPS origin without credentials, path or query',
    })
  }
  if (!/^auto_ontology_[A-Za-z0-9_-]+$/.test(Redacted.value(token))) {
    return yield* new OntologySyncError({
      operation: 'configuration',
      message: 'AUTO_ONTOLOGY_API_TOKEN must be an Auto Ontology API token',
    })
  }
  return { origin: origin.origin, token }
})

const fullPage = <A>(
  operation: string,
  page: { readonly data: readonly A[]; readonly count: number; readonly total: number },
) =>
  page.count === page.data.length && page.total === page.count
    ? Effect.succeed(page.data)
    : new OntologySyncError({ operation, message: 'Incomplete catalog listing; no writes attempted' })

const uniqueId = (operation: string, candidates: readonly { readonly id: string }[]) => {
  const [candidate] = candidates
  return candidates.length === 1 && candidate !== undefined
    ? Effect.succeed(candidate.id)
    : new OntologySyncError({
        operation,
        message: 'Expected one onboarded Bayn catalog object; see docs/bayn/ontology/README.md',
      })
}

export const applyKnowledge = (seed: BaynKnowledge) =>
  Effect.gen(function* () {
    const { origin, token } = yield* loadApplyConfig
    const client = HttpClient.withScope(yield* HttpClient.HttpClient)
    const request = <A>(
      operation: string,
      method: HttpMethod.HttpMethod,
      path: string,
      consume: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, OntologySyncError>,
      body?: object,
    ) =>
      Effect.gen(function* () {
        const base = HttpClientRequest.make(method)(`${origin}/api/${path}`, {
          headers: { accept: 'application/json', authorization: `Bearer ${Redacted.value(token)}` },
        })
        const req = body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, body)
        const response = yield* client
          .execute(req)
          .pipe(Effect.mapError((cause) => failure(operation, 'HTTP transport failed', cause)))
        if (response.status < 200 || response.status >= 300) {
          return yield* new OntologySyncError({
            operation,
            status: response.status,
            message: 'Auto Ontology rejected the request; reconcile before retrying',
          })
        }
        return yield* consume(response)
      }).pipe(
        Effect.scoped,
        Effect.timeout('20 seconds'),
        Effect.catchTag('TimeoutError', (cause) =>
          failure(operation, 'HTTP deadline exceeded; reconcile before retrying', cause),
        ),
      )

    const json =
      <S extends Schema.ConstraintDecoder<unknown>>(operation: string, schema: S) =>
      (response: HttpClientResponse.HttpClientResponse) =>
        response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(schema)),
          Effect.mapError((cause) => failure(operation, 'Invalid Auto Ontology response', cause)),
        )
    const get = <S extends Schema.ConstraintDecoder<unknown>>(path: string, schema: S) =>
      request(path, 'GET', path, json(path, schema))
    const paged = <S extends Schema.ConstraintDecoder<unknown>>(path: string, row: S) =>
      get(path, completePage(row)).pipe(Effect.flatMap((page) => fullPage(path, page)))

    const databases = yield* get('datasources/dbs', Databases)
    const databaseId = yield* uniqueId(
      'Bayn database',
      databases.data.filter((row) => row.name === 'bayn'),
    )
    const schemas = yield* request(
      'Bayn schema',
      'GET',
      `schemas/${encodeURIComponent(databaseId)}`,
      json('Bayn schema', DatabaseSchemas),
    )
    const schemaId = yield* uniqueId(
      'Bayn public schema',
      schemas?.schemas.filter((row) => row.schema_name === 'public') ?? [],
    )
    const tags = yield* paged('tags', NamedRow)
    const ruleTagId = yield* uniqueId(
      'Bayn rule tag',
      tags.filter((row) => row.name === ruleTagName),
    )
    const listedAcronyms = yield* get('acronyms', Acronyms)
    const acronyms = 'data' in listedAcronyms ? yield* fullPage('acronyms', listedAcronyms) : listedAcronyms
    const rules = yield* paged('rules', RuleRow)
    const analyses = yield* paged('custom-analyses', AnalysisRow)
    const writes = yield* Effect.fromResult(planUpserts(seed, { schemaId, ruleTagId, acronyms, rules, analyses }))

    // Validate all planned SQL before the first catalog write. Validation resolves against the remote catalog.
    for (const { sql } of writes) {
      if (sql === undefined) continue
      const operation = 'custom-analyses/validate'
      const result = yield* request(operation, 'POST', operation, json(operation, SqlValidation), { sql })
      if (!result.data.valid) {
        return yield* new OntologySyncError({
          operation,
          message: 'Auto Ontology did not validate the SQL; no writes attempted',
        })
      }
    }
    for (const { resource, method, id, body } of writes) {
      const path = id === undefined ? resource : `${resource}/${encodeURIComponent(id)}`
      yield* request(resource, method, path, () => Effect.void, body)
    }
    return writes.length
  }).pipe(Effect.withTracerEnabled(false))
