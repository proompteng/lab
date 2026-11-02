import * as JSONSchema from 'effect/JSONSchema'
import type * as Schema from 'effect/Schema'

const compactNullableAnyOf = (
  source: Record<string, unknown>,
  propertyKey?: string,
): Record<string, unknown> | null => {
  const anyOf = source.anyOf
  if (!Array.isArray(anyOf) || anyOf.length !== 2) return null
  const nullIndex = anyOf.findIndex(
    (item) => typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'null',
  )
  const valueIndex = nullIndex === 0 ? 1 : nullIndex === 1 ? 0 : -1
  const valueSchema = valueIndex >= 0 ? anyOf[valueIndex] : null
  if (
    typeof valueSchema !== 'object' ||
    valueSchema === null ||
    typeof (valueSchema as Record<string, unknown>).type !== 'string'
  ) {
    return null
  }

  const sanitizedValue = sanitizeJsonSchemaForChatGpt(valueSchema, propertyKey) as Record<string, unknown>
  return {
    ...sanitizedValue,
    type: [sanitizedValue.type, 'null'],
  }
}

export const sanitizeJsonSchemaForChatGpt = (schema: unknown, propertyKey?: string): unknown => {
  if (Array.isArray(schema)) return schema.map((item) => sanitizeJsonSchemaForChatGpt(item, propertyKey))
  if (typeof schema !== 'object' || schema === null) return schema

  const source = schema as Record<string, unknown>
  const nullable = compactNullableAnyOf(source, propertyKey)
  if (nullable) return nullable

  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === '$schema' || key === '$id' || key === 'title') continue
    if (
      key === 'description' &&
      typeof value === 'string' &&
      (/^a string at least \d+ character\(s\) long$/.test(value) ||
        /^a number (greater than or equal to|less than or equal to) \d+$/.test(value) ||
        value === 'a non-negative number')
    ) {
      continue
    }
    if (key === 'required' && Array.isArray(value) && value.length === 0) continue
    if (key === 'maximum' && (propertyKey === 'timeoutSeconds' || propertyKey === 'maxOutputBytes')) continue
    if (key === 'minimum' && typeof value === 'number' && value <= -Number.MAX_SAFE_INTEGER) continue
    const childProperty = key === 'properties' ? undefined : key
    if (key === 'properties' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitized[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([propertyName, propertySchema]) => [
          propertyName,
          sanitizeJsonSchemaForChatGpt(propertySchema, propertyName),
        ]),
      )
      continue
    }
    sanitized[key] = sanitizeJsonSchemaForChatGpt(value, childProperty)
  }
  if (sanitized.type === 'object' && sanitized.additionalProperties === undefined) {
    sanitized.additionalProperties = false
  }
  return sanitized
}

export const effectSchemaToJsonSchema = (schema: Schema.Schema.Any) =>
  sanitizeJsonSchemaForChatGpt(JSONSchema.make(schema, { target: 'openApi3.1' }))
