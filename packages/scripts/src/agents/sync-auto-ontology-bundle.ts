#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { z } from 'zod'

import {
  AcronymRow,
  AnalysisRow,
  BundleSyncError,
  DatabaseRow,
  NamedRow,
  RuleRow,
  planUpserts,
  prepareBundle,
} from './sync-auto-ontology-bundle-core'

const usage =
  'bun run packages/scripts/src/agents/sync-auto-ontology-bundle.ts --bundle <file.json> [--mode dry-run|apply]'

const argsSchema = z.object({
  bundle: z.string().min(1),
  mode: z.enum(['dry-run', 'apply']).default('dry-run'),
})
const parseOptions = (args: readonly string[]) => {
  try {
    const { values, tokens } = parseArgs({
      args: [...args],
      options: { bundle: { type: 'string' }, mode: { type: 'string' } },
      tokens: true,
    })
    const names = tokens.flatMap((token) => (token.kind === 'option' ? [token.name] : []))
    if (new Set(names).size === tokens.length) {
      const result = argsSchema.safeParse(values)
      if (result.success) return result.data
    }
  } catch {
    // parseArgs errors include user-supplied values.
  }
  throw new BundleSyncError(usage)
}

type Env = Readonly<Record<string, string | undefined>>
type Fetch = (url: string, init: RequestInit) => Promise<Response>
type Request = (
  operation: string,
  request?: { path?: string; method?: 'POST' | 'PATCH' | 'PUT'; body?: object },
) => Promise<Response>
const allowedOrigins = new Set([
  'https://auto-ontology.ide-newton.ts.net',
  'http://frontend.auto-ontology.svc.cluster.local:3000',
])

const createRequest = (env: Env, fetcher: Fetch): Request => {
  const endpoint = env.AUTO_ONTOLOGY_API_URL
  const origin = endpoint?.replace(/\/$/, '')
  const token = env.AUTO_ONTOLOGY_API_TOKEN
  if (!origin || !allowedOrigins.has(origin)) {
    throw new BundleSyncError('Set AUTO_ONTOLOGY_API_URL to an approved Auto Ontology frontend origin')
  }
  if (!token || !/^[\x21-\x7E]+$/.test(token)) throw new BundleSyncError('Set AUTO_ONTOLOGY_API_TOKEN for apply')
  return async (operation, { path = operation, method, body } = {}) => {
    let response: Response
    try {
      response = await fetcher(`${origin}/api/${path}`, {
        method: method ?? 'GET',
        headers: {
          accept: 'application/json',
          'x-api-key': token,
          ...(body && { 'content-type': 'application/json' }),
        },
        body: body && JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new BundleSyncError(`${operation}: Auto Ontology request failed; reconcile before retrying`)
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new BundleSyncError(
        `${operation}: Auto Ontology returned HTTP ${response.status}; reconcile before retrying`,
      )
    }
    return response
  }
}

const decodeResponse = async <T>(operation: string, response: Response, schema: z.ZodType<T>): Promise<T> => {
  const json: unknown = await response.json().catch(() => undefined)
  const result = schema.safeParse(json)
  if (!result.success) throw new BundleSyncError(`${operation}: invalid Auto Ontology response`)
  return result.data
}

const completeList = <T>(row: z.ZodType<T>) =>
  z
    .object({ data: z.array(row), count: z.int(), total: z.int().optional() })
    .refine(({ data, count, total }) => data.length === count && (total === undefined || total === count))
const validation = z.object({ data: z.object({ valid: z.boolean(), sql: z.string() }) })
const schemaList = z
  .object({
    schemas: z.array(z.object({ id: NamedRow.shape.id, schema_name: z.string() })),
    schemas_count: z.int(),
  })
  .refine(({ schemas, schemas_count }) => schemas.length === schemas_count)

const uniqueId = (matches: { id: string }[], error: string) => {
  const [row] = matches
  if (matches.length !== 1 || !row) throw new BundleSyncError(error)
  return row.id
}

const applyBundle = async (
  { bundle, database, ruleTag, referenced }: Awaited<ReturnType<typeof prepareBundle>>,
  request: Request,
) => {
  const list = async <T>(resource: string, row: z.ZodType<T>, path = resource) =>
    (await decodeResponse(resource, await request(resource, { path }), completeList(row))).data
  const databases = await list('datasources/dbs', DatabaseRow)
  const databaseId = uniqueId(
    databases.filter(({ name }) => name === database),
    'Expected one onboarded database for the bundle',
  )
  const acronyms = bundle.acronyms.length
    ? await decodeResponse('acronyms', await request('acronyms'), z.array(AcronymRow))
    : []
  const rules = bundle.rules.length ? await list('rules', RuleRow) : []
  const ruleTagId = bundle.rules.length
    ? uniqueId(
        (await list('tags', NamedRow)).filter(({ name }) => name === ruleTag),
        'Expected one preconfigured canonical rule tag',
      )
    : undefined
  const analyses = bundle.customAnalyses.length ? await list('custom-analyses', AnalysisRow) : []
  const writes = planUpserts(bundle, { databaseId, ruleTagId, acronyms, rules, analyses })

  if (referenced.size) {
    // In 1.3.0 validation resolves by schema name across the catalog, not by database qualifier.
    const schemas = []
    for (const { id } of databases) {
      const response = await request('schemas', { path: `schemas/${encodeURIComponent(id)}` })
      const { schemas: rows } = await decodeResponse('schemas', response, schemaList)
      schemas.push(...rows.map((row) => ({ ...row, databaseId: id })))
    }
    for (const [schemaName, requiredTables] of referenced) {
      const matches = schemas.filter(({ schema_name }) => schema_name.toLowerCase() === schemaName.toLowerCase())
      const [schema] = matches
      if (matches.length !== 1 || schema?.databaseId !== databaseId || schema.schema_name !== schemaName) {
        throw new BundleSyncError(
          'Referenced schema is missing or ambiguous in the selected database; no writes attempted',
        )
      }
      const params = new URLSearchParams({ database_name: database })
      const tables = await list('tables', NamedRow, `tables/${encodeURIComponent(schema.id)}?${params}`)
      const available = new Set(tables.map(({ name }) => name))
      if ([...requiredTables].some((name) => !available.has(name))) {
        throw new BundleSyncError(
          'Referenced relation is missing from the selected database catalog; no writes attempted',
        )
      }
    }
  }

  // The validation endpoint is non-persisting. A rejected analysis must not leave a partial catalog update.
  for (const { sql } of writes) {
    if (sql === undefined) continue
    const operation = 'custom-analyses/validate'
    const { data } = await decodeResponse(
      operation,
      await request(operation, { method: 'POST', body: { sql } }),
      validation,
    )
    if (!data.valid || data.sql !== sql)
      throw new BundleSyncError(`${operation}: SQL was not validated; no writes attempted`)
  }

  for (const { resource, method, id, body } of writes) {
    const path = id === undefined ? resource : `${resource}/${encodeURIComponent(id)}`
    const response = await request(resource, { path, method, body })
    await response.body?.cancel().catch(() => undefined)
  }
  return writes.length
}

export const syncBundle = async (args: readonly string[], env: Env = process.env, fetcher: Fetch = fetch) => {
  const { bundle: path, mode } = parseOptions(args)
  const input: unknown = await Bun.file(path)
    .json()
    .catch(() => {
      throw new BundleSyncError('Could not read a JSON bundle from --bundle')
    })
  const prepared = await prepareBundle(input, mode === 'apply')
  const { acronyms, rules, customAnalyses } = prepared.bundle
  const writes = mode === 'apply' ? await applyBundle(prepared, createRequest(env, fetcher)) : 0
  return { mode, acronyms: acronyms.length, rules: rules.length, customAnalyses: customAnalyses.length, writes }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage)
  } else {
    try {
      console.log(JSON.stringify(await syncBundle(args)))
    } catch (error) {
      console.error(error instanceof BundleSyncError ? error.message : 'Unexpected Auto Ontology sync failure')
      process.exitCode = 1
    }
  }
}
