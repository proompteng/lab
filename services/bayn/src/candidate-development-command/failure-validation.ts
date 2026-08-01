import { isAbsolute } from 'node:path'
import { forbiddenCandidateArtifactIdentifiers } from './artifact-policy'
import {
  candidateDevelopmentCommandFailureObjectSupported,
  candidateDevelopmentCommandFailureProjectionMaxNodes,
  candidateDevelopmentCommandFailureProjectionMaxObjectEntries,
  candidateDevelopmentCommandFailureProjectionMaxScalars,
  candidateDevelopmentCommandFailureProjectionMaxTokenLength,
  finishCandidateDevelopmentCommandFailureList,
  prepareCandidateDevelopmentCommandFailureListWindow,
  readCandidateDevelopmentCommandFailureProperty,
  rejectedCandidateDevelopmentCommandFailureDetail,
  type CandidateDevelopmentCommandFailureProjectionBudget,
} from './failure-core'
import {
  candidateDevelopmentCommandPreregistrationBindingExpectation,
  projectCandidateDevelopmentCommandImmutableGitOid,
  projectCandidateDevelopmentCommandOperationalError,
} from './failure-operational'
import { projectCandidateDevelopmentCommandDomainNumber } from './failure-domain'

export const candidateDevelopmentCommandValidationObjectFields = [
  'accountingFirst',
  'actual',
  'adjustment',
  'costBasisMicros',
  'current',
  'differenceMicros',
  'document',
  'evaluation',
  'exact',
  'executionDate',
  'first',
  'kind',
  'last',
  'marketValueMicros',
  'name',
  'passed',
  'priceMicros',
  'previous',
  'publicationSchemaVersion',
  'quantityMicros',
  'required',
  'runId',
  'schemaVersion',
  'selectedFirst',
  'sessionDate',
  'signalDate',
  'source',
  'sourceFeed',
  'status',
  'symbol',
  'withinTolerance',
] as const

export const projectCandidateDevelopmentCommandRepositoryModulePath = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    !/^services\/bayn\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value)
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return value
}

export const projectCandidateDevelopmentCommandRepositoryPath = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.startsWith('/') ||
    value === '..' ||
    value.startsWith('../') ||
    value.includes('/../') ||
    value.includes('\\') ||
    !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value)
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return value
}

export const candidateDevelopmentCommandFailureDetailIsMalformedPreregistrationCause = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
  const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
  if (
    readCandidateDevelopmentCommandFailureProperty(value, '_tag')._tag !== 'Absent' ||
    readCandidateDevelopmentCommandFailureProperty(value, 'field')._tag !== 'Absent' ||
    expected._tag !== 'Value' ||
    expected.value !== candidateDevelopmentCommandPreregistrationBindingExpectation ||
    observed._tag !== 'Value' ||
    typeof observed.value !== 'object' ||
    observed.value === null
  ) {
    return false
  }
  return (
    readCandidateDevelopmentCommandFailureProperty(observed.value, 'sourceRevision')._tag !== 'Absent' &&
    readCandidateDevelopmentCommandFailureProperty(observed.value, 'blobOid')._tag !== 'Absent' &&
    readCandidateDevelopmentCommandFailureProperty(observed.value, 'path')._tag !== 'Absent'
  )
}

export const projectCandidateDevelopmentCommandMalformedPreregistrationCause = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes + 1 >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }
  const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
  const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
  if (expected._tag === 'Rejected' || observed._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (
    expected._tag !== 'Value' ||
    expected.value !== candidateDevelopmentCommandPreregistrationBindingExpectation ||
    observed._tag !== 'Value' ||
    typeof observed.value !== 'object' ||
    observed.value === null ||
    !candidateDevelopmentCommandFailureObjectSupported(observed.value)
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.nodes += 2
  budget.scalars += 1
  const sourceRevision = readCandidateDevelopmentCommandFailureProperty(observed.value, 'sourceRevision')
  const blobOid = readCandidateDevelopmentCommandFailureProperty(observed.value, 'blobOid')
  const path = readCandidateDevelopmentCommandFailureProperty(observed.value, 'path')
  return {
    expected: candidateDevelopmentCommandPreregistrationBindingExpectation,
    observed: {
      sourceRevision:
        sourceRevision._tag === 'Rejected'
          ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
          : sourceRevision._tag === 'Value'
            ? projectCandidateDevelopmentCommandImmutableGitOid(sourceRevision.value, budget)
            : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
      blobOid:
        blobOid._tag === 'Rejected'
          ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
          : blobOid._tag === 'Value'
            ? projectCandidateDevelopmentCommandImmutableGitOid(blobOid.value, budget)
            : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
      path:
        path._tag === 'Rejected'
          ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
          : path._tag === 'Value'
            ? projectCandidateDevelopmentCommandRepositoryPath(path.value, budget)
            : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    },
  }
}

export const projectCandidateDevelopmentCommandModulePath = (
  value: object,
  tag: string,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (tag !== 'CandidateDevelopmentCommandModuleLoadFailed') return {}
  const modulePath = readCandidateDevelopmentCommandFailureProperty(value, 'modulePath')
  if (modulePath._tag === 'Rejected') {
    return { modulePath: rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed') }
  }
  if (modulePath._tag !== 'Value') {
    return { modulePath: rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value') }
  }
  return { modulePath: projectCandidateDevelopmentCommandRepositoryModulePath(modulePath.value, budget) }
}

export const safeCandidateDevelopmentCommandValidationText = (value: string): boolean =>
  value.length > 0 &&
  value.length <= candidateDevelopmentCommandFailureProjectionMaxTokenLength &&
  !isAbsolute(value) &&
  !/(?:credential|password|secret|token|api[-_]?key|\/workspace\/|\\|@|:)/i.test(value) &&
  /^[A-Za-z0-9 ._/%<>=+-]+$/.test(value)

export const projectCandidateDevelopmentCommandValidationScalar = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value === 'number') return projectCandidateDevelopmentCommandDomainNumber(value, budget)
  if (typeof value === 'boolean' || value === null) {
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
    return value
  }
  if (typeof value !== 'string' || !safeCandidateDevelopmentCommandValidationText(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return value
}

export const candidateDevelopmentCommandModuleImportKinds = new Set<Bun.ImportKind>([
  'import-statement',
  'require-call',
  'require-resolve',
  'dynamic-import',
  'import-rule',
  'url-token',
  'internal',
  'entry-point-run',
  'entry-point-build',
])

export const projectCandidateDevelopmentCommandModuleSpecifier = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > candidateDevelopmentCommandFailureProjectionMaxTokenLength ||
    !/^(?:node:[A-Za-z0-9][A-Za-z0-9._/-]*|@?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*|\.\.?\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(
      value,
    )
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return value
}

export const projectCandidateDevelopmentCommandModuleImports = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!isArray || ancestors.has(value as object)) {
    return rejectedCandidateDevelopmentCommandFailureDetail(isArray ? 'cycle' : 'unsupported-value')
  }
  const imports = value as readonly unknown[]
  const length = readCandidateDevelopmentCommandFailureProperty(imports, 'length')
  if (
    length._tag !== 'Value' ||
    typeof length.value !== 'number' ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, false)
  if (
    window === undefined ||
    budget.nodes + window.prefixLength + 1 > candidateDevelopmentCommandFailureProjectionMaxNodes
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }

  budget.nodes += 1
  const output: unknown[] = []
  for (let index = 0; index < window.prefixLength; index += 1) {
    const item = readCandidateDevelopmentCommandFailureProperty(imports, String(index))
    if (
      item._tag !== 'Value' ||
      typeof item.value !== 'object' ||
      item.value === null ||
      !candidateDevelopmentCommandFailureObjectSupported(item.value)
    ) {
      output.push(rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'))
      continue
    }
    const kind = readCandidateDevelopmentCommandFailureProperty(item.value, 'kind')
    const path = readCandidateDevelopmentCommandFailureProperty(item.value, 'path')
    if (kind._tag === 'Rejected' || path._tag === 'Rejected') {
      output.push(rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed'))
      continue
    }
    budget.nodes += 1
    output.push({
      kind:
        kind._tag === 'Value' &&
        typeof kind.value === 'string' &&
        candidateDevelopmentCommandModuleImportKinds.has(kind.value as Bun.ImportKind)
          ? projectCandidateDevelopmentCommandValidationScalar(kind.value, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
      path:
        path._tag === 'Value'
          ? projectCandidateDevelopmentCommandModuleSpecifier(path.value, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    })
  }
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

export const projectCandidateDevelopmentCommandModuleIdentifiers = (
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
  const identifiers = value as readonly unknown[]
  const length = readCandidateDevelopmentCommandFailureProperty(identifiers, 'length')
  if (
    length._tag !== 'Value' ||
    typeof length.value !== 'number' ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, true)
  if (window === undefined) return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  const output: string[] = []
  for (let index = 0; index < window.prefixLength; index += 1) {
    const identifier = readCandidateDevelopmentCommandFailureProperty(identifiers, String(index))
    if (
      identifier._tag !== 'Value' ||
      typeof identifier.value !== 'string' ||
      (identifier.value !== 'template-literal' && !forbiddenCandidateArtifactIdentifiers.has(identifier.value))
    ) {
      return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
    }
    output.push(identifier.value)
  }
  budget.scalars += output.length
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

export const projectCandidateDevelopmentCommandModuleFormatCause = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (
    budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes ||
    !candidateDevelopmentCommandFailureObjectSupported(value)
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail(
      budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes ? 'detail-limit' : 'non-plain-object',
    )
  }

  const modulePath = readCandidateDevelopmentCommandFailureProperty(value, 'modulePath')
  const imports = readCandidateDevelopmentCommandFailureProperty(value, 'imports')
  const identifiers = readCandidateDevelopmentCommandFailureProperty(value, 'identifiers')
  const cause = readCandidateDevelopmentCommandFailureProperty(value, 'cause')
  if (
    modulePath._tag === 'Rejected' ||
    imports._tag === 'Rejected' ||
    identifiers._tag === 'Rejected' ||
    cause._tag === 'Rejected'
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  budget.nodes += 1
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  if (imports._tag === 'Absent' && identifiers._tag === 'Absent' && cause._tag === 'Value') {
    return {
      modulePath:
        modulePath._tag === 'Value'
          ? projectCandidateDevelopmentCommandRepositoryModulePath(modulePath.value, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
      cause:
        projectCandidateDevelopmentCommandOperationalError(cause.value, nextAncestors, budget) ??
        rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    }
  }
  return {
    modulePath:
      modulePath._tag === 'Value'
        ? projectCandidateDevelopmentCommandRepositoryModulePath(modulePath.value, budget)
        : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    imports:
      imports._tag === 'Value'
        ? projectCandidateDevelopmentCommandModuleImports(imports.value, nextAncestors, budget)
        : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    identifiers:
      identifiers._tag === 'Value'
        ? projectCandidateDevelopmentCommandModuleIdentifiers(identifiers.value, budget)
        : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
  }
}

export const projectCandidateDevelopmentCommandValidationValue = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
  depth: number = 0,
): unknown => {
  if (value === null || typeof value !== 'object') {
    return projectCandidateDevelopmentCommandValidationScalar(value, budget)
  }
  if (depth >= 2) return rejectedCandidateDevelopmentCommandFailureDetail('depth-limit')
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }

  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!isArray && !candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  budget.nodes += 1

  if (isArray) {
    const length = readCandidateDevelopmentCommandFailureProperty(value, 'length')
    if (
      length._tag !== 'Value' ||
      typeof length.value !== 'number' ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0
    ) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, false)
    if (window === undefined) return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    const output: unknown[] = []
    for (let index = 0; index < window.prefixLength; index += 1) {
      const item = readCandidateDevelopmentCommandFailureProperty(value, String(index))
      if (item._tag === 'Rejected') {
        output.push(rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed'))
      } else if (item._tag === 'Value') {
        output.push(projectCandidateDevelopmentCommandValidationValue(item.value, nextAncestors, budget, depth + 1))
      } else {
        output.push(rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'))
      }
    }
    return finishCandidateDevelopmentCommandFailureList(output, window)
  }

  const output: Record<string, unknown> = {}
  for (const field of candidateDevelopmentCommandValidationObjectFields) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Absent') continue
    output[field] =
      property._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : projectCandidateDevelopmentCommandValidationValue(property.value, nextAncestors, budget, depth + 1)
  }
  return Object.keys(output).length > 0 ? output : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
}

export const projectCandidateDevelopmentCommandTargetWeights = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }

  let keys: readonly PropertyKey[]
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (
    keys.length > candidateDevelopmentCommandFailureProjectionMaxObjectEntries ||
    keys.some((key) => typeof key !== 'string' || !/^[A-Z][A-Z0-9.-]{0,15}$/.test(key))
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }

  budget.nodes += 1
  const output: Record<string, unknown> = {}
  for (const symbol of (keys as readonly string[]).toSorted()) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, symbol)
    if (property._tag === 'Rejected') {
      return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
    }
    if (property._tag !== 'Value' || typeof property.value !== 'number' || !Number.isFinite(property.value)) {
      return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
    }
    output[symbol] = projectCandidateDevelopmentCommandDomainNumber(property.value, budget)
  }
  return output
}

export const projectCandidateDevelopmentCommandCashYieldOrder = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }
  const index = readCandidateDevelopmentCommandFailureProperty(value, 'index')
  const kind = readCandidateDevelopmentCommandFailureProperty(value, 'kind')
  if (index._tag === 'Rejected' || kind._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (
    index._tag !== 'Value' ||
    typeof index.value !== 'number' ||
    !Number.isSafeInteger(index.value) ||
    index.value < 0 ||
    kind._tag !== 'Value' ||
    (kind.value !== 'fill' && kind.value !== 'fee') ||
    budget.scalars + 2 > candidateDevelopmentCommandFailureProjectionMaxScalars
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  budget.nodes += 1
  budget.scalars += 2
  return { index: index.value, kind: kind.value }
}

export const projectCandidateDevelopmentCommandValidationMismatchFields = (
  value: object,
  tag: string,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (
    tag !== 'CandidateDevelopmentCommandPerformanceEvidenceInvalid' &&
    tag !== 'CandidateDevelopmentCommandMarkedEquityInvalid' &&
    tag !== 'CandidateDevelopmentCommandEconomicGateInvalid'
  ) {
    return {}
  }
  const mismatchField = readCandidateDevelopmentCommandFailureProperty(value, 'field')
  const output: Record<string, unknown> = {}
  for (const field of ['expected', 'observed'] as const) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    output[field] =
      property._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : property._tag === 'Value'
          ? tag === 'CandidateDevelopmentCommandMarkedEquityInvalid' &&
            field === 'observed' &&
            mismatchField._tag === 'Value' &&
            mismatchField.value === 'benchmarks.terminalDecision'
            ? projectCandidateDevelopmentCommandTargetWeights(property.value, ancestors, budget)
            : tag === 'CandidateDevelopmentCommandMarkedEquityInvalid' &&
                field === 'observed' &&
                mismatchField._tag === 'Value' &&
                (mismatchField.value === 'baseline.cashYield.order' ||
                  mismatchField.value === 'stressed.cashYield.order')
              ? projectCandidateDevelopmentCommandCashYieldOrder(property.value, ancestors, budget)
              : projectCandidateDevelopmentCommandValidationValue(property.value, ancestors, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  return output
}

export const projectCandidateDevelopmentCommandCanonicalJsonPath = (
  value: object,
  tag: string,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (tag !== 'CanonicalJsonFailure') return {}
  const path = readCandidateDevelopmentCommandFailureProperty(value, 'path')
  if (path._tag === 'Rejected') {
    return { path: rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed') }
  }
  if (
    path._tag !== 'Value' ||
    typeof path.value !== 'string' ||
    path.value.length === 0 ||
    path.value.length > 256 ||
    !/^\$(?:(?:\.[A-Za-z0-9_-]+)|(?:\[(?:0|[1-9][0-9]*)\]))*$/.test(path.value)
  ) {
    return { path: rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value') }
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return { path: rejectedCandidateDevelopmentCommandFailureDetail('detail-limit') }
  }
  budget.scalars += 1
  return { path: path.value }
}
