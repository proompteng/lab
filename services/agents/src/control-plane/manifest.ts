import YAML from 'yaml'

import type { ControlPlanePrimitiveRegistryEntry } from './primitive-registry.generated'
import { type JsonSchema, schemaType } from './schema-form-model'

type JsonObject = Record<string, unknown>

const asRecord = (value: unknown): JsonObject | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null

const isEmptyObject = (value: unknown) => {
  const record = asRecord(value)
  return record ? Object.keys(record).length === 0 : false
}

export const emptyPrimitiveManifest = (entry: ControlPlanePrimitiveRegistryEntry) => ({
  apiVersion: entry.apiVersion,
  kind: entry.kind,
  metadata: {
    name: '',
    ...(entry.scope === 'Namespaced' ? { namespace: 'agents' } : {}),
  },
  spec: {},
})

export const parseStructuredText = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return YAML.parse(trimmed) as unknown
  }
}

const coerceScalar = (schema: JsonSchema, value: unknown) => {
  if (value === '') return undefined
  const type = schemaType(schema)
  if (type === 'integer' || type === 'number') {
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (type === 'boolean') return Boolean(value)
  return value
}

export const coerceSchemaValue = (schema: JsonSchema, value: unknown): unknown => {
  const type = schemaType(schema)
  if (typeof value === 'string' && (schema['x-kubernetes-preserve-unknown-fields'] === true || type === 'object')) {
    try {
      return parseStructuredText(value)
    } catch {
      return undefined
    }
  }
  if (type === 'array') {
    if (typeof value === 'string') {
      try {
        return parseStructuredText(value)
      } catch {
        return undefined
      }
    }
    if (!Array.isArray(value)) return undefined
    const itemSchema = asRecord(schema.items) ?? {}
    return value
      .map((item) => coerceSchemaValue(itemSchema, item))
      .filter((item) => item !== undefined && item !== '' && !isEmptyObject(item))
  }
  if (type === 'object') {
    const record = asRecord(value)
    if (!record) return undefined
    const properties = asRecord(schema.properties) ?? {}
    const next: JsonObject = {}
    for (const [key, childValue] of Object.entries(record)) {
      const childSchema = asRecord(properties[key]) ?? {}
      const coerced = coerceSchemaValue(childSchema, childValue)
      if (coerced !== undefined && coerced !== '' && !isEmptyObject(coerced)) {
        next[key] = coerced
      }
    }
    return Object.keys(next).length > 0 ? next : undefined
  }
  return coerceScalar(schema, value)
}

export const stripEmptyValues = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const items = value
      .map(stripEmptyValues)
      .filter((item) => item !== undefined && item !== '' && !isEmptyObject(item))
    return items.length > 0 ? items : undefined
  }
  const record = asRecord(value)
  if (record) {
    const next: JsonObject = {}
    for (const [key, child] of Object.entries(record)) {
      const stripped = stripEmptyValues(child)
      if (stripped !== undefined && stripped !== '' && !isEmptyObject(stripped)) next[key] = stripped
    }
    return Object.keys(next).length > 0 ? next : undefined
  }
  return value === '' || value === null ? undefined : value
}

export const materializePrimitiveManifest = (entry: ControlPlanePrimitiveRegistryEntry, values: JsonObject) => {
  const manifest = {
    ...emptyPrimitiveManifest(entry),
    ...values,
    apiVersion: entry.apiVersion,
    kind: entry.kind,
  }
  const schemaProperties = asRecord(entry.schema.properties) ?? {}
  const specSchema = asRecord(schemaProperties.spec) ?? {}
  const spec = coerceSchemaValue(specSchema, asRecord(manifest.spec) ?? {})
  const metadata = stripEmptyValues(asRecord(manifest.metadata) ?? {}) as JsonObject | undefined
  return stripEmptyValues({
    ...manifest,
    metadata,
    ...(spec ? { spec } : {}),
  }) as JsonObject
}
