import { isAbsolute } from 'node:path'
import { type CandidateDevelopmentGeometryFail } from '../candidate-development'
import {
  candidateDevelopmentCommandFailureObjectSupported,
  candidateDevelopmentCommandFailureProjectionMaxNodes,
  candidateDevelopmentCommandFailureProjectionMaxScalars,
  finishCandidateDevelopmentCommandFailureList,
  prepareCandidateDevelopmentCommandFailureListWindow,
  readCandidateDevelopmentCommandFailureProperty,
  rejectedCandidateDevelopmentCommandFailureDetail,
  safeCandidateDevelopmentCommandFailureScalar,
  safeCandidateDevelopmentCommandFailureToken,
  type CandidateDevelopmentCommandFailureProjectionBudget,
} from './failure-core'
import {
  projectCandidateDevelopmentCommandValidationScalar,
  projectCandidateDevelopmentCommandValidationValue,
} from './failure-validation'
import { projectCandidateDevelopmentCommandDomainNumber } from './failure-domain'
import { projectCandidateDevelopmentCommandFailureDetail } from './failure-dispatch'

export const candidateDevelopmentCommandOperationalErrorCategories = new Map<string, string>([
  ['candidate development report output interrupted', 'report-output-interrupted'],
  ['candidate Git batch output ended unexpectedly', 'git-batch-output-ended'],
  ['candidate Git batch output is incomplete', 'git-batch-output-incomplete'],
  ['candidate Git batch header exceeds the configured bound', 'git-batch-header-limit'],
  ['candidate Git batch object delimiter is invalid', 'git-batch-object-delimiter-invalid'],
  ['candidate Git batch reader is closed', 'git-batch-reader-closed'],
  ['candidate artifact URL is not a base64 JavaScript data URL', 'artifact-url-invalid'],
  ['candidate artifact worker aborted', 'artifact-worker-aborted'],
  ['candidate artifact buildEvaluation must be synchronous', 'artifact-evaluation-async'],
  ['candidate artifact evaluation must be JSON serializable', 'artifact-evaluation-not-json-serializable'],
  ['candidate artifact evaluation did not return JSON', 'artifact-evaluation-not-json'],
  ['candidate artifact imports are prohibited', 'artifact-imports-prohibited'],
  ['candidateDevelopmentArtifact export is missing', 'artifact-export-missing'],
  ['candidateDevelopmentArtifact.buildEvaluation is missing', 'artifact-build-evaluation-missing'],
  ['candidate artifact definition is not JSON', 'artifact-definition-not-json'],
  ['candidate artifact verified source is missing', 'artifact-verified-source-missing'],
  ['candidate artifact schema version is invalid', 'artifact-schema-version-invalid'],
  ['candidate artifact strategy protocol hash differs from preflight', 'artifact-strategy-protocol-hash-mismatch'],
])

export const candidateDevelopmentCommandOperationalErrorCategory = (message: string): string | undefined =>
  candidateDevelopmentCommandOperationalErrorCategories.get(message) ??
  (message.startsWith('candidate Git object OID is invalid: ')
    ? 'git-object-oid-invalid'
    : message.startsWith('candidate Git object is missing: ')
      ? 'git-object-missing'
      : message.startsWith('candidate Git batch header is invalid: ')
        ? 'git-batch-header-invalid'
        : message.startsWith('candidate Git batch object mismatch: ')
          ? 'git-batch-object-mismatch'
          : message.startsWith('candidate Git batch exited ')
            ? 'git-batch-exit'
            : /^candidate artifact worker exited [0-9]+$/.test(message)
              ? 'artifact-worker-exit'
              : undefined)

export const candidateDevelopmentCommandOperationalErrorSyscalls = new Map<string, string>([
  ['lstat', 'lstat'],
  ['open', 'open'],
  ['read', 'read'],
  ['readlink', 'readlink'],
  ['realpath', 'realpath'],
  ['spawn git', 'spawn-git'],
  ['stat', 'stat'],
])

export const projectCandidateDevelopmentCommandOperationalErrorCode = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (
    !(
      (typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(value))
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

export const projectCandidateDevelopmentCommandOperationalErrorSyscall = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  const projected =
    typeof value === 'string' ? candidateDevelopmentCommandOperationalErrorSyscalls.get(value) : undefined
  if (projected === undefined) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return projected
}

export const projectCandidateDevelopmentCommandOperationalErrorSignal = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (value !== null && (typeof value !== 'string' || !/^SIG[A-Z0-9]{1,16}$/.test(value))) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return value
}

export const candidateDevelopmentCommandOperationalErrorNames = new Set([
  'Error',
  'RangeError',
  'SyntaxError',
  'TypeError',
])

export const readCandidateDevelopmentCommandSerializedOperationalError = (
  value: object,
): { readonly name: string; readonly message: string } | undefined => {
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) return undefined
  let keys: readonly PropertyKey[]
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    return undefined
  }
  if (
    keys.some((key) => typeof key !== 'string' || (key !== 'name' && key !== 'message' && key !== 'stack')) ||
    !keys.includes('name') ||
    !keys.includes('message')
  ) {
    return undefined
  }
  const name = readCandidateDevelopmentCommandFailureProperty(value, 'name')
  const message = readCandidateDevelopmentCommandFailureProperty(value, 'message')
  const stack = readCandidateDevelopmentCommandFailureProperty(value, 'stack')
  if (
    name._tag !== 'Value' ||
    typeof name.value !== 'string' ||
    !candidateDevelopmentCommandOperationalErrorNames.has(name.value) ||
    message._tag !== 'Value' ||
    typeof message.value !== 'string' ||
    stack._tag === 'Rejected' ||
    (stack._tag === 'Value' && stack.value !== undefined && typeof stack.value !== 'string')
  ) {
    return undefined
  }
  return { name: name.value, message: message.value }
}

export const projectCandidateDevelopmentCommandOperationalError = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const tag = readCandidateDevelopmentCommandFailureProperty(value, '_tag')
  if (tag._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (tag._tag === 'Value') return undefined
  const serialized =
    value instanceof Error ? undefined : readCandidateDevelopmentCommandSerializedOperationalError(value)
  if (!(value instanceof Error) && serialized === undefined) return undefined
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }

  const name =
    serialized?.name ??
    (value instanceof TypeError
      ? 'TypeError'
      : value instanceof RangeError
        ? 'RangeError'
        : value instanceof SyntaxError
          ? 'SyntaxError'
          : 'Error')
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.nodes += 1
  budget.scalars += 1
  const output: Record<string, unknown> = { name }

  const message =
    serialized === undefined
      ? readCandidateDevelopmentCommandFailureProperty(value, 'message')
      : ({ _tag: 'Value', value: serialized.message } as const)
  if (message._tag === 'Rejected') {
    output.category = rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  } else if (message._tag === 'Value' && typeof message.value === 'string') {
    const category = candidateDevelopmentCommandOperationalErrorCategory(message.value)
    if (category !== undefined) {
      output.category =
        safeCandidateDevelopmentCommandFailureScalar(category, budget) ??
        rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
  }

  for (const field of ['code', 'errno', 'syscall', 'signal', 'killed'] as const) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Absent') continue
    if (property._tag === 'Rejected') {
      output[field] = rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
      continue
    }
    output[field] =
      field === 'code' || field === 'errno'
        ? projectCandidateDevelopmentCommandOperationalErrorCode(property.value, budget)
        : field === 'syscall'
          ? projectCandidateDevelopmentCommandOperationalErrorSyscall(property.value, budget)
          : field === 'signal'
            ? projectCandidateDevelopmentCommandOperationalErrorSignal(property.value, budget)
            : typeof property.value === 'boolean'
              ? projectCandidateDevelopmentCommandValidationScalar(property.value, budget)
              : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  return output
}

export const candidateDevelopmentCommandFailureDetailIsUntagged = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  readCandidateDevelopmentCommandFailureProperty(value, '_tag')._tag === 'Absent'

export const candidateDevelopmentCommandFailureDetailIsKnownMismatch = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  readCandidateDevelopmentCommandFailureProperty(value, '_tag')._tag === 'Absent' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'expected')._tag === 'Value' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'observed')._tag === 'Value'

export const candidateDevelopmentGeometryFailIntegerFields = [
  'requiredObservations',
  'availableObservations',
  'availableFoldCount',
  'requiredFoldCount',
  'observationDeficit',
] as const satisfies readonly (keyof CandidateDevelopmentGeometryFail)[]

export const projectCandidateDevelopmentGeometryFail = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
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

  const status = readCandidateDevelopmentCommandFailureProperty(value, 'status')
  const reason = readCandidateDevelopmentCommandFailureProperty(value, 'reason')
  if (status._tag === 'Rejected' || reason._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (
    status._tag !== 'Value' ||
    status.value !== 'FAIL' ||
    reason._tag !== 'Value' ||
    reason.value !== 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS'
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-preflight')
  }

  const integers: Partial<Record<(typeof candidateDevelopmentGeometryFailIntegerFields)[number], number>> = {}
  for (const field of candidateDevelopmentGeometryFailIntegerFields) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Rejected') {
      return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
    }
    if (
      property._tag !== 'Value' ||
      typeof property.value !== 'number' ||
      !Number.isSafeInteger(property.value) ||
      property.value < 0
    ) {
      return rejectedCandidateDevelopmentCommandFailureDetail('invalid-preflight')
    }
    integers[field] = property.value
  }

  const requiredObservations = integers.requiredObservations
  const availableObservations = integers.availableObservations
  const availableFoldCount = integers.availableFoldCount
  const requiredFoldCount = integers.requiredFoldCount
  const observationDeficit = integers.observationDeficit
  if (
    requiredObservations === undefined ||
    availableObservations === undefined ||
    availableFoldCount === undefined ||
    requiredFoldCount === undefined ||
    observationDeficit === undefined ||
    requiredObservations <= availableObservations ||
    requiredFoldCount <= availableFoldCount ||
    observationDeficit !== requiredObservations - availableObservations
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-preflight')
  }
  if (budget.scalars + 7 > candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }

  budget.nodes += 1
  budget.scalars += 7
  return {
    status: 'FAIL',
    reason: 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS',
    requiredObservations,
    availableObservations,
    availableFoldCount,
    requiredFoldCount,
    observationDeficit,
  }
}

export const candidateDevelopmentCommandKnownMismatchFields = new Set([
  'boundedContentHash',
  'calendarHash',
  'candidateDevelopmentProtocolHash',
  'candidateOrdinal',
  'finalizedSnapshotContentHash',
  'inputManifestHash',
  'immutableCommit',
  'immutableHistoryCommitCount',
  'immutableHistoryTreeCount',
  'immutableTreeEntry',
  'immutableTreeObjectOid',
  'moduleFormat',
  'modulePath',
  'moduleSha256',
  'priorTrialCount',
  'priorTrialsHash',
  'shallowRepository',
  'schemaVersion',
  'snapshotId',
  'strategyIdentityHash',
  'strategyProtocolHash',
  'replaceRefs',
  'replacementConfig',
  'grafts',
  'alternates',
  'httpAlternates',
])

export const safeCandidateDevelopmentCommandMismatchField = (value: unknown): value is string =>
  safeCandidateDevelopmentCommandFailureToken(value) &&
  (candidateDevelopmentCommandKnownMismatchFields.has(value) ||
    value.startsWith('artifact.') ||
    value.startsWith('marketData.') ||
    value.startsWith('source.') ||
    value.startsWith('trialHistory.'))

export const safeCandidateDevelopmentCommandMismatchString = (value: string): boolean =>
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ||
  /^<[1-9][0-9]{0,8}$/.test(value) ||
  /^bayn\.[a-z0-9.-]+\.v[0-9]+$/.test(value) ||
  /^services\/bayn\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value) ||
  value === 'PASS' ||
  value === 'FAIL' ||
  value === 'false' ||
  value === 'true' ||
  value === 'self-contained-esm-v1'

export type CandidateDevelopmentCommandTrialHistoryEvidenceMode = 'latest-development' | 'latest-terminal'

export const candidateDevelopmentCommandNextPreregistrationField = 'trialHistory.nextCandidatePreregistration' as const
export const candidateDevelopmentCommandNextPreregistrationExpectation =
  'a separately reviewed preregistration after the latest terminal development attempt' as const

export const projectCandidateDevelopmentCommandTrialHistoryEvidence = (
  value: unknown,
  mode: CandidateDevelopmentCommandTrialHistoryEvidenceMode,
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

  budget.nodes += 1
  const output: Record<string, unknown> = {}
  for (const field of ['candidateOrdinal', 'priorTrialCount'] as const) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    output[field] =
      property._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : property._tag !== 'Value'
          ? rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
          : property.value === undefined && mode === 'latest-development'
            ? projectCandidateDevelopmentCommandValidationScalar(null, budget)
            : typeof property.value === 'number' && Number.isSafeInteger(property.value) && property.value >= 0
              ? projectCandidateDevelopmentCommandDomainNumber(property.value, budget)
              : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }

  const qualificationAttemptConsumed = readCandidateDevelopmentCommandFailureProperty(
    value,
    'qualificationAttemptConsumed',
  )
  if (mode === 'latest-development' || qualificationAttemptConsumed._tag !== 'Absent') {
    output.qualificationAttemptConsumed =
      qualificationAttemptConsumed._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : qualificationAttemptConsumed._tag === 'Value' && typeof qualificationAttemptConsumed.value === 'boolean'
          ? projectCandidateDevelopmentCommandValidationScalar(qualificationAttemptConsumed.value, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  return output
}

export const candidateDevelopmentCommandFailureDetailIsMissingPreregistrationCause = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const tag = readCandidateDevelopmentCommandFailureProperty(value, '_tag')
  const field = readCandidateDevelopmentCommandFailureProperty(value, 'field')
  const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
  const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
  const latestTerminalEvidence = readCandidateDevelopmentCommandFailureProperty(value, 'latestTerminalEvidence')
  return (
    tag._tag === 'Absent' &&
    field._tag === 'Value' &&
    field.value === candidateDevelopmentCommandNextPreregistrationField &&
    expected._tag === 'Value' &&
    expected.value === candidateDevelopmentCommandNextPreregistrationExpectation &&
    observed._tag === 'Value' &&
    observed.value === null &&
    latestTerminalEvidence._tag === 'Value'
  )
}

export const projectCandidateDevelopmentCommandMissingPreregistrationCause = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
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

  const latestTerminalEvidence = readCandidateDevelopmentCommandFailureProperty(value, 'latestTerminalEvidence')
  if (latestTerminalEvidence._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (latestTerminalEvidence._tag !== 'Value') {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-mismatch')
  }
  if (budget.scalars + 3 > candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }

  budget.nodes += 1
  budget.scalars += 3
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  return {
    field: candidateDevelopmentCommandNextPreregistrationField,
    expected: candidateDevelopmentCommandNextPreregistrationExpectation,
    observed: null,
    latestTerminalEvidence: projectCandidateDevelopmentCommandTrialHistoryEvidence(
      latestTerminalEvidence.value,
      'latest-terminal',
      nextAncestors,
      budget,
    ),
  }
}

export const projectCandidateDevelopmentCommandImmutableGitOid = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return value
}

export const projectCandidateDevelopmentCommandImmutableGitOidList = (
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
  const values = value as readonly unknown[]
  const length = readCandidateDevelopmentCommandFailureProperty(values, 'length')
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
  const output: unknown[] = []
  for (let index = 0; index < window.prefixLength; index += 1) {
    const item = readCandidateDevelopmentCommandFailureProperty(values, String(index))
    output.push(
      item._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : item._tag === 'Value'
          ? projectCandidateDevelopmentCommandImmutableGitOid(item.value, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    )
  }
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

export const projectCandidateDevelopmentCommandRedactedMetadataList = (
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
  const values = value as readonly unknown[]
  const length = readCandidateDevelopmentCommandFailureProperty(values, 'length')
  if (
    length._tag !== 'Value' ||
    typeof length.value !== 'number' ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, false)
  if (window === undefined || budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.nodes += 1
  const output = Array.from({ length: window.prefixLength }, () =>
    rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
  )
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

export const projectCandidateDevelopmentCommandRepositoryRelativePath = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    isAbsolute(value) ||
    value.includes('\\')
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  const segments = value.split('/')
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment),
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

export const candidateDevelopmentCommandImmutableCommitExpectation =
  'raw commit with lowercase 40-character tree and parent OIDs' as const
export const candidateDevelopmentCommandImmutableTreeEntryExpectation =
  'raw Git tree entry with mode, name, NUL, and 20-byte object ID' as const
export const candidateDevelopmentCommandModuleNoveltyExpectation =
  'evaluated module blob created after preregistration' as const
export const candidateDevelopmentCommandPreregistrationBindingExpectation =
  'lowercase Git revision/blob OID and repository-relative preregistration path' as const
export const candidateDevelopmentCommandLineageExpectation = 'proper ancestor of evaluated source revision' as const
export const candidateDevelopmentCommandLineageUnreachable = 'not reachable through raw commit parents' as const

export const projectCandidateDevelopmentCommandExactText = (
  value: unknown,
  expected: string,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (value !== expected) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return expected
}

export const candidateDevelopmentCommandFailureDetailIsImmutableGitCause = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const field = readCandidateDevelopmentCommandFailureProperty(value, 'field')
  return (
    field._tag === 'Value' &&
    (field.value === 'immutableCommit' ||
      field.value === 'immutableTreeEntry' ||
      field.value === 'immutableTreeObjectOid')
  )
}

export const candidateDevelopmentCommandFailureDetailIsModuleNoveltyCause = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  readCandidateDevelopmentCommandFailureProperty(value, '_tag')._tag === 'Absent' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'field')._tag === 'Absent' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'preregistrationRevision')._tag === 'Value' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'modulePath')._tag === 'Value' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'expected')._tag === 'Value' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'observed')._tag === 'Value' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'history')._tag === 'Value'

export const candidateDevelopmentCommandFailureDetailIsLineageCause = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  readCandidateDevelopmentCommandFailureProperty(value, '_tag')._tag === 'Absent' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'field')._tag === 'Absent' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'expected')._tag === 'Value' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'observed')._tag === 'Value'

export const projectCandidateDevelopmentCommandLineageCause = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
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

  const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
  const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
  if (expected._tag === 'Rejected' || observed._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (expected._tag !== 'Value' || observed._tag !== 'Value') {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }

  const sameRevision =
    expected.value === candidateDevelopmentCommandLineageExpectation &&
    typeof observed.value === 'string' &&
    /^[0-9a-f]{40}$/.test(observed.value)
  const unreachable =
    typeof expected.value === 'string' &&
    /^[0-9a-f]{40} to be a proper ancestor of [0-9a-f]{40}$/.test(expected.value) &&
    observed.value === candidateDevelopmentCommandLineageUnreachable
  if (!sameRevision && !unreachable) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars + 2 > candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.nodes += 1
  budget.scalars += 2
  return {
    expected: expected.value,
    observed: observed.value,
  }
}

export const projectCandidateDevelopmentCommandModuleNoveltyCause = (
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
  const preregistrationRevision = readCandidateDevelopmentCommandFailureProperty(value, 'preregistrationRevision')
  const modulePath = readCandidateDevelopmentCommandFailureProperty(value, 'modulePath')
  const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
  const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
  const history = readCandidateDevelopmentCommandFailureProperty(value, 'history')
  if (
    preregistrationRevision._tag === 'Rejected' ||
    modulePath._tag === 'Rejected' ||
    expected._tag === 'Rejected' ||
    observed._tag === 'Rejected' ||
    history._tag === 'Rejected'
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (
    preregistrationRevision._tag !== 'Value' ||
    modulePath._tag !== 'Value' ||
    expected._tag !== 'Value' ||
    observed._tag !== 'Value' ||
    history._tag !== 'Value'
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  let historyIsArray: boolean
  try {
    historyIsArray = Array.isArray(history.value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!historyIsArray) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  const historyLength = readCandidateDevelopmentCommandFailureProperty(history.value as object, 'length')
  if (historyLength._tag !== 'Value' || historyLength.value !== 1) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }

  budget.nodes += 1
  return {
    preregistrationRevision: projectCandidateDevelopmentCommandImmutableGitOid(preregistrationRevision.value, budget),
    modulePath: projectCandidateDevelopmentCommandRepositoryRelativePath(modulePath.value, budget),
    expected: projectCandidateDevelopmentCommandExactText(
      expected.value,
      candidateDevelopmentCommandModuleNoveltyExpectation,
      budget,
    ),
    observed: projectCandidateDevelopmentCommandImmutableGitOid(observed.value, budget),
    history: projectCandidateDevelopmentCommandImmutableGitOidList(history.value, budget),
  }
}

export const projectCandidateDevelopmentCommandImmutableGitCause = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const field = readCandidateDevelopmentCommandFailureProperty(value, 'field')
  if (
    field._tag !== 'Value' ||
    (field.value !== 'immutableCommit' &&
      field.value !== 'immutableTreeEntry' &&
      field.value !== 'immutableTreeObjectOid')
  ) {
    return undefined
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }

  budget.nodes += 1
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  const output: Record<string, unknown> = { field: field.value }
  if (field.value === 'immutableCommit') {
    const commitOid = readCandidateDevelopmentCommandFailureProperty(value, 'commitOid')
    const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
    const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
    if (commitOid._tag === 'Rejected' || expected._tag === 'Rejected' || observed._tag === 'Rejected') {
      return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
    }
    output.commitOid =
      commitOid._tag === 'Value'
        ? projectCandidateDevelopmentCommandImmutableGitOid(commitOid.value, budget)
        : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
    output.expected =
      expected._tag === 'Value'
        ? projectCandidateDevelopmentCommandExactText(
            expected.value,
            candidateDevelopmentCommandImmutableCommitExpectation,
            budget,
          )
        : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
    if (
      observed._tag !== 'Value' ||
      typeof observed.value !== 'object' ||
      observed.value === null ||
      !candidateDevelopmentCommandFailureObjectSupported(observed.value)
    ) {
      output.observed = rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
      return output
    }
    if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
      output.observed = rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
      return output
    }
    budget.nodes += 1
    const treeOid = readCandidateDevelopmentCommandFailureProperty(observed.value, 'treeOid')
    const parentOids = readCandidateDevelopmentCommandFailureProperty(observed.value, 'parentOids')
    output.observed = {
      treeOid:
        treeOid._tag === 'Rejected'
          ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
          : treeOid._tag === 'Absent' || treeOid.value === undefined
            ? projectCandidateDevelopmentCommandValidationScalar(null, budget)
            : projectCandidateDevelopmentCommandImmutableGitOid(treeOid.value, budget),
      parentOids:
        parentOids._tag === 'Rejected'
          ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
          : parentOids._tag === 'Value'
            ? projectCandidateDevelopmentCommandImmutableGitOidList(parentOids.value, budget)
            : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    }
    return output
  }

  const treeOid = readCandidateDevelopmentCommandFailureProperty(value, 'treeOid')
  const offset = readCandidateDevelopmentCommandFailureProperty(value, 'offset')
  if (treeOid._tag === 'Rejected' || offset._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  output.treeOid =
    treeOid._tag === 'Value'
      ? projectCandidateDevelopmentCommandImmutableGitOid(treeOid.value, budget)
      : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  output.offset =
    offset._tag === 'Value' &&
    typeof offset.value === 'number' &&
    Number.isSafeInteger(offset.value) &&
    offset.value >= 0
      ? projectCandidateDevelopmentCommandDomainNumber(offset.value, budget)
      : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  if (field.value === 'immutableTreeEntry') {
    const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
    output.expected =
      expected._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : expected._tag === 'Value'
          ? projectCandidateDevelopmentCommandExactText(
              expected.value,
              candidateDevelopmentCommandImmutableTreeEntryExpectation,
              budget,
            )
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  } else {
    const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
    output.observed =
      observed._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : observed._tag === 'Value'
          ? projectCandidateDevelopmentCommandImmutableGitOid(observed.value, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  return output
}

export const projectCandidateDevelopmentCommandMismatchValue = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value === 'string' && safeCandidateDevelopmentCommandMismatchString(value)) {
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
    return value
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
    return value
  }
  if (typeof value === 'boolean' || value === null) {
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
    return value
  }
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }

  const tag = readCandidateDevelopmentCommandFailureProperty(value, '_tag')
  if (tag._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (tag._tag === 'Value') {
    return projectCandidateDevelopmentCommandFailureDetail(value, 1, ancestors, budget)
  }

  const status = readCandidateDevelopmentCommandFailureProperty(value, 'status')
  const reason = readCandidateDevelopmentCommandFailureProperty(value, 'reason')
  if (
    status._tag === 'Value' &&
    status.value === 'FAIL' &&
    reason._tag === 'Value' &&
    reason.value === 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS'
  ) {
    return projectCandidateDevelopmentGeometryFail(value, ancestors, budget)
  }

  return projectCandidateDevelopmentCommandValidationValue(value, ancestors, budget)
}

export const projectCandidateDevelopmentCommandKnownMismatch = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
  mode: 'program-strategy-protocol-hash' | 'verified-program-binding',
): Readonly<Record<string, unknown>> => {
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

  const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
  const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
  const field = readCandidateDevelopmentCommandFailureProperty(value, 'field')
  if (expected._tag === 'Rejected' || observed._tag === 'Rejected' || field._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (expected._tag !== 'Value' || observed._tag !== 'Value') {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-mismatch')
  }

  if (mode === 'program-strategy-protocol-hash') {
    if (
      typeof expected.value !== 'string' ||
      typeof observed.value !== 'string' ||
      !/^[0-9a-f]{64}$/.test(expected.value) ||
      !/^[0-9a-f]{64}$/.test(observed.value) ||
      field._tag !== 'Absent' ||
      budget.scalars + 2 > candidateDevelopmentCommandFailureProjectionMaxScalars
    ) {
      return rejectedCandidateDevelopmentCommandFailureDetail('invalid-mismatch')
    }
    budget.nodes += 1
    budget.scalars += 2
    return { expected: expected.value, observed: observed.value }
  }

  if (field._tag === 'Value' && !safeCandidateDevelopmentCommandMismatchField(field.value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-mismatch')
  }
  if (field._tag === 'Value') {
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
  }
  budget.nodes += 1
  const mismatchAncestors = new Set(ancestors)
  mismatchAncestors.add(value)
  const mismatchField = field._tag === 'Value' ? field.value : undefined
  const projectMismatchValue = (mismatchValue: unknown): unknown =>
    mismatchField === 'alternates' || mismatchField === 'httpAlternates'
      ? projectCandidateDevelopmentCommandRedactedMetadataList(mismatchValue, budget)
      : mismatchField === 'trialHistory.latestTerminalEvidence'
        ? projectCandidateDevelopmentCommandTrialHistoryEvidence(
            mismatchValue,
            'latest-terminal',
            mismatchAncestors,
            budget,
          )
        : mismatchField === 'trialHistory.latestDevelopmentEvidence'
          ? projectCandidateDevelopmentCommandTrialHistoryEvidence(
              mismatchValue,
              'latest-development',
              mismatchAncestors,
              budget,
            )
          : projectCandidateDevelopmentCommandMismatchValue(mismatchValue, mismatchAncestors, budget)
  return {
    ...(field._tag === 'Value' ? { field: field.value } : {}),
    expected: projectMismatchValue(expected.value),
    observed: projectMismatchValue(observed.value),
  }
}
