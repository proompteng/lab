import { Schema, SchemaAST, SchemaIssue } from 'effect'
import { projectCandidateDevelopmentCommandValidationScalar } from './failure-validation'
import { projectCandidateDevelopmentCommandDomainNumber } from './failure-domain'

export const candidateDevelopmentCommandFailureOutputSchemaVersion =
  'bayn.candidate-development-command-failure.v1' as const
export const candidateDevelopmentCommandFailureOutputMaxBytes = 16 * 1024

export const candidateDevelopmentCommandFailureProjectionMaxDepth = 6
export const candidateDevelopmentCommandFailureProjectionMaxNodes = 24
export const candidateDevelopmentCommandFailureProjectionMaxScalars = 48
export const candidateDevelopmentCommandFailureProjectionListPrefixLength = 8
export const candidateDevelopmentCommandFailureProjectionMaxObjectEntries = 8
export const candidateDevelopmentCommandFailureProjectionMaxTokenLength = 96
export const candidateDevelopmentCommandSchemaProjectionMaxDepth = 10

export const candidateDevelopmentCommandFailureScalarFields = [
  'stage',
  'phase',
  'step',
  'operation',
  'reason',
  'series',
  'material',
  'field',
  'index',
  'status',
  'expectedStatus',
  'observedStatus',
  'actualType',
  'source',
  'target',
  'kind',
  'side',
  'metric',
  'gate',
  'disposition',
  'candidateOrdinal',
  'priorTrialCount',
  'expectedCandidateOrdinal',
  'foldIndex',
  'gateIndex',
  'observationIndex',
] as const

export const candidateDevelopmentCommandFailureListFields = [
  'failedGateNames',
  'expectedGateNames',
  'observedGateNames',
] as const

export const candidateDevelopmentCommandFailureNestedFields = ['cause', 'preflight', 'failure', 'issue'] as const

export type CandidateDevelopmentCommandFailureProjectionRejection =
  | 'cycle'
  | 'depth-limit'
  | 'detail-limit'
  | 'invalid-mismatch'
  | 'invalid-preflight'
  | 'introspection-failed'
  | 'invalid-tag'
  | 'non-plain-object'
  | 'output-limit'
  | 'untyped-object'
  | 'unsupported-value'

export interface CandidateDevelopmentCommandFailureProjectionBudget {
  nodes: number
  scalars: number
}

export interface CandidateDevelopmentCommandFailureListWindow {
  readonly prefixLength: number
  readonly omittedCount: number
}

export type CandidateDevelopmentCommandProjectedList<T> =
  | readonly T[]
  | {
      readonly items: readonly T[]
      readonly omittedCount: number
    }

export type CandidateDevelopmentCommandFailureProperty =
  | { readonly _tag: 'Absent' }
  | { readonly _tag: 'Rejected' }
  | { readonly _tag: 'Value'; readonly value: unknown }

export const candidateDevelopmentCommandSchemaTags = new Set([
  'SchemaError',
  'Filter',
  'Encoding',
  'Pointer',
  'Composite',
  'AnyOf',
  'InvalidType',
  'InvalidValue',
  'MissingKey',
  'UnexpectedKey',
  'Forbidden',
  'OneOf',
])

export const candidateDevelopmentCommandIsSchemaError = (value: unknown): boolean => {
  try {
    return Schema.isSchemaError(value)
  } catch {
    return false
  }
}

export const candidateDevelopmentCommandIsSchemaIssue = (value: unknown): value is SchemaIssue.Issue => {
  try {
    return SchemaIssue.isIssue(value)
  } catch {
    return false
  }
}

export const candidateDevelopmentCommandIsSchemaAst = (value: unknown): value is SchemaAST.AST => {
  try {
    return SchemaAST.isAST(value)
  } catch {
    return false
  }
}

export const rejectedCandidateDevelopmentCommandFailureDetail = (
  reason: CandidateDevelopmentCommandFailureProjectionRejection,
): Readonly<Record<string, unknown>> => ({
  _tag: 'CandidateDevelopmentCommandFailureDetailRejected',
  reason,
})

export const readCandidateDevelopmentCommandFailureProperty = (
  value: object,
  key: string,
): CandidateDevelopmentCommandFailureProperty => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) return { _tag: 'Absent' }
    return 'value' in descriptor ? { _tag: 'Value', value: descriptor.value } : { _tag: 'Rejected' }
  } catch {
    return { _tag: 'Rejected' }
  }
}

export const safeCandidateDevelopmentCommandFailureToken = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= candidateDevelopmentCommandFailureProjectionMaxTokenLength &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)

export const safeCandidateDevelopmentCommandFailureFieldPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= candidateDevelopmentCommandFailureProjectionMaxTokenLength &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*(?:(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)|(?:\[(?:0|[1-9][0-9]{0,5})\]))*$/.test(value)

export const safeCandidateDevelopmentCommandFailureScalar = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): string | number | boolean | null | undefined => {
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) return undefined
  if (safeCandidateDevelopmentCommandFailureToken(value)) {
    budget.scalars += 1
    return value
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    budget.scalars += 1
    return value
  }
  if (typeof value === 'boolean' || value === null) {
    budget.scalars += 1
    return value
  }
  return undefined
}

export const safeCandidateDevelopmentCommandFailureFieldPathScalar = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): string | undefined => {
  if (
    budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars ||
    !safeCandidateDevelopmentCommandFailureFieldPath(value)
  ) {
    return undefined
  }
  budget.scalars += 1
  return value
}

export const prepareCandidateDevelopmentCommandFailureListWindow = (
  length: number,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
  scalarItems: boolean,
): CandidateDevelopmentCommandFailureListWindow | undefined => {
  if (!Number.isSafeInteger(length) || length < 0) return undefined
  let prefixLength = Math.min(length, candidateDevelopmentCommandFailureProjectionListPrefixLength)
  if (scalarItems && budget.scalars + prefixLength > candidateDevelopmentCommandFailureProjectionMaxScalars) {
    prefixLength = Math.max(0, candidateDevelopmentCommandFailureProjectionMaxScalars - budget.scalars - 1)
  }
  const omittedCount = length - prefixLength
  if (omittedCount > 0) {
    if (
      budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes ||
      budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars
    ) {
      return undefined
    }
    budget.nodes += 1
    budget.scalars += 1
  }
  return { prefixLength, omittedCount }
}

export const finishCandidateDevelopmentCommandFailureList = <T>(
  items: readonly T[],
  window: CandidateDevelopmentCommandFailureListWindow,
): CandidateDevelopmentCommandProjectedList<T> =>
  window.omittedCount === 0 ? items : { items, omittedCount: window.omittedCount }

export const safeCandidateDevelopmentCommandFailureTokenList = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): CandidateDevelopmentCommandProjectedList<string> | undefined => {
  let isArray = false
  try {
    isArray = Array.isArray(value)
  } catch {
    return undefined
  }
  if (!isArray) return undefined

  const array = value as readonly unknown[]
  let length: number
  try {
    length = array.length
  } catch {
    return undefined
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length, budget, true)
  if (window === undefined) return undefined

  const output: string[] = []
  for (let index = 0; index < window.prefixLength; index += 1) {
    const item = readCandidateDevelopmentCommandFailureProperty(array, String(index))
    if (item._tag !== 'Value' || !safeCandidateDevelopmentCommandFailureToken(item.value)) return undefined
    output.push(item.value)
  }
  budget.scalars += output.length
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

export const candidateDevelopmentCommandFailureObjectSupported = (value: object): boolean => {
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === null || prototype === Object.prototype || value instanceof Error
  } catch {
    return false
  }
}

export const projectCandidateDevelopmentCommandSchemaPath = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!isArray) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  const path = value as readonly unknown[]
  const length = readCandidateDevelopmentCommandFailureProperty(path, 'length')
  if (length._tag !== 'Value' || typeof length.value !== 'number') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, true)
  if (window === undefined) return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  const output: unknown[] = []
  for (let index = 0; index < window.prefixLength; index += 1) {
    const segment = readCandidateDevelopmentCommandFailureProperty(path, String(index))
    if (segment._tag === 'Rejected') {
      output.push(rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed'))
      continue
    }
    if (segment._tag !== 'Value') {
      output.push(rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'))
      continue
    }
    if (
      (typeof segment.value === 'string' &&
        safeCandidateDevelopmentCommandFailureToken(segment.value) &&
        !/(?:credential|password|secret|token|api[-_]?key)/i.test(segment.value)) ||
      (typeof segment.value === 'number' &&
        Number.isSafeInteger(segment.value) &&
        segment.value >= 0 &&
        segment.value <= 999_999)
    ) {
      budget.scalars += 1
      output.push(segment.value)
    } else {
      output.push(rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'))
    }
  }
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

export const projectCandidateDevelopmentCommandSchemaLiteral = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value === 'string') return projectCandidateDevelopmentCommandValidationScalar(value, budget)
  if (typeof value === 'number') return projectCandidateDevelopmentCommandDomainNumber(value, budget)
  if (typeof value === 'boolean') return projectCandidateDevelopmentCommandValidationScalar(value, budget)
  if (typeof value === 'bigint') {
    const decimal = value.toString(10)
    if (!/^-?[0-9]{1,96}$/.test(decimal)) {
      return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
    }
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
    return decimal
  }
  return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
}

export const projectCandidateDevelopmentCommandSchemaAst = (
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (!candidateDevelopmentCommandIsSchemaAst(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (depth > candidateDevelopmentCommandSchemaProjectionMaxDepth) {
    return rejectedCandidateDevelopmentCommandFailureDetail('depth-limit')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (
    budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes ||
    budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.nodes += 1
  budget.scalars += 1
  const output: Record<string, unknown> = { _tag: value._tag }
  if (value._tag === 'Literal') {
    output.literal = projectCandidateDevelopmentCommandSchemaLiteral(value.literal, budget)
  } else if (value._tag === 'Union') {
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      output.mode = rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    } else {
      budget.scalars += 1
      output.mode = value.mode
    }
    const window = prepareCandidateDevelopmentCommandFailureListWindow(value.types.length, budget, false)
    if (window === undefined) {
      output.types = rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    } else {
      const nextAncestors = new Set(ancestors)
      nextAncestors.add(value)
      const types = value.types
        .slice(0, window.prefixLength)
        .map((ast) => projectCandidateDevelopmentCommandSchemaAst(ast, depth + 1, nextAncestors, budget))
      output.types = finishCandidateDevelopmentCommandFailureList(types, window)
    }
  } else if (value._tag === 'Enum') {
    const window = prepareCandidateDevelopmentCommandFailureListWindow(value.enums.length, budget, true)
    if (window === undefined) {
      output.values = rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    } else {
      const values = value.enums
        .slice(0, window.prefixLength)
        .map(([, enumValue]) => projectCandidateDevelopmentCommandSchemaLiteral(enumValue, budget))
      output.values = finishCandidateDevelopmentCommandFailureList(values, window)
    }
  }
  return output
}

export const projectCandidateDevelopmentCommandSchemaIssueList = (
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!isArray) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  const issues = value as readonly unknown[]
  const length = readCandidateDevelopmentCommandFailureProperty(issues, 'length')
  if (length._tag !== 'Value' || typeof length.value !== 'number') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, false)
  if (window === undefined) return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  const output = issues
    .slice(0, window.prefixLength)
    .map((issue) => projectCandidateDevelopmentCommandSchemaIssue(issue, depth, ancestors, budget))
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

export const projectCandidateDevelopmentCommandSchemaIssue = (
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (!candidateDevelopmentCommandIsSchemaIssue(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (depth > candidateDevelopmentCommandSchemaProjectionMaxDepth) {
    return rejectedCandidateDevelopmentCommandFailureDetail('depth-limit')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (
    budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes ||
    budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.nodes += 1
  budget.scalars += 1
  const output: Record<string, unknown> = { _tag: value._tag }
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  switch (value._tag) {
    case 'Pointer':
      output.path = projectCandidateDevelopmentCommandSchemaPath(value.path, budget)
      output.issue = projectCandidateDevelopmentCommandSchemaIssue(value.issue, depth + 1, nextAncestors, budget)
      break
    case 'Composite':
      output.issues = projectCandidateDevelopmentCommandSchemaIssueList(value.issues, depth + 1, nextAncestors, budget)
      break
    case 'AnyOf':
      output.expected = projectCandidateDevelopmentCommandSchemaAst(value.ast, depth + 1, nextAncestors, budget)
      output.issues = projectCandidateDevelopmentCommandSchemaIssueList(value.issues, depth + 1, nextAncestors, budget)
      break
    case 'Filter':
      output.issue = projectCandidateDevelopmentCommandSchemaIssue(value.issue, depth + 1, nextAncestors, budget)
      break
    case 'Encoding':
      output.expected = projectCandidateDevelopmentCommandSchemaAst(value.ast, depth + 1, nextAncestors, budget)
      output.issue = projectCandidateDevelopmentCommandSchemaIssue(value.issue, depth + 1, nextAncestors, budget)
      break
    case 'InvalidType':
    case 'UnexpectedKey':
    case 'OneOf':
      output.expected = projectCandidateDevelopmentCommandSchemaAst(value.ast, depth + 1, nextAncestors, budget)
      break
    case 'InvalidValue':
    case 'MissingKey':
    case 'Forbidden':
      break
  }
  return output
}

export const projectCandidateDevelopmentCommandSchemaError = (
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || !candidateDevelopmentCommandIsSchemaError(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (depth > candidateDevelopmentCommandSchemaProjectionMaxDepth) {
    return rejectedCandidateDevelopmentCommandFailureDetail('depth-limit')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (
    budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes ||
    budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const issue = readCandidateDevelopmentCommandFailureProperty(value, 'issue')
  budget.nodes += 1
  budget.scalars += 1
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  return {
    _tag: 'SchemaError',
    issue:
      issue._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : issue._tag === 'Value'
          ? projectCandidateDevelopmentCommandSchemaIssue(issue.value, depth + 1, nextAncestors, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
  }
}
