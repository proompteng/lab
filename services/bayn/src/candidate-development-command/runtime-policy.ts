import { Effect, pipe, Result } from 'effect'
import {
  candidateDevelopmentCalendarContract,
  officialMonthEndSignalDates,
  preflightCandidateDevelopment,
  type CandidateDevelopmentPreflightInput,
} from '../candidate-development'
import { frozenCandidateDevelopmentSessions } from '../candidate-development-calendar'
import {
  deriveCandidateDevelopmentPriorTrialsHash,
  frozenCandidateDevelopmentTrialHistory,
} from '../candidate-development-trial-history'
import { type CandidateDevelopmentNextPreregistration } from '../candidate-development-decision'
import { canonicalHashV1Result } from '../hash'
import type {
  CandidateDevelopmentArtifactStructuralBindings,
  CandidateDevelopmentCommandEvaluation,
  CandidateDevelopmentCommandFailure,
  CandidateDevelopmentExecutableProgram,
  CandidateDevelopmentMarketDataWitness,
  CandidateDevelopmentStrategyProtocol,
  CandidateDevelopmentVerifiedSource,
  CandidateDevelopmentVerifiedSourceFiles,
} from './contracts'
import {
  candidateDevelopmentExecutableProgramSchemaVersion,
  decodeCandidateDevelopmentArtifactStructuralBindings,
  decodeCandidateDevelopmentEvaluation,
  decodeCandidateDevelopmentMarketDataWitness,
  decodeCandidateDevelopmentPreregistrationDocument,
  decodeCandidateDevelopmentPreflightInput,
  decodeCandidateDevelopmentStrategyProtocol,
} from './contracts'
import { compareMarketBars, sourceVerificationFailure } from './evaluation'

type ExecutableProgram = CandidateDevelopmentExecutableProgram<
  unknown,
  unknown,
  CandidateDevelopmentCommandFailure,
  never
>

export const validateCandidateDevelopmentRuntimeMarketData = (
  value: unknown,
  verifiedSource: CandidateDevelopmentVerifiedSource,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  preflightInput: CandidateDevelopmentPreflightInput,
): Result.Result<CandidateDevelopmentMarketDataWitness, CandidateDevelopmentCommandFailure> => {
  const expectedBarCount = preflightInput.officialSessions.length * strategyProtocol.universe.length
  if (!Number.isSafeInteger(expectedBarCount) || expectedBarCount <= 0) {
    return Result.fail(
      sourceVerificationFailure('verify-runtime-market-data', {
        field: 'runtimeMarketData.expectedBarCount',
        expected: 'a positive safe integer derived from official sessions and the governed universe',
        observed: expectedBarCount,
      }),
    )
  }
  const rawBars =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as { readonly bars?: unknown }).bars
      : undefined
  if (Array.isArray(rawBars) && rawBars.length !== expectedBarCount) {
    return Result.fail(
      sourceVerificationFailure('verify-runtime-market-data', {
        field: 'runtimeMarketData.bars.length',
        expected: expectedBarCount,
        observed: rawBars.length,
      }),
    )
  }
  const decoded = decodeCandidateDevelopmentMarketDataWitness(value)
  if (Result.isFailure(decoded)) {
    return Result.fail(sourceVerificationFailure('verify-runtime-market-data', decoded.failure))
  }
  const witness = decoded.success as CandidateDevelopmentMarketDataWitness
  const { contentHash: observedContentHash, ...content } = witness
  const recomputedContentHash = canonicalHashV1Result(content)
  if (Result.isFailure(recomputedContentHash)) {
    return Result.fail(sourceVerificationFailure('verify-runtime-market-data', recomputedContentHash.failure))
  }
  const committed = verifiedSource.sourceManifest.marketData
  const bindings = [
    ['contentHash', committed.boundedContentHash, observedContentHash],
    ['recomputedContentHash', recomputedContentHash.success, observedContentHash],
    ['strategyProtocol.contentHash', strategyProtocol.marketData.contentHash, observedContentHash],
    ['snapshotId', committed.snapshotId, witness.snapshotId],
    ['strategyProtocol.snapshotId', strategyProtocol.marketData.snapshotId, witness.snapshotId],
    ['inputManifestHash', committed.inputManifestHash, witness.inputManifestHash],
  ] as const
  for (const [field, expected, observed] of bindings) {
    if (expected !== observed) {
      return Result.fail(
        sourceVerificationFailure('verify-runtime-market-data', {
          field: `runtimeMarketData.${field}`,
          expected,
          observed,
        }),
      )
    }
  }
  if (witness.bars.length !== expectedBarCount) {
    return Result.fail(
      sourceVerificationFailure('verify-runtime-market-data', {
        field: 'runtimeMarketData.bars.length',
        expected: expectedBarCount,
        observed: witness.bars.length,
      }),
    )
  }
  const firstBar = witness.bars[0]
  const expectedProvenance =
    firstBar === undefined
      ? undefined
      : {
          source: firstBar.source,
          sourceFeed: firstBar.sourceFeed,
          adjustment: firstBar.adjustment,
          publicationSchemaVersion: firstBar.publicationSchemaVersion,
        }
  for (let index = 0; index < witness.bars.length; index += 1) {
    const bar = witness.bars[index]
    if (bar === undefined) continue
    const sessionIndex = Math.floor(index / strategyProtocol.universe.length)
    const symbolIndex = index % strategyProtocol.universe.length
    const expectedSessionDate = preflightInput.officialSessions[sessionIndex]
    const expectedSymbol = strategyProtocol.universe[symbolIndex]
    if (bar.sessionDate !== expectedSessionDate) {
      return Result.fail(
        sourceVerificationFailure('verify-runtime-market-data', {
          field: `runtimeMarketData.bars[${index}].sessionDate`,
          expected: expectedSessionDate,
          observed: bar.sessionDate,
        }),
      )
    }
    if (bar.symbol !== expectedSymbol) {
      return Result.fail(
        sourceVerificationFailure('verify-runtime-market-data', {
          field: `runtimeMarketData.bars[${index}].symbol`,
          expected: expectedSymbol,
          observed: bar.symbol,
        }),
      )
    }
    if (index > 0) {
      const previous = witness.bars[index - 1]
      if (previous !== undefined && compareMarketBars(previous, bar) >= 0) {
        return Result.fail(
          sourceVerificationFailure('verify-runtime-market-data', {
            field: `runtimeMarketData.bars[${index}].order`,
            expected: 'strict session-date/symbol order',
            observed: {
              previous: [previous.sessionDate, previous.symbol],
              current: [bar.sessionDate, bar.symbol],
            },
          }),
        )
      }
    }
    const observedProvenance = {
      source: bar.source,
      sourceFeed: bar.sourceFeed,
      adjustment: bar.adjustment,
      publicationSchemaVersion: bar.publicationSchemaVersion,
    }
    if (
      expectedProvenance === undefined ||
      expectedProvenance.source !== observedProvenance.source ||
      expectedProvenance.sourceFeed !== observedProvenance.sourceFeed ||
      expectedProvenance.adjustment !== observedProvenance.adjustment ||
      expectedProvenance.publicationSchemaVersion !== observedProvenance.publicationSchemaVersion
    ) {
      return Result.fail(
        sourceVerificationFailure('verify-runtime-market-data', {
          field: `runtimeMarketData.bars[${index}].provenance`,
          expected: expectedProvenance,
          observed: observedProvenance,
        }),
      )
    }
  }
  return Result.succeed(witness)
}

export const deriveCandidateDevelopmentArtifactPreflightInput = (
  declaredInput: unknown,
  verifiedFiles: CandidateDevelopmentVerifiedSourceFiles,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<CandidateDevelopmentPreflightInput, CandidateDevelopmentCommandFailure> => {
  const declared = declaredInput === undefined ? undefined : decodeCandidateDevelopmentPreflightInput(declaredInput)
  if (declared !== undefined && Result.isFailure(declared)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'input-invalid',
      cause: declared.failure,
    })
  }
  if (verifiedFiles.sourceManifest.candidateOrdinal < 19) {
    return declared === undefined
      ? Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'input-missing' })
      : Result.succeed(declared.success)
  }
  const strategyIdentity = strategyProtocol.strategyIdentity
  if (strategyIdentity === undefined) {
    return Result.fail(
      sourceVerificationFailure('verify-program-binding', {
        field: 'artifact.strategyProtocol.strategyIdentity',
        expected: 'strategy identity with a causal lookback',
        observed: undefined,
      }),
    )
  }
  const officialSessions = frozenCandidateDevelopmentSessions()
  const derived = decodeCandidateDevelopmentPreflightInput({
    candidateOrdinal: verifiedFiles.sourceManifest.candidateOrdinal,
    priorTrialCount: verifiedFiles.sourceManifest.priorTrialCount,
    expectedStrategyProtocolHash: verifiedFiles.sourceManifest.strategyProtocolHash,
    officialSessions,
    signalSessionDates: officialMonthEndSignalDates(officialSessions),
    featureLookbackSessions: strategyIdentity.parameters.lookbackSessions,
  })
  if (Result.isFailure(derived)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'input-invalid',
      cause: derived.failure,
    })
  }
  if (declared !== undefined) {
    const hashes = Result.all({
      expected: canonicalHashV1Result(derived.success),
      observed: canonicalHashV1Result(declared.success),
    })
    if (Result.isFailure(hashes)) {
      return Result.fail({ _tag: 'CandidateDevelopmentCommandHashFailed', cause: hashes.failure })
    }
    if (hashes.success.expected !== hashes.success.observed) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field: 'artifact.input',
          expected: hashes.success.expected,
          observed: hashes.success.observed,
        }),
      )
    }
  }
  return Result.succeed(derived.success)
}

export const validateCandidateDevelopmentPreregistrationDocument = (
  expected: CandidateDevelopmentNextPreregistration,
  value: unknown,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const decoded = decodeCandidateDevelopmentPreregistrationDocument(value)
  if (Result.isFailure(decoded)) {
    return Result.fail(sourceVerificationFailure('decode-preregistration', decoded.failure))
  }
  const observed = decoded.success
  const bindings = [
    ['schemaVersion', expected.schemaVersion, observed.schemaVersion],
    ['candidateOrdinal', expected.candidateOrdinal, observed.candidateOrdinal],
    ['priorTrialCount', expected.priorTrialCount, observed.priorTrialCount],
    ['strategyProtocolHash', expected.strategyProtocolHash, observed.strategyProtocolHash],
    ['strategyIdentityHash', expected.strategyIdentityHash, observed.strategyIdentityHash],
    [
      'candidateDevelopmentProtocolHash',
      expected.candidateDevelopmentProtocolHash,
      observed.candidateDevelopmentProtocolHash,
    ],
    ['calendarHash', expected.calendarHash, observed.calendarHash],
    ['priorTrialsHash', expected.priorTrialsHash, observed.priorTrialsHash],
    ['modulePath', expected.modulePath, observed.modulePath],
    ['moduleSha256', expected.moduleSha256, observed.moduleSha256],
    ['marketData.schemaVersion', expected.marketData.schemaVersion, observed.marketData.schemaVersion],
    ['marketData.snapshotId', expected.marketData.snapshotId, observed.marketData.snapshotId],
    [
      'marketData.finalizedSnapshotContentHash',
      expected.marketData.finalizedSnapshotContentHash,
      observed.marketData.finalizedSnapshotContentHash,
    ],
    ['marketData.inputManifestHash', expected.marketData.inputManifestHash, observed.marketData.inputManifestHash],
    ['marketData.boundedContentHash', expected.marketData.boundedContentHash, observed.marketData.boundedContentHash],
  ] as const
  for (const [field, expectedValue, observedValue] of bindings) {
    if (expectedValue !== observedValue) {
      return Result.fail(
        sourceVerificationFailure('verify-preregistration-blob', {
          field,
          expected: expectedValue,
          observed: observedValue,
        }),
      )
    }
  }
  return Result.succeed(undefined)
}

export const validateCandidateDevelopmentArtifactStructure = (
  value: unknown,
  input: CandidateDevelopmentPreflightInput,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Result.Result<CandidateDevelopmentArtifactStructuralBindings | undefined, CandidateDevelopmentCommandFailure> => {
  if (input.candidateOrdinal < 19 && value === undefined) return Result.succeed(undefined)
  const decoded = decodeCandidateDevelopmentArtifactStructuralBindings(value)
  if (Result.isFailure(decoded)) {
    return Result.fail(sourceVerificationFailure('verify-program-binding', decoded.failure))
  }
  const bindings = decoded.success
  const preregistration = frozenCandidateDevelopmentTrialHistory.latestReviewedCandidatePreregistration
  const preflight = preflightCandidateDevelopment(input)
  if (Result.isFailure(preflight) || preflight.success.status !== 'PASS') {
    return Result.fail(
      sourceVerificationFailure('verify-program-binding', {
        field: 'artifact.preflight',
        expected: 'PASS',
        observed: Result.isFailure(preflight) ? preflight.failure : preflight.success,
      }),
    )
  }
  if (strategyProtocol.strategyIdentity === undefined) {
    return Result.fail(
      sourceVerificationFailure('verify-program-binding', {
        field: 'artifact.strategyProtocol.strategyIdentity',
        expected: 'immutable strategy identity',
        observed: undefined,
      }),
    )
  }
  const hashes = Result.all({
    strategyProtocolHash: canonicalHashV1Result(strategyProtocol),
    strategyIdentityHash: canonicalHashV1Result(strategyProtocol.strategyIdentity),
    calendarHash: canonicalHashV1Result(candidateDevelopmentCalendarContract),
    priorTrialsHash: deriveCandidateDevelopmentPriorTrialsHash(
      frozenCandidateDevelopmentTrialHistory.latestReviewedCandidatePriorTrials,
    ),
  })
  if (Result.isFailure(hashes)) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandHashFailed', cause: hashes.failure })
  }
  const manifest = verifiedSource.sourceManifest
  const expectedBindings = [
    ['candidateOrdinal', input.candidateOrdinal, bindings.candidateOrdinal],
    ['priorTrialCount', input.priorTrialCount, bindings.priorTrialCount],
    ['strategyProtocolHash', hashes.success.strategyProtocolHash, bindings.strategyProtocolHash],
    ['strategyIdentityHash', hashes.success.strategyIdentityHash, bindings.strategyIdentityHash],
    [
      'candidateDevelopmentProtocolHash',
      preflight.success.protocolIdentity.candidateDevelopmentProtocolHash,
      bindings.candidateDevelopmentProtocolHash,
    ],
    ['calendarHash', hashes.success.calendarHash, bindings.calendarHash],
    ['priorTrialsHash', hashes.success.priorTrialsHash, bindings.priorTrialsHash],
    ['modulePath', verifiedSource.modulePath, bindings.modulePath],
    ['sourceManifestPath', verifiedSource.sourceManifestPath, bindings.sourceManifestPath],
    ['preregistration.candidateOrdinal', preregistration.candidateOrdinal, bindings.candidateOrdinal],
    ['preregistration.priorTrialCount', preregistration.priorTrialCount, bindings.priorTrialCount],
    ['preregistration.strategyProtocolHash', preregistration.strategyProtocolHash, bindings.strategyProtocolHash],
    ['preregistration.strategyIdentityHash', preregistration.strategyIdentityHash, bindings.strategyIdentityHash],
    [
      'preregistration.candidateDevelopmentProtocolHash',
      preregistration.candidateDevelopmentProtocolHash,
      bindings.candidateDevelopmentProtocolHash,
    ],
    ['preregistration.calendarHash', preregistration.calendarHash, bindings.calendarHash],
    ['preregistration.priorTrialsHash', preregistration.priorTrialsHash, bindings.priorTrialsHash],
    ['preregistration.modulePath', preregistration.modulePath, bindings.modulePath],
    ['preregistration.moduleSha256', preregistration.moduleSha256, verifiedSource.moduleSha256],
    ['manifest.candidateOrdinal', bindings.candidateOrdinal, manifest.candidateOrdinal],
    ['manifest.priorTrialCount', bindings.priorTrialCount, manifest.priorTrialCount],
    ['manifest.strategyProtocolHash', bindings.strategyProtocolHash, manifest.strategyProtocolHash],
    ['manifest.strategyIdentityHash', bindings.strategyIdentityHash, manifest.strategyIdentityHash],
    [
      'manifest.candidateDevelopmentProtocolHash',
      bindings.candidateDevelopmentProtocolHash,
      manifest.candidateDevelopmentProtocolHash,
    ],
    ['manifest.calendarHash', bindings.calendarHash, manifest.calendarHash],
    ['manifest.priorTrialsHash', bindings.priorTrialsHash, manifest.priorTrialsHash],
    ['manifest.modulePath', bindings.modulePath, manifest.modulePath],
    ['manifest.moduleSha256', verifiedSource.moduleSha256, manifest.moduleSha256],
  ] as const
  for (const [field, expected, observed] of expectedBindings) {
    if (expected !== observed) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field: `artifact.structuralBindings.${field}`,
          expected,
          observed,
        }),
      )
    }
  }
  return Result.succeed(bindings)
}

export const validateCandidateDevelopmentCommandEvaluation = (
  value: unknown,
): Result.Result<CandidateDevelopmentCommandEvaluation, CandidateDevelopmentCommandFailure> =>
  pipe(
    decodeCandidateDevelopmentEvaluation(value),
    Result.map((evaluation) => evaluation as CandidateDevelopmentCommandEvaluation),
    Result.mapError(
      (cause): CandidateDevelopmentCommandFailure => ({
        _tag: 'CandidateDevelopmentCommandProgramInvalid',
        reason: 'evaluation-invalid',
        cause,
      }),
    ),
  )

export const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export const validateCandidateDevelopmentExecutableProgram = (
  value: unknown,
): Result.Result<ExecutableProgram, CandidateDevelopmentCommandFailure> => {
  const program = recordOf(value)
  if (program === undefined) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'module-export-missing' })
  }
  if (program.schemaVersion !== candidateDevelopmentExecutableProgramSchemaVersion) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'schema-version-mismatch' })
  }
  if (recordOf(program.input) === undefined) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'input-missing' })
  }
  if (recordOf(program.strategyProtocol) === undefined) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'strategy-protocol-missing' })
  }
  const effects = recordOf(program.effects)
  if (effects === undefined) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'effects-missing' })
  }
  if (
    typeof effects.preregisterCandidate !== 'function' ||
    typeof effects.loadDevelopmentData !== 'function' ||
    typeof effects.evaluateDevelopment !== 'function'
  ) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'effect-function-missing' })
  }
  const input = decodeCandidateDevelopmentPreflightInput(program.input)
  if (Result.isFailure(input)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'input-invalid',
      cause: input.failure,
    })
  }
  const strategyProtocol = decodeCandidateDevelopmentStrategyProtocol(program.strategyProtocol)
  if (Result.isFailure(strategyProtocol)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'strategy-protocol-invalid',
      cause: strategyProtocol.failure,
    })
  }
  const strategyProtocolHash = canonicalHashV1Result(strategyProtocol.success)
  if (Result.isFailure(strategyProtocolHash)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'strategy-protocol-invalid',
      cause: strategyProtocolHash.failure,
    })
  }
  if (strategyProtocolHash.success !== input.success.expectedStrategyProtocolHash) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'strategy-protocol-hash-mismatch',
      cause: {
        expected: input.success.expectedStrategyProtocolHash,
        observed: strategyProtocolHash.success,
      },
    })
  }
  const typedEffects = effects as unknown as ExecutableProgram['effects']
  return Result.succeed({
    schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
    input: input.success,
    strategyProtocol: strategyProtocol.success as CandidateDevelopmentStrategyProtocol,
    effects: {
      ...typedEffects,
      evaluateDevelopment: (data, preflight, verifiedSource) =>
        typedEffects
          .evaluateDevelopment(data, preflight, verifiedSource)
          .pipe(
            Effect.flatMap((evaluation) =>
              Effect.fromResult(validateCandidateDevelopmentCommandEvaluation(evaluation)),
            ),
          ),
    },
  })
}
