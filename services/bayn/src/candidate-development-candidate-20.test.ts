import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vm from 'node:vm'

import rawInvalidation from '../candidates/ordinal-20-cross-sectional-short-term-reversal-invalidation.json' with { type: 'json' }
import rawPreregistration from '../candidates/ordinal-20-cross-sectional-short-term-reversal-preregistration.json' with { type: 'json' }
import rawSourceManifest from '../candidates/ordinal-20-cross-sectional-short-term-reversal-source-manifest.json' with { type: 'json' }
import {
  candidate20PrecommitInvalidation,
  candidate20Preregistration,
  frozenCandidateDevelopmentTrialHistory,
  type CandidateDevelopmentNextPreregistration,
} from './candidate-development-calendar'
import {
  authorizeCandidateDevelopmentAttempt,
  loadAuthorizedCandidateDevelopmentExecutableProgram,
  preregisterCandidateDevelopmentAttempt,
  validateCandidateDevelopmentModuleSource,
  validateCandidateDevelopmentTrialHistoryClosure,
  type CandidateDevelopmentStrategyProtocol,
  type CandidateDevelopmentSourceManifest,
  type CandidateDevelopmentVerifiedSource,
} from './candidate-development-command'
import type { CandidateDevelopmentTrialHistory } from './candidate-development-trial-history'
import { defaultProtocolDocument } from './protocol'
import { candidate20InvalidPrecommit } from './strategy/cross-sectional-short-term-reversal/candidate-20'

const modulePath = 'services/bayn/src/strategy/cross-sectional-short-term-reversal/candidate-20.ts'
const sourceManifestPath =
  'services/bayn/candidates/ordinal-20-cross-sectional-short-term-reversal-source-manifest.json'

const invalidAttemptSource: CandidateDevelopmentVerifiedSource = {
  schemaVersion: 'bayn.candidate-development-verified-source.v1',
  sourceRevision: 'a'.repeat(40),
  modulePath,
  moduleBlobOid: 'b'.repeat(40),
  moduleSha256: candidate20Preregistration.moduleSha256,
  sourceManifestPath,
  sourceManifestBlobOid: candidate20PrecommitInvalidation.sourceManifest.blobOid,
  sourceManifestSha256: candidate20PrecommitInvalidation.sourceManifest.sha256,
  sourceManifest: rawSourceManifest as CandidateDevelopmentSourceManifest,
  baselineRunId: 'c'.repeat(64),
  stressedRunId: 'd'.repeat(64),
}

const expectAuthorizationFailure = (result: Result.Result<unknown, unknown>) => {
  expect(result).toMatchObject({
    failure: {
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-attempt-authorization',
    },
  })
}

const mutatedHistory = (mutation: (history: Record<string, unknown>) => void): CandidateDevelopmentTrialHistory => {
  const history = structuredClone(frozenCandidateDevelopmentTrialHistory) as unknown as Record<string, unknown>
  mutation(history)
  return history as unknown as CandidateDevelopmentTrialHistory
}

describe('Candidate 20 invalid precommit containment', () => {
  test('preserves the sealed precommit while recording an explicit unattempted invalidation', () => {
    expect(rawInvalidation as unknown).toEqual(candidate20PrecommitInvalidation as unknown)
    expect(rawPreregistration).toMatchObject({
      candidateOrdinal: 20,
      priorTrialCount: 19,
      modulePath,
      moduleSha256: candidate20PrecommitInvalidation.invalidatedModule.sha256,
    })
    expect(rawSourceManifest).toMatchObject({
      candidateOrdinal: 20,
      priorTrialCount: 19,
      modulePath,
      moduleSha256: candidate20PrecommitInvalidation.invalidatedModule.sha256,
    })
    expect(candidate20Preregistration.preregistration).toEqual({
      sourceRevision: candidate20PrecommitInvalidation.preregistration.sourceRevision,
      path: candidate20PrecommitInvalidation.preregistration.path,
      blobOid: candidate20PrecommitInvalidation.preregistration.blobOid,
    })
    expect(candidate20PrecommitInvalidation).toMatchObject({
      status: 'PRECOMMIT_INVALID',
      attemptStatus: 'UNATTEMPTED',
      metricBearingAttemptsConsumed: 0,
      qualificationAttemptConsumed: false,
      naturalBuild: {
        runId: '30657379582',
        imagePublished: true,
        imageDigest: 'sha256:28f59fb44bdb3008eecd17cf3c053098f214f3d982f26673a44a98d53f767fba',
        deploymentAllowed: false,
      },
      release: {
        runId: '30657658256',
        conclusion: 'CANCELLED',
        promotionCompleted: false,
        rerunAllowed: false,
      },
      nextCandidatePreregistration: null,
    })
    expect(frozenCandidateDevelopmentTrialHistory.latestInvalidPrecommit).toEqual(candidate20PrecommitInvalidation)
    expect(frozenCandidateDevelopmentTrialHistory.developmentCandidateOrdinals).toEqual([17, 18, 19])
    expect(frozenCandidateDevelopmentTrialHistory.developmentCandidateOrdinals).not.toContain(20)
    expect(frozenCandidateDevelopmentTrialHistory.latestDevelopmentEvidence).toMatchObject({
      candidateOrdinal: 19,
      priorTrialCount: 18,
      status: 'DEVELOPMENT_REJECTED',
      qualificationAttemptConsumed: false,
    })
    expect(frozenCandidateDevelopmentTrialHistory.nextCandidatePreregistration).toBeNull()
    expect(validateCandidateDevelopmentTrialHistoryClosure()).toEqual(Result.succeed(undefined))
  })

  test('exports only the explicit non-runnable tombstone contract', () => {
    expect(candidate20InvalidPrecommit).toMatchObject({
      schemaVersion: 'bayn.candidate-development-precommit-tombstone.v1',
      candidateOrdinal: 20,
      status: 'PRECOMMIT_INVALID',
      attemptStatus: 'UNATTEMPTED',
      nextCandidatePreregistration: null,
    })
    expect(
      candidate20InvalidPrecommit.invalidatedModuleSha256 === candidate20PrecommitInvalidation.invalidatedModule.sha256,
    ).toBe(true)
  })

  test('rejects authorization and preregistration before any metric-bearing attempt can begin', () => {
    expectAuthorizationFailure(authorizeCandidateDevelopmentAttempt())
    expectAuthorizationFailure(preregisterCandidateDevelopmentAttempt(invalidAttemptSource))
    expect(candidate20PrecommitInvalidation.metricBearingAttemptsConsumed).toBe(0)
    expect(candidate20PrecommitInvalidation.qualificationAttemptConsumed).toBe(false)
  })

  test('rejects the invalidated state before source verification or module import', async () => {
    let loaderCalls = 0
    const failure = await Effect.runPromise(
      Effect.flip(
        loadAuthorizedCandidateDevelopmentExecutableProgram(modulePath, sourceManifestPath, () => {
          loaderCalls += 1
          return Effect.die(new Error('invalidated Candidate 20 must not reach source verification or import'))
        }),
      ),
    )

    expect(loaderCalls).toBe(0)
    expectAuthorizationFailure(Result.fail(failure))
  })

  test('fails closed when any sealed invalidation or trial-history binding is mutated', () => {
    const mutations: readonly ((history: Record<string, unknown>) => void)[] = [
      (history) => {
        const invalidation = history.latestInvalidPrecommit as Record<string, unknown>
        const module = invalidation.invalidatedModule as Record<string, unknown>
        module.sha256 = '0'.repeat(64)
      },
      (history) => {
        const invalidation = history.latestInvalidPrecommit as Record<string, unknown>
        invalidation.metricBearingAttemptsConsumed = 1
      },
      (history) => {
        history.nextCandidatePreregistration = candidate20Preregistration as CandidateDevelopmentNextPreregistration
      },
      (history) => {
        const reviewed = history.latestReviewedCandidatePreregistration as Record<string, unknown>
        reviewed.moduleSha256 = '1'.repeat(64)
      },
      (history) => {
        history.developmentCandidateOrdinals = [17, 18, 19, 20]
      },
    ]
    for (const mutate of mutations) {
      expectAuthorizationFailure(validateCandidateDevelopmentTrialHistoryClosure(mutatedHistory(mutate)))
    }
  })

  test('rejects generated bundles, frozen inputs, alternate embedded bars, and disabled type checking', async () => {
    const governedSerializedBars = JSON.stringify(
      Array.from({ length: 8 }, (_, index) => ({
        sessionDate: `2026-01-${String(index + 2).padStart(2, '0')}`,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100.5 + index,
        volume: 1_000 + index,
      })),
    )
    const governedPayloadProtocol: CandidateDevelopmentStrategyProtocol = {
      schemaVersion: 'bayn.candidate-development-strategy-protocol.v2',
      universe: ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'],
      directVolatilityTarget: 0.1,
      initialCapitalMicros: '1000000000000',
      executionModel: defaultProtocolDocument.executionModel,
      thresholds: {
        minimumObservations: 504,
        minimumAnnualizedReturn: 0,
        minimumSharpeImprovement: 0,
        maximumDrawdown: 0.35,
        maximumAnnualTurnover: 12,
        requirePositiveDoubleCostReturn: true,
      },
      marketData: {
        schemaVersion: 'bayn.candidate-development-market-data-contract.v1',
        snapshotId: rawPreregistration.marketData.snapshotId,
        contentHash: rawPreregistration.marketData.boundedContentHash,
      },
      benchmarks: {
        schemaVersion: 'bayn.candidate-development-benchmark-policy.v1',
        symbol: 'SPY',
        directVolatilityWindow: 63,
        terminalPolicy: 'last-all-cash-strategy-decision',
      },
      strategyIdentity: {
        schemaVersion: 'bayn.candidate-development-strategy-identity.v2',
        family: 'inverse-volatility-risk-diversification',
        identifier: 'governed-payload-regression',
        researchSources: ['source-a', 'source-b', 'source-c'],
        parameters: {
          id: 'governed-payload-regression',
          lookbackSessions: 21,
          annualizationSessions: 252,
          riskAssets: ['DBC', 'SPY'],
          covarianceEstimator: 'sample',
          targetAnnualizedVolatility: 0.1,
          maximumGrossExposure: 1,
        },
        input: governedSerializedBars,
        weighting: 'runtime-only',
        riskScaling: 'runtime-only',
        allocation: 'runtime-only',
        schedule: 'runtime-only',
        terminal: 'runtime-only',
        missingData: 'fail-closed',
        doubledCost: 'runtime-only',
      },
    }
    const governedStructuralBindings = {
      schemaVersion: 'bayn.candidate-development-artifact-structural-bindings.v1',
      candidateOrdinal: rawPreregistration.candidateOrdinal,
      priorTrialCount: rawPreregistration.priorTrialCount,
      strategyProtocolHash: rawPreregistration.strategyProtocolHash,
      strategyIdentityHash: rawPreregistration.strategyIdentityHash,
      candidateDevelopmentProtocolHash: rawPreregistration.candidateDevelopmentProtocolHash,
      calendarHash: rawPreregistration.calendarHash,
      priorTrialsHash: rawPreregistration.priorTrialsHash,
      modulePath,
      sourceManifestPath,
    }
    const governedPayloadIdentity = governedPayloadProtocol.strategyIdentity
    if (governedPayloadIdentity === undefined) throw new Error('governed payload fixture requires strategy identity')
    const governedBaselineProtocol: CandidateDevelopmentStrategyProtocol = {
      ...governedPayloadProtocol,
      strategyIdentity: { ...governedPayloadIdentity, input: 'runtime-only' },
    }
    const strategyProtocolPayloadSource = `export const candidateDevelopmentArtifact = {
      schemaVersion: 'bayn.candidate-development-artifact.v1',
      input: {},
      strategyProtocol: ${JSON.stringify(governedPayloadProtocol)},
      structuralBindings: ${JSON.stringify(governedStructuralBindings)},
      buildEvaluation: () => JSON.parse(candidateDevelopmentArtifact.strategyProtocol.strategyIdentity.input),
    }\n`
    const structuralBindingsPayloadSource = `export const candidateDevelopmentArtifact = {
      schemaVersion: 'bayn.candidate-development-artifact.v1',
      input: {},
      strategyProtocol: ${JSON.stringify(governedBaselineProtocol)},
      structuralBindings: ${JSON.stringify({ ...governedStructuralBindings, payload: governedSerializedBars })},
      buildEvaluation: () => JSON.parse(candidateDevelopmentArtifact.structuralBindings.payload),
    }\n`
    const regexEncodedBars = Buffer.from(governedSerializedBars, 'utf8').toString('hex')
    const regexPayloadProtocol = JSON.stringify(governedBaselineProtocol).replace(
      '"input":"runtime-only"',
      `"input": /${regexEncodedBars}/.source`,
    )
    const regexPayloadSource = `const decodeHex = (value) => {
      let decoded = ''
      for (let index = 0; index < value.length; index += 2) {
        decoded += String.fromCharCode(Number.parseInt(value.slice(index, index + 2), 16))
      }
      return JSON.parse(decoded)
    }
    export const candidateDevelopmentArtifact = {
      schemaVersion: 'bayn.candidate-development-artifact.v1',
      input: {},
      strategyProtocol: ${regexPayloadProtocol},
      structuralBindings: ${JSON.stringify(governedStructuralBindings)},
      buildEvaluation: (runtimeInput) => ({
        embeddedBars: decodeHex(candidateDevelopmentArtifact.strategyProtocol.strategyIdentity.input),
        sourceRevision: runtimeInput.sourceRevision,
        baselineRunId: runtimeInput.baselineRunId,
        stressedRunId: runtimeInput.stressedRunId,
      }),
    }\n`
    const regexBudgetSource = `export const payload = /${regexEncodedBars}/.source\n`
    const templateSplit = Math.floor(regexEncodedBars.length / 2)
    const interpolatedTemplateExpression = `\`${regexEncodedBars.slice(0, templateSplit)}\${''}${regexEncodedBars.slice(templateSplit)}\${''}\``
    const interpolatedTemplatePayloadProtocol = JSON.stringify(governedBaselineProtocol).replace(
      '"input":"runtime-only"',
      `"input": ${interpolatedTemplateExpression}`,
    )
    const interpolatedTemplatePayloadSource = `const decodeHex = (value) => {
      let decoded = ''
      for (let index = 0; index < value.length; index += 2) {
        decoded += String.fromCharCode(Number.parseInt(value.slice(index, index + 2), 16))
      }
      return JSON.parse(decoded)
    }
    export const candidateDevelopmentArtifact = {
      schemaVersion: 'bayn.candidate-development-artifact.v1',
      input: {},
      strategyProtocol: ${interpolatedTemplatePayloadProtocol},
      structuralBindings: ${JSON.stringify(governedStructuralBindings)},
      buildEvaluation: (runtimeInput) => ({
        embeddedBars: decodeHex(candidateDevelopmentArtifact.strategyProtocol.strategyIdentity.input),
        sourceRevision: runtimeInput.sourceRevision,
        baselineRunId: runtimeInput.baselineRunId,
        stressedRunId: runtimeInput.stressedRunId,
      }),
    }\n`
    const interpolatedTemplateBudgetSource = `export const payload = ${interpolatedTemplateExpression}\n`
    const identifierChunks = Array.from({ length: 3 }, (_, index) => {
      const start = Math.ceil((regexEncodedBars.length * index) / 3)
      const end = Math.ceil((regexEncodedBars.length * (index + 1)) / 3)
      return regexEncodedBars.slice(start, end)
    })
    if (identifierChunks.some((chunk) => chunk.length < 96)) {
      throw new Error('identifier payload regression requires three encoded chunks')
    }
    const identifierNames = identifierChunks.map((chunk, index) => `payload${index}_${chunk}`)
    const identifierObjectMethods = identifierNames
      .slice(0, -1)
      .map((name) => `${name}() {}`)
      .join(',\n')
    const identifierFunctionName = identifierNames.at(-1)
    if (identifierFunctionName === undefined) throw new Error('identifier payload regression requires a function name')
    const identifierPayloadProtocol = JSON.stringify(governedBaselineProtocol).replace(
      '"input":"runtime-only"',
      '"input": identifierEncodedBars',
    )
    const identifierPayloadSource = `const decodeHex = (value) => {
      let decoded = ''
      for (let index = 0; index < value.length; index += 2) {
        decoded += String.fromCharCode(Number.parseInt(value.slice(index, index + 2), 16))
      }
      return JSON.parse(decoded)
    }
    const identifierPayload = {
      ${identifierObjectMethods}
    }
    function ${identifierFunctionName}() {}
    const identifierEncodedBars = [...Object.keys(identifierPayload), ${identifierFunctionName}.name]
      .map((name) => name.slice(name.indexOf('_') + 1))
      .join('')
    export const candidateDevelopmentArtifact = {
      schemaVersion: 'bayn.candidate-development-artifact.v1',
      input: {},
      strategyProtocol: ${identifierPayloadProtocol},
      structuralBindings: ${JSON.stringify(governedStructuralBindings)},
      buildEvaluation: (runtimeInput) => ({
        embeddedBars: decodeHex(candidateDevelopmentArtifact.strategyProtocol.strategyIdentity.input),
        sourceRevision: runtimeInput.sourceRevision,
        baselineRunId: runtimeInput.baselineRunId,
        stressedRunId: runtimeInput.stressedRunId,
      }),
    }\n`
    const identifierPayloadBudgetSource = `export const payload = {
      ${identifierObjectMethods}
    }
    export function ${identifierFunctionName}() {}\n`
    const privateIdentifierNames = identifierChunks.map((chunk, index) => `#payload${index}_${chunk}`)
    const privateIdentifierMethods = privateIdentifierNames.map((name) => `${name}() {}`).join('\n')
    const privateIdentifierReferences = privateIdentifierNames.map((name) => `this.${name}.name`).join(', ')
    const privateIdentifierPayloadProtocol = JSON.stringify(governedBaselineProtocol).replace(
      '"input":"runtime-only"',
      '"input": privateIdentifierEncodedBars',
    )
    const privateIdentifierPayloadSource = `const decodeHex = (value) => {
      let decoded = ''
      for (let index = 0; index < value.length; index += 2) {
        decoded += String.fromCharCode(Number.parseInt(value.slice(index, index + 2), 16))
      }
      return JSON.parse(decoded)
    }
    class PrivateIdentifierPayload {
      ${privateIdentifierMethods}
      encoded() {
        return [${privateIdentifierReferences}]
          .map((name) => name.slice(name.indexOf('_') + 1))
          .join('')
      }
    }
    const privateIdentifierEncodedBars = new PrivateIdentifierPayload().encoded()
    export const candidateDevelopmentArtifact = {
      schemaVersion: 'bayn.candidate-development-artifact.v1',
      input: {},
      strategyProtocol: ${privateIdentifierPayloadProtocol},
      structuralBindings: ${JSON.stringify(governedStructuralBindings)},
      buildEvaluation: (runtimeInput) => ({
        embeddedBars: decodeHex(candidateDevelopmentArtifact.strategyProtocol.strategyIdentity.input),
        sourceRevision: runtimeInput.sourceRevision,
        baselineRunId: runtimeInput.baselineRunId,
        stressedRunId: runtimeInput.stressedRunId,
      }),
    }\n`
    const privateIdentifierPayloadBudgetSource = `export class PrivatePayload {
      ${privateIdentifierMethods}
      names() { return [${privateIdentifierReferences}] }
    }\n`
    const commentPayloadSource = `const decodeHex = (value) => {
      let decoded = ''
      for (let index = 0; index < value.length; index += 2) {
        decoded += String.fromCharCode(Number.parseInt(value.slice(index, index + 2), 16))
      }
      return JSON.parse(decoded)
    }
    export const candidateDevelopmentArtifact = {
      schemaVersion: 'bayn.candidate-development-artifact.v1',
      input: {},
      strategyProtocol: ${JSON.stringify(governedBaselineProtocol)},
      structuralBindings: ${JSON.stringify(governedStructuralBindings)},
      buildEvaluation: function buildEvaluation(runtimeInput) {
        const functionSource = candidateDevelopmentArtifact.buildEvaluation.toString()
        const commentStart = functionSource.lastIndexOf('/*') + 2
        const commentEnd = functionSource.lastIndexOf('*/')
        return {
          embeddedBars: decodeHex(functionSource.slice(commentStart, commentEnd)),
          sourceRevision: runtimeInput.sourceRevision,
          baselineRunId: runtimeInput.baselineRunId,
          stressedRunId: runtimeInput.stressedRunId,
        }
        /*${regexEncodedBars}*/
      },
    }\n`
    const commentPayloadBudgetSource = `export function payload() {
      /*${regexEncodedBars}*/
      return 1
    }\n`
    const keywordPropertyNames = [
      'break',
      'case',
      'catch',
      'class',
      'const',
      'continue',
      'debugger',
      'default',
      'delete',
      'do',
      'else',
      'export',
      'extends',
      'finally',
      'for',
      'function',
    ] as const
    const keywordPropertySequence = Array.from(regexEncodedBars, (digit) => {
      const name = keywordPropertyNames[Number.parseInt(digit, 16)]
      if (name === undefined) throw new Error('keyword property payload requires hexadecimal input')
      return name
    })
    const keywordPropertyObjects = keywordPropertySequence.map((name) => `{${name}:{}}`).join(',\n')
    const keywordPropertyPayloadProtocol = JSON.stringify(governedBaselineProtocol).replace(
      '"input":"runtime-only"',
      '"input": keywordEncodedBars',
    )
    const keywordPropertyPayloadSource = `const decodeHex = (value) => {
      let decoded = ''
      for (let index = 0; index < value.length; index += 2) {
        decoded += String.fromCharCode(Number.parseInt(value.slice(index, index + 2), 16))
      }
      return JSON.parse(decoded)
    }
    const keywordAlphabet = '${keywordPropertyNames.join(' ')}'
    const keywordPayload = [${keywordPropertyObjects}]
    const keywordEncodedBars = keywordPayload
      .map((value) => keywordAlphabet.split(' ').indexOf(Object.keys(value)[0]).toString(16))
      .join('')
    export const candidateDevelopmentArtifact = {
      schemaVersion: 'bayn.candidate-development-artifact.v1',
      input: {},
      strategyProtocol: ${keywordPropertyPayloadProtocol},
      structuralBindings: ${JSON.stringify(governedStructuralBindings)},
      buildEvaluation: (runtimeInput) => ({
        embeddedBars: decodeHex(candidateDevelopmentArtifact.strategyProtocol.strategyIdentity.input),
        sourceRevision: runtimeInput.sourceRevision,
        baselineRunId: runtimeInput.baselineRunId,
        stressedRunId: runtimeInput.stressedRunId,
      }),
    }\n`
    const keywordPropertyPayloadBudgetSource = `export const payload = [${keywordPropertyObjects}]\n`
    const punctuationPayloadBits = Array.from(Buffer.from(governedSerializedBars, 'utf8'), (byte) =>
      byte.toString(2).padStart(8, '0'),
    ).join('')
    const punctuationPayloadElements = Array.from(punctuationPayloadBits, (bit) => (bit === '1' ? '!![]' : '![]')).join(
      ',',
    )
    const punctuationPayloadProtocol = JSON.stringify(governedBaselineProtocol).replace(
      '"input":"runtime-only"',
      '"input": punctuationEncodedBars',
    )
    const punctuationPayloadSource = `const decodeBinary = (value) => {
      let decoded = ''
      for (let index = 0; index < value.length; index += 8) {
        decoded += String.fromCharCode(Number.parseInt(value.slice(index, index + 8), 2))
      }
      return JSON.parse(decoded)
    }
    const punctuationBits = [${punctuationPayloadElements}]
    const punctuationEncodedBars = punctuationBits.map((value) => value ? 1 : 0).join('')
    export const candidateDevelopmentArtifact = {
      schemaVersion: 'bayn.candidate-development-artifact.v1',
      input: {},
      strategyProtocol: ${punctuationPayloadProtocol},
      structuralBindings: ${JSON.stringify(governedStructuralBindings)},
      buildEvaluation: (runtimeInput) => ({
        embeddedBars: decodeBinary(candidateDevelopmentArtifact.strategyProtocol.strategyIdentity.input),
        sourceRevision: runtimeInput.sourceRevision,
        baselineRunId: runtimeInput.baselineRunId,
        stressedRunId: runtimeInput.stressedRunId,
      }),
    }\n`
    const punctuationPayloadBudgetSource = `export const payload = [${punctuationPayloadElements}]\n`
    const adversaries = [
      '// @ts-nocheck\nexport const candidateDevelopmentArtifact = {}\n',
      'var __assign = Object.assign\nexport const candidateDevelopmentArtifact = {}\n',
      `export const sessions = [${Array.from({ length: 9 }, (_, index) => `'2026-01-${String(index + 1).padStart(2, '0')}'`).join(',')}]\n`,
      "export const bars = [{sessionDate:'2026-01-02',open:1,high:1,low:1,close:1,volume:1}]\n",
      `export const bars = [{
        'volume': 10,
        'close': 1,
        'low': 0,
        'sessionDate': 20260102,
        'high': 2,
        'open': 1,
      }]\n`,
      `export const bars = [{
        volume: 10,
        close: 1,
        low: 0,
        high: 2,
        open: 1,
        sessionDate: 20260102,
      }]\n`,
      `export const bars = [{
        ['volume']: 10,
        ['close']: 1,
        ['low']: 0,
        ['sessionDate']: 20260102,
        ['high']: 2,
        ['open']: 1,
      }]\n`,
      `export const bars = {
        dates: [20260102],
        opens: [1],
        highs: [2],
        lows: [0],
        closes: [1],
        volumes: [10],
      }\n`,
      `const sessionDate = 20260102
       const open = 1
       const high = 2
       const low = 0
       const close = 1
       const volume = 10
       export const bars = { sessionDate, open, high, low, close, volume }\n`,
      "export const bars = '20260102,1,2,0,1,10|20260103,1,2,0,1,11'\n",
      strategyProtocolPayloadSource,
      structuralBindingsPayloadSource,
      regexPayloadSource,
      interpolatedTemplatePayloadSource,
      identifierPayloadSource,
      privateIdentifierPayloadSource,
      commentPayloadSource,
      keywordPropertyPayloadSource,
      punctuationPayloadSource,
      `export const oversized = '${'x'.repeat(262_145)}'\n`,
    ]
    for (const source of adversaries) {
      expect(validateCandidateDevelopmentModuleSource(source, 'candidate/adversary.ts')).toMatchObject({
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-module-format',
        },
      })
    }
    expect(validateCandidateDevelopmentModuleSource(regexBudgetSource, 'candidate/regex-budget.ts')).toMatchObject({
      failure: {
        cause: {
          literalPayload: {
            regularExpressionLiteralLengths: [regexEncodedBars.length],
            encodedBinaryStringLengths: [regexEncodedBars.length],
            executableIdentifierCount: 2,
            executableIdentifierBytes: 'payload'.length + 'source'.length,
            executableLiteralCount: 3,
            executableLiteralBytes: regexEncodedBars.length + 'payload'.length + 'source'.length,
          },
        },
      },
    })
    expect(
      validateCandidateDevelopmentModuleSource(
        interpolatedTemplateBudgetSource,
        'candidate/interpolated-template-budget.ts',
      ),
    ).toMatchObject({
      failure: {
        cause: {
          literalPayload: {
            interpolatedTemplateSegmentLengths: [templateSplit, regexEncodedBars.length - templateSplit, 0],
            encodedBinaryStringLengths: [templateSplit, regexEncodedBars.length - templateSplit],
            executableIdentifierCount: 1,
            executableIdentifierBytes: 'payload'.length,
            executableLiteralCount: 6,
            executableLiteralBytes: regexEncodedBars.length + 'payload'.length,
          },
        },
      },
    })
    const identifierPayloadBytes =
      'payload'.length + identifierNames.reduce((total, name) => total + Buffer.byteLength(name, 'utf8'), 0)
    expect(
      validateCandidateDevelopmentModuleSource(identifierPayloadBudgetSource, 'candidate/identifier-budget.ts'),
    ).toMatchObject({
      failure: {
        cause: {
          literalPayload: {
            longIdentifierLengths: identifierNames.map((name) => name.length),
            encodedIdentifierLengths: identifierNames.map((name) => name.length),
            executableIdentifierCount: identifierNames.length + 1,
            executableIdentifierBytes: identifierPayloadBytes,
            executableLiteralCount: identifierNames.length + 1,
            executableLiteralBytes: identifierPayloadBytes,
          },
        },
      },
    })
    const privateIdentifierPayloadBytes =
      'PrivatePayload'.length +
      'names'.length +
      'name'.length * privateIdentifierNames.length +
      privateIdentifierNames.reduce((total, name) => total + Buffer.byteLength(name, 'utf8') * 2, 0)
    expect(
      validateCandidateDevelopmentModuleSource(
        privateIdentifierPayloadBudgetSource,
        'candidate/private-identifier-budget.ts',
      ),
    ).toMatchObject({
      failure: {
        cause: {
          literalPayload: {
            longIdentifierLengths: [...privateIdentifierNames, ...privateIdentifierNames].map((name) => name.length),
            encodedIdentifierLengths: [...privateIdentifierNames, ...privateIdentifierNames].map((name) => name.length),
            executableIdentifierCount: 2 + privateIdentifierNames.length * 3,
            executableIdentifierBytes: privateIdentifierPayloadBytes,
            executableLiteralCount: 2 + privateIdentifierNames.length * 3,
            executableLiteralBytes: privateIdentifierPayloadBytes,
          },
        },
      },
    })
    expect(
      validateCandidateDevelopmentModuleSource(commentPayloadBudgetSource, 'candidate/comment-budget.ts'),
    ).toMatchObject({
      failure: {
        cause: {
          literalPayload: {
            commentLengths: [regexEncodedBars.length],
            executableCommentCount: 1,
            executableCommentBytes: regexEncodedBars.length,
            encodedBinaryStringLengths: [regexEncodedBars.length],
          },
        },
      },
    })
    const keywordPropertyBytes = keywordPropertySequence.reduce(
      (total, name) => total + Buffer.byteLength(name, 'utf8'),
      0,
    )
    expect(
      validateCandidateDevelopmentModuleSource(
        keywordPropertyPayloadBudgetSource,
        'candidate/keyword-property-budget.ts',
      ),
    ).toMatchObject({
      failure: {
        cause: {
          literalPayload: {
            keywordPropertyNameCount: keywordPropertySequence.length,
            keywordPropertyNameBytes: keywordPropertyBytes,
            executableIdentifierCount: keywordPropertySequence.length + 1,
            executableIdentifierBytes: keywordPropertyBytes + 'payload'.length,
            executableLiteralCount: keywordPropertySequence.length + 1,
            executableLiteralBytes: keywordPropertyBytes + 'payload'.length,
          },
        },
      },
    })
    expect(
      validateCandidateDevelopmentModuleSource(punctuationPayloadBudgetSource, 'candidate/punctuation-array-budget.ts'),
    ).toMatchObject({
      failure: {
        cause: {
          literalPayload: {
            executableArrayCount: 1,
            largestExecutableArray: punctuationPayloadBits.length,
          },
        },
      },
    })

    const governedBaseline = `export const candidateDevelopmentArtifact = {
      schemaVersion: 'bayn.candidate-development-artifact.v1',
      input: {},
      strategyProtocol: ${JSON.stringify(governedBaselineProtocol)},
      structuralBindings: ${JSON.stringify(governedStructuralBindings)},
      buildEvaluation: (runtimeInput) => runtimeInput,
    }\n`
    expect(validateCandidateDevelopmentModuleSource(governedBaseline, 'candidate/governed-baseline.ts')).toEqual(
      Result.succeed(undefined),
    )

    const runtimeProvenance = {
      sourceRevision: '1'.repeat(40),
      baselineRunId: '2'.repeat(64),
      stressedRunId: '3'.repeat(64),
    }
    const executeSource = async (source: string): Promise<{ readonly directory: string; readonly output: unknown }> => {
      const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-executable-regression-'))
      const executablePath = join(directory, 'candidate.mjs')
      try {
        await writeFile(executablePath, source)
        const context = vm.createContext(Object.create(null))
        const candidateModule = new vm.SourceTextModule(await readFile(executablePath, 'utf8'), {
          context,
          identifier: executablePath,
        })
        await candidateModule.link(() => {
          throw new Error('executable regression imports are prohibited')
        })
        await candidateModule.evaluate()
        const candidateDevelopmentArtifact = Reflect.get(candidateModule.namespace, 'candidateDevelopmentArtifact') as {
          readonly buildEvaluation: (runtimeInput: typeof runtimeProvenance) => unknown
        }
        const output = candidateDevelopmentArtifact.buildEvaluation(runtimeProvenance)
        return { directory, output: JSON.parse(JSON.stringify(output)) as unknown }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
    const removed = async (path: string): Promise<boolean> => {
      try {
        await access(path)
        return false
      } catch {
        return true
      }
    }
    const executeValidatedSource = async (source: string): Promise<unknown> => {
      const validation = validateCandidateDevelopmentModuleSource(source, 'candidate/executable-regression.ts')
      if (Result.isFailure(validation)) throw validation.failure
      return (await executeSource(source)).output
    }

    const captureRejectedSource = async (source: string): Promise<unknown> => {
      try {
        await executeValidatedSource(source)
      } catch (cause) {
        return cause
      }
      throw new Error('embedded governed payload unexpectedly executed')
    }
    expect(await captureRejectedSource(strategyProtocolPayloadSource)).toMatchObject({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-module-format',
    })
    expect(await captureRejectedSource(structuralBindingsPayloadSource)).toMatchObject({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-module-format',
    })
    const regexExecution = await executeSource(regexPayloadSource)
    expect(regexExecution.output).toEqual({
      embeddedBars: JSON.parse(governedSerializedBars) as unknown,
      ...runtimeProvenance,
    })
    expect(await removed(regexExecution.directory)).toBe(true)
    expect(await captureRejectedSource(regexPayloadSource)).toMatchObject({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-module-format',
    })
    const interpolatedTemplateExecution = await executeSource(interpolatedTemplatePayloadSource)
    expect(interpolatedTemplateExecution.output).toEqual({
      embeddedBars: JSON.parse(governedSerializedBars) as unknown,
      ...runtimeProvenance,
    })
    expect(await removed(interpolatedTemplateExecution.directory)).toBe(true)
    expect(await captureRejectedSource(interpolatedTemplatePayloadSource)).toMatchObject({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-module-format',
    })
    const identifierExecution = await executeSource(identifierPayloadSource)
    expect(identifierExecution.output).toEqual({
      embeddedBars: JSON.parse(governedSerializedBars) as unknown,
      ...runtimeProvenance,
    })
    expect(await removed(identifierExecution.directory)).toBe(true)
    expect(await captureRejectedSource(identifierPayloadSource)).toMatchObject({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-module-format',
    })
    const privateIdentifierExecution = await executeSource(privateIdentifierPayloadSource)
    expect(privateIdentifierExecution.output).toEqual({
      embeddedBars: JSON.parse(governedSerializedBars) as unknown,
      ...runtimeProvenance,
    })
    expect(await removed(privateIdentifierExecution.directory)).toBe(true)
    expect(await captureRejectedSource(privateIdentifierPayloadSource)).toMatchObject({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-module-format',
    })
    const commentExecution = await executeSource(commentPayloadSource)
    expect(commentExecution.output).toEqual({
      embeddedBars: JSON.parse(governedSerializedBars) as unknown,
      ...runtimeProvenance,
    })
    expect(await removed(commentExecution.directory)).toBe(true)
    expect(await captureRejectedSource(commentPayloadSource)).toMatchObject({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-module-format',
    })
    const keywordPropertyExecution = await executeSource(keywordPropertyPayloadSource)
    expect(keywordPropertyExecution.output).toEqual({
      embeddedBars: JSON.parse(governedSerializedBars) as unknown,
      ...runtimeProvenance,
    })
    expect(await removed(keywordPropertyExecution.directory)).toBe(true)
    expect(await captureRejectedSource(keywordPropertyPayloadSource)).toMatchObject({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-module-format',
    })
    const punctuationExecution = await executeSource(punctuationPayloadSource)
    expect(punctuationExecution.output).toEqual({
      embeddedBars: JSON.parse(governedSerializedBars) as unknown,
      ...runtimeProvenance,
    })
    expect(await removed(punctuationExecution.directory)).toBe(true)
    expect(await captureRejectedSource(punctuationPayloadSource)).toMatchObject({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-module-format',
    })
    expect(await executeValidatedSource(governedBaseline)).toEqual(runtimeProvenance)

    const runtimeSyntaxControl =
      "const ratio = ({ valueOf: () => 10 }) / 2\nconst label = `SPY${{ value: `-${'D'}` }.value}BC${''}`\nconst ordinaryMethods = { normalize() {}, render() {} }\nfunction ordinaryHelper() { /* ordinary implementation note */ }\nclass OrdinaryPrivate { #normalize() {} name() { return this.#normalize.name } }\nconst ordinaryPrivateName = new OrdinaryPrivate().name()\nexport const smallRuntimePattern = /SPY|DBC/.test('SPY') && ratio === 5 && label === 'SPY-DBC' && Object.keys(ordinaryMethods).join('-') === 'normalize-render' && ordinaryHelper.name === 'ordinaryHelper' && ordinaryPrivateName === '#normalize'\n"
    expect(
      validateCandidateDevelopmentModuleSource(runtimeSyntaxControl, 'candidate/runtime-syntax-control.ts'),
    ).toEqual(Result.succeed(undefined))
    const keywordSyntaxControl =
      "const ordinaryKeywords = { if: 1, else() { return 2 } }\nif (ordinaryKeywords.if !== 1) throw new Error('unexpected keyword value')\nexport const keywordControl = Object.keys(ordinaryKeywords).join('-') === 'if-else' && ordinaryKeywords.else() === 2\n"
    expect(
      validateCandidateDevelopmentModuleSource(keywordSyntaxControl, 'candidate/keyword-syntax-control.ts'),
    ).toEqual(Result.succeed(undefined))
    const punctuationSyntaxControl =
      "const punctuation = [!![], ![]]\nexport const punctuationControl = punctuation.map((value) => value ? 1 : 0).join('') === '10'\n"
    expect(
      validateCandidateDevelopmentModuleSource(punctuationSyntaxControl, 'candidate/punctuation-syntax-control.ts'),
    ).toEqual(Result.succeed(undefined))

    const concise = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: {
          candidateOrdinal: 21,
          priorTrialCount: 20,
          expectedStrategyProtocolHash: '${'a'.repeat(64)}',
          officialSessions: [],
          signalSessionDates: [],
          featureLookbackSessions: 126,
        },
        strategyProtocol: {
          universe: ['SPY', 'DBC', 'IEF', 'EFA', 'VNQ'],
          executionModel: { spreadBps: 2, slippageBps: 3 },
        },
        structuralBindings: {
          hashes: ['${'b'.repeat(64)}', '${'c'.repeat(64)}', '${'d'.repeat(64)}'],
        },
        buildEvaluation: (runtimeInput) => ({
          sourceRevision: runtimeInput.sourceRevision,
          baselineRunId: runtimeInput.baselineRunId,
          stressedRunId: runtimeInput.stressedRunId,
        }),
      }
    `
    expect(validateCandidateDevelopmentModuleSource(concise, 'candidate/concise.ts')).toEqual(Result.succeed(undefined))
  })
})
