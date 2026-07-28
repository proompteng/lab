import { Option, Result, Schema } from 'effect'

import {
  makeRunIdentityResult,
  makeStrategyProtocolHashResult,
  type ContractConstructionFailure,
} from '../../contracts'
import { canonicalHashV1Result, renderCanonicalJsonFailure, type CanonicalJsonFailure } from '../../hash'
import { QualificationLockSchema, type QualificationLock, type QualificationResult } from '../../qualification'
import { strictParseOptions } from '../../schemas'
import type { OpenQualificationInput, QualificationRecord } from './model'

type QualificationDecisionStage = 'lineage' | 'lock-match' | 'open-input' | 'stored-record'
type QualificationPath = readonly [string, ...(number | string)[]]
type QualificationCanonicalizationOperation =
  | 'bounds'
  | 'execution-policy'
  | 'image'
  | 'input-manifest'
  | 'parameters'
  | 'qualification-lock'
  | 'universe'

export type QualificationDecisionFailure =
  | {
      readonly _tag: 'QualificationSchemaInvalid'
      readonly stage: 'open-input'
      readonly field: 'lock'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'QualificationCanonicalizationFailed'
      readonly stage: QualificationDecisionStage
      readonly operation: QualificationCanonicalizationOperation
      readonly subject?: string
      readonly cause: CanonicalJsonFailure
    }
  | {
      readonly _tag: 'QualificationContractConstructionFailed'
      readonly stage: 'open-input'
      readonly operation: 'run-identity' | 'strategy-protocol'
      readonly cause: ContractConstructionFailure
    }
  | {
      readonly _tag: 'QualificationMismatch'
      readonly stage: QualificationDecisionStage
      readonly path: QualificationPath
      readonly observed: unknown
      readonly expected: unknown
    }

export type StoredQualificationFailure =
  | QualificationDecisionFailure
  | {
      readonly _tag: 'StoredQualificationCardinalityMismatch'
      readonly observedCount: number
      readonly expectedMaximum: 1
    }

export interface QualificationRowPayload {
  readonly lock_payload: QualificationLock
  readonly result_payload: QualificationResult | null
}

export type ValidatedQualificationOpenInput = Omit<OpenQualificationInput, 'lock'> & {
  readonly lock: QualificationLock
}

const decodeQualificationLock = Schema.decodeUnknownResult(QualificationLockSchema, strictParseOptions)

const mismatch = (
  stage: QualificationDecisionStage,
  path: QualificationPath,
  observed: unknown,
  expected: unknown,
): Result.Result<never, QualificationDecisionFailure> =>
  Result.fail({ _tag: 'QualificationMismatch', stage, path, observed, expected })

const canonicalHash = (
  stage: QualificationDecisionStage,
  operation: QualificationCanonicalizationOperation,
  value: unknown,
  subject?: string,
): Result.Result<string, QualificationDecisionFailure> =>
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): QualificationDecisionFailure => ({
      _tag: 'QualificationCanonicalizationFailed',
      stage,
      operation,
      ...(subject === undefined ? {} : { subject }),
      cause,
    }),
  )

const protocolHash = (input: OpenQualificationInput): Result.Result<string, QualificationDecisionFailure> =>
  Result.mapError(
    makeStrategyProtocolHashResult(input.provenance.strategy),
    (cause): QualificationDecisionFailure => ({
      _tag: 'QualificationContractConstructionFailed',
      stage: 'open-input',
      operation: 'strategy-protocol',
      cause,
    }),
  )

const expectedRunId = (input: OpenQualificationInput): Result.Result<string, QualificationDecisionFailure> =>
  Result.map(
    Result.mapError(
      makeRunIdentityResult({
        schemaVersion: 'bayn.run-identity.v1',
        sourceRevision: input.provenance.sourceRevision,
        image: input.provenance.image,
        strategy: {
          name: input.provenance.strategy.name,
          behaviorHash: input.provenance.strategy.behaviorHash,
          parameters: input.parameters,
        },
        finalizedSnapshot: input.inputManifest.finalizedSnapshot,
        calendarVersion: input.inputManifest.finalizedSnapshot.calendarVersion,
        bounds: input.inputManifest.bounds,
      }),
      (cause): QualificationDecisionFailure => ({
        _tag: 'QualificationContractConstructionFailed',
        stage: 'open-input',
        operation: 'run-identity',
        cause,
      }),
    ),
    (identity) => identity.runId,
  )

export const validateQualificationOpenInput = (
  input: OpenQualificationInput,
): Result.Result<ValidatedQualificationOpenInput, QualificationDecisionFailure> =>
  Result.gen(function* () {
    const lock = yield* Result.mapError(
      decodeQualificationLock(input.lock),
      (cause): QualificationDecisionFailure => ({
        _tag: 'QualificationSchemaInvalid',
        stage: 'open-input',
        field: 'lock',
        cause,
      }),
    )
    const { inputManifest, parameters, provenance } = input
    const observedParameterHash = yield* canonicalHash('open-input', 'parameters', parameters)
    if (observedParameterHash !== provenance.strategy.parameterHash) {
      return yield* mismatch(
        'open-input',
        ['provenance', 'strategy', 'parameterHash'],
        provenance.strategy.parameterHash,
        observedParameterHash,
      )
    }

    const expectedProtocolHash = yield* protocolHash(input)
    const { hash: manifestHash, ...manifestMaterial } = inputManifest
    const expectedManifestHash = yield* canonicalHash('open-input', 'input-manifest', manifestMaterial)
    if (manifestHash !== expectedManifestHash) {
      return yield* mismatch('open-input', ['inputManifest', 'hash'], manifestHash, expectedManifestHash)
    }
    const runId = yield* expectedRunId(input)
    const snapshot = inputManifest.finalizedSnapshot

    const scalarFacts = [
      [['lock', 'schemaVersion'], lock.schemaVersion, 'bayn.qualification-lock.v3'],
      [['inputManifest', 'schemaVersion'], inputManifest.schemaVersion, 'bayn.input-manifest.v3'],
      [['provenance', 'strategy', 'name'], provenance.strategy.name, 'risk-balanced-trend'],
      [['lock', 'candidateRunId'], lock.candidateRunId, runId],
      [['lock', 'protocolHash'], lock.protocolHash, expectedProtocolHash],
      [['lock', 'sourceRevision'], lock.sourceRevision, provenance.sourceRevision],
      [['lock', 'universeId'], lock.universeId, snapshot.universeId],
      [['lock', 'universeSymbolHash'], lock.universeSymbolHash, snapshot.universeSymbolHash],
      [['lock', 'data', 'inputManifestHash'], lock.data.inputManifestHash, inputManifest.hash],
      [['lock', 'data', 'snapshotId'], lock.data.snapshotId, snapshot.snapshotId],
      [['lock', 'data', 'publicationId'], lock.data.publicationId, snapshot.publicationId],
      [['lock', 'data', 'contentHash'], lock.data.contentHash, snapshot.contentHash],
      [['lock', 'data', 'sessionsContentHash'], lock.data.sessionsContentHash, snapshot.sessionsContentHash],
      [['lock', 'data', 'provider'], lock.data.provider, snapshot.source],
      [['lock', 'data', 'sourceFeed'], lock.data.sourceFeed, snapshot.sourceFeed],
      [['lock', 'data', 'adjustment'], lock.data.adjustment, snapshot.adjustment],
      [['lock', 'data', 'calendarVersion'], lock.data.calendarVersion, snapshot.calendarVersion],
      [['lock', 'data', 'firstSession'], lock.data.firstSession, snapshot.firstSession],
      [['lock', 'data', 'lastSession'], lock.data.lastSession, snapshot.lastSession],
    ] as const
    for (const [path, observed, expected] of scalarFacts) {
      if (observed !== expected) return yield* mismatch('open-input', path, observed, expected)
    }

    const imageHash = yield* canonicalHash('open-input', 'image', lock.image, 'lock')
    const expectedImageHash = yield* canonicalHash('open-input', 'image', provenance.image, 'runtime')
    if (imageHash !== expectedImageHash) {
      return yield* mismatch('open-input', ['lock', 'imageHash'], imageHash, expectedImageHash)
    }
    const boundsHash = yield* canonicalHash('open-input', 'bounds', lock.data.bounds, 'lock')
    const expectedBoundsHash = yield* canonicalHash('open-input', 'bounds', inputManifest.bounds, 'input-manifest')
    if (boundsHash !== expectedBoundsHash) {
      return yield* mismatch('open-input', ['lock', 'data', 'boundsHash'], boundsHash, expectedBoundsHash)
    }
    const universeHash = yield* canonicalHash('open-input', 'universe', lock.universe, 'lock')
    const expectedUniverseHash = yield* canonicalHash('open-input', 'universe', snapshot.symbols, 'snapshot')
    if (universeHash !== expectedUniverseHash) {
      return yield* mismatch('open-input', ['lock', 'universeHash'], universeHash, expectedUniverseHash)
    }
    const executionHash = yield* canonicalHash(
      'open-input',
      'execution-policy',
      lock.policies.execution.content,
      'lock',
    )
    const expectedExecutionHash = yield* canonicalHash(
      'open-input',
      'execution-policy',
      parameters.executionModel,
      'parameters',
    )
    if (executionHash !== expectedExecutionHash) {
      return yield* mismatch(
        'open-input',
        ['lock', 'policies', 'execution', 'contentHash'],
        executionHash,
        expectedExecutionHash,
      )
    }

    return { ...input, lock }
  })

export const decodeQualificationRecord = (
  row: QualificationRowPayload,
): Result.Result<QualificationRecord, QualificationDecisionFailure> => {
  const lock = row.lock_payload
  if (row.result_payload === null) return Result.succeed({ state: 'OPENED_INCOMPLETE', lock })
  const result = row.result_payload
  if (result.lockId !== lock.lockId) {
    return mismatch('stored-record', ['result', 'lockId'], result.lockId, lock.lockId)
  }
  if (result.runId !== lock.candidateRunId) {
    return mismatch('stored-record', ['result', 'runId'], result.runId, lock.candidateRunId)
  }
  return Result.succeed({ state: 'TERMINAL', lock, result })
}

export const decodeQualificationRows = (
  rows: readonly QualificationRowPayload[],
): Result.Result<Option.Option<QualificationRecord>, StoredQualificationFailure> => {
  if (rows.length === 0) return Result.succeed(Option.none())
  if (rows.length !== 1) {
    return Result.fail({
      _tag: 'StoredQualificationCardinalityMismatch',
      observedCount: rows.length,
      expectedMaximum: 1,
    })
  }
  const row = rows[0]
  if (row === undefined) {
    return Result.fail({
      _tag: 'StoredQualificationCardinalityMismatch',
      observedCount: 0,
      expectedMaximum: 1,
    })
  }
  return Result.map(decodeQualificationRecord(row), Option.some)
}

export const validateQualificationLockMatch = (
  observed: QualificationLock,
  expected: QualificationLock,
): Result.Result<void, QualificationDecisionFailure> =>
  Result.gen(function* () {
    if (observed.lockId !== expected.lockId) {
      return yield* mismatch('lock-match', ['lock', 'lockId'], observed.lockId, expected.lockId)
    }
    const observedHash = yield* canonicalHash('lock-match', 'qualification-lock', observed, 'observed')
    const expectedHash = yield* canonicalHash('lock-match', 'qualification-lock', expected, 'expected')
    if (observedHash !== expectedHash) {
      return yield* mismatch('lock-match', ['lock', 'contentHash'], observedHash, expectedHash)
    }
  })

export const validateQualificationLineage = (
  observed: readonly string[],
  expected: readonly string[],
): Result.Result<void, QualificationDecisionFailure> => {
  if (observed.length !== expected.length) {
    return mismatch('lineage', ['priorTrialRunIds', 'length'], observed.length, expected.length)
  }
  for (const [index, runId] of observed.entries()) {
    if (runId !== expected[index]) {
      return mismatch('lineage', ['priorTrialRunIds', index], runId, expected[index])
    }
  }
  return Result.void
}

const renderFact = (value: unknown): string => {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'undefined':
      return String(value)
    case 'symbol':
      return value.description === undefined ? 'symbol' : `symbol(${value.description})`
    case 'function':
      return 'function'
    case 'object':
      return Array.isArray(value) ? 'array' : 'object'
  }
  return 'unknown'
}

const renderContractFailure = (failure: ContractConstructionFailure): string => {
  switch (failure._tag) {
    case 'ContractCanonicalizationFailed':
      return `${failure.operation}: ${renderCanonicalJsonFailure(failure.cause)}`
    case 'ContractSchemaInvalid':
      return `${failure.operation}: ${failure.cause.message}`
  }
}

export const renderQualificationDecisionFailure = (failure: QualificationDecisionFailure): string => {
  switch (failure._tag) {
    case 'QualificationSchemaInvalid':
      return `${failure.stage} ${failure.field} failed schema validation: ${failure.cause.message}`
    case 'QualificationCanonicalizationFailed':
      return `${failure.stage} ${failure.operation}${failure.subject === undefined ? '' : ` (${failure.subject})`}: ${renderCanonicalJsonFailure(failure.cause)}`
    case 'QualificationContractConstructionFailed':
      return `${failure.stage} ${failure.operation} construction failed: ${renderContractFailure(failure.cause)}`
    case 'QualificationMismatch':
      return `${failure.stage} mismatch at ${failure.path.join('.')}: observed ${renderFact(failure.observed)}, expected ${renderFact(failure.expected)}`
  }
}

export const renderStoredQualificationFailure = (failure: StoredQualificationFailure): string =>
  failure._tag === 'StoredQualificationCardinalityMismatch'
    ? `qualification identity has ${failure.observedCount} rows, expected at most ${failure.expectedMaximum}`
    : renderQualificationDecisionFailure(failure)
