import { types } from 'node:util'
import type { Schema } from 'effect'

import { PositionResponseSchema } from './model'

type DiagnosticType =
  | 'missing'
  | 'undefined'
  | 'null'
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'other'
  | 'unknown'
type DiagnosticIssue = 'missing' | 'type' | 'enum' | 'constraint' | 'union' | 'unknown'
export interface PositionDecodeDiagnostic {
  readonly field: string
  readonly issue: DiagnosticIssue
  readonly expectedType: DiagnosticType
  readonly actualType: DiagnosticType
}

// This allowlist comes from the authored response contract, never from payload keys or issue messages.
const fields = new Set(Object.keys(PositionResponseSchema.fields))
const unknown: PositionDecodeDiagnostic = Object.freeze({
  field: 'unknown',
  issue: 'unknown',
  expectedType: 'unknown',
  actualType: 'unknown',
})

const ownData = (value: unknown, key: PropertyKey): PropertyDescriptor | undefined => {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return undefined
  return Object.getOwnPropertyDescriptor(value, key)
}

const ownValue = (value: unknown, key: PropertyKey): unknown => {
  const descriptor = ownData(value, key)
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
}

const typeOf = (value: unknown): DiagnosticType => {
  if (types.isProxy(value)) return 'unknown'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'undefined':
      return 'undefined'
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'object':
      return 'object'
    default:
      return 'other'
  }
}

const actualTypeAt = (input: unknown, path: readonly PropertyKey[]): DiagnosticType => {
  let value = input
  for (const key of path) {
    if (value === null || typeof value !== 'object' || types.isProxy(value)) return 'unknown'
    const descriptor = ownData(value, key)
    if (descriptor === undefined) return 'missing'
    if (!('value' in descriptor)) return 'unknown'
    value = descriptor.value
  }
  return typeOf(value)
}

const inspectPositionDecodeIssue = (error: Schema.SchemaError, input: unknown): PositionDecodeDiagnostic => {
  let issue: unknown = ownValue(error, 'issue')
  const path: PropertyKey[] = []
  let category: DiagnosticIssue = 'unknown'
  for (let depth = 0; depth < 16; depth++) {
    switch (ownValue(issue, '_tag')) {
      case 'Pointer': {
        const segment = ownValue(issue, 'path')
        if (types.isProxy(segment) || !Array.isArray(segment)) return unknown
        const length = ownValue(segment, 'length')
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || path.length + length > 2)
          return unknown
        for (let index = 0; index < length; index++) {
          const key = ownValue(segment, index)
          if (typeof key !== 'number' && typeof key !== 'string' && typeof key !== 'symbol') return unknown
          path.push(key)
        }
        issue = ownValue(issue, 'issue')
        continue
      }
      case 'Composite': {
        const issues = ownValue(issue, 'issues')
        if (types.isProxy(issues) || !Array.isArray(issues)) return unknown
        const first = ownValue(issues, 0)
        if (first === undefined) return unknown
        issue = first
        continue
      }
      case 'Encoding':
        issue = ownValue(issue, 'issue')
        continue
      case 'Filter':
        category = 'constraint'
        break
      case 'MissingKey':
        category = 'missing'
        break
      case 'InvalidType': {
        const tag = ownValue(ownValue(issue, 'ast'), '_tag')
        if (typeof tag !== 'string') return unknown
        category = tag === 'Enum' ? 'enum' : 'type'
        break
      }
      case 'AnyOf':
        category = 'union'
        break
      default:
        return unknown
    }
    const index = path[0]
    if (path.length === 0) return { field: '$', issue: category, expectedType: 'array', actualType: typeOf(input) }
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return unknown
    if (path.length === 1)
      return { field: '[]', issue: category, expectedType: 'object', actualType: actualTypeAt(input, path) }
    const field = path[1]
    if (typeof field !== 'string' || !fields.has(field)) return unknown
    return { field: `[].${field}`, issue: category, expectedType: 'string', actualType: actualTypeAt(input, path) }
  }
  return unknown
}

/** One bounded, value-free issue. Never invoke accessors, proxy traps, iterators or error formatters. */
export const positionDecodeDiagnostic = (error: Schema.SchemaError, input: unknown): PositionDecodeDiagnostic => {
  try {
    if (types.isProxy(error) || types.isProxy(input)) return unknown
    return inspectPositionDecodeIssue(error, input)
  } catch {
    // Diagnostics must not replace the original INVALID_RESPONSE failure if inspection is unsupported.
    return unknown
  }
}
