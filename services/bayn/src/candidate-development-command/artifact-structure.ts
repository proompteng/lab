import { SyntaxKind } from 'typescript/unstable/ast'
import {
  candidateExecutableKeywordPropertyToken,
  candidatePropertyNameAt,
  candidateRegexLiteralCanStartAfter,
  candidateScalarToken,
  candidateTokenName,
  type CandidateDevelopmentSourceToken,
} from './artifact-scanner'

export interface CandidateDevelopmentTokenRange {
  readonly name: 'strategyProtocol' | 'structuralBindings'
  readonly start: number
  readonly end: number
}

export interface CandidateDevelopmentGovernedScalar {
  readonly metadata: CandidateDevelopmentTokenRange['name']
  readonly path: readonly string[]
}

export const candidateDevelopmentGovernedMetadataRanges = (
  tokens: readonly CandidateDevelopmentSourceToken[],
): readonly CandidateDevelopmentTokenRange[] => {
  const artifactName = tokens.findIndex(
    (token, index) =>
      candidateTokenName(token) === 'candidateDevelopmentArtifact' &&
      tokens[index + 1]?.kind === SyntaxKind.EqualsToken &&
      tokens[index + 2]?.kind === SyntaxKind.OpenBraceToken,
  )
  if (artifactName < 0) return []
  const objectStart = artifactName + 2
  const ranges: CandidateDevelopmentTokenRange[] = []
  let curlyDepth = 1
  let squareDepth = 0
  let parenDepth = 0
  for (let index = objectStart + 1; index < tokens.length && curlyDepth > 0; index += 1) {
    const token = tokens[index]
    if (token === undefined) break
    if (curlyDepth === 1 && squareDepth === 0 && parenDepth === 0) {
      const property = candidatePropertyNameAt(tokens, index)
      const name = property?.name
      if (
        (name === 'strategyProtocol' || name === 'structuralBindings') &&
        tokens[(property?.end ?? index) + 1]?.kind === SyntaxKind.ColonToken
      ) {
        const valueStart = (property?.end ?? index) + 2
        let valueCurly = 0
        let valueSquare = 0
        let valueParen = 0
        let valueEnd = valueStart
        for (; valueEnd < tokens.length; valueEnd += 1) {
          const valueToken = tokens[valueEnd]
          if (valueToken === undefined) break
          if (
            valueCurly === 0 &&
            valueSquare === 0 &&
            valueParen === 0 &&
            (valueToken.kind === SyntaxKind.CommaToken || valueToken.kind === SyntaxKind.CloseBraceToken)
          )
            break
          if (valueToken.kind === SyntaxKind.OpenBraceToken) valueCurly += 1
          else if (valueToken.kind === SyntaxKind.CloseBraceToken) valueCurly -= 1
          else if (valueToken.kind === SyntaxKind.OpenBracketToken) valueSquare += 1
          else if (valueToken.kind === SyntaxKind.CloseBracketToken) valueSquare -= 1
          else if (valueToken.kind === SyntaxKind.OpenParenToken) valueParen += 1
          else if (valueToken.kind === SyntaxKind.CloseParenToken) valueParen -= 1
        }
        ranges.push({ name, start: valueStart, end: valueEnd })
        index = valueEnd - 1
        continue
      }
    }
    if (token.kind === SyntaxKind.OpenBraceToken) curlyDepth += 1
    else if (token.kind === SyntaxKind.CloseBraceToken) curlyDepth -= 1
    else if (token.kind === SyntaxKind.OpenBracketToken) squareDepth += 1
    else if (token.kind === SyntaxKind.CloseBracketToken) squareDepth -= 1
    else if (token.kind === SyntaxKind.OpenParenToken) parenDepth += 1
    else if (token.kind === SyntaxKind.CloseParenToken) parenDepth -= 1
  }
  return ranges
}

export const candidateDevelopmentGovernedScalars = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  ranges: readonly CandidateDevelopmentTokenRange[],
): ReadonlyMap<number, CandidateDevelopmentGovernedScalar> => {
  const scalars = new Map<number, CandidateDevelopmentGovernedScalar>()
  const parseValue = (
    initialIndex: number,
    end: number,
    metadata: CandidateDevelopmentTokenRange['name'],
    path: readonly string[],
  ): number => {
    let index = initialIndex
    if (tokens[index]?.kind === SyntaxKind.PlusToken || tokens[index]?.kind === SyntaxKind.MinusToken) index += 1
    const token = tokens[index]
    if (token === undefined || index >= end) return initialIndex + 1
    if (token.kind === SyntaxKind.OpenBraceToken) {
      let cursor = index + 1
      while (cursor < end && tokens[cursor]?.kind !== SyntaxKind.CloseBraceToken) {
        const property = candidatePropertyNameAt(tokens, cursor)
        const separator = property === undefined ? undefined : tokens[property.end + 1]
        if (property !== undefined && separator?.kind === SyntaxKind.ColonToken) {
          cursor = parseValue(property.end + 2, end, metadata, [...path, property.name])
        } else cursor += 1
        if (tokens[cursor]?.kind === SyntaxKind.CommaToken) cursor += 1
      }
      return tokens[cursor]?.kind === SyntaxKind.CloseBraceToken ? cursor + 1 : cursor
    }
    if (token.kind === SyntaxKind.OpenBracketToken) {
      let cursor = index + 1
      while (cursor < end && tokens[cursor]?.kind !== SyntaxKind.CloseBracketToken) {
        cursor = parseValue(cursor, end, metadata, [...path, '[]'])
        if (tokens[cursor]?.kind === SyntaxKind.CommaToken) cursor += 1
      }
      return tokens[cursor]?.kind === SyntaxKind.CloseBracketToken ? cursor + 1 : cursor
    }
    if (candidateScalarToken(token) !== undefined) {
      scalars.set(index, { metadata, path })
      return index + 1
    }
    return initialIndex + 1
  }

  for (const range of ranges) parseValue(range.start, range.end, range.name, [range.name])
  return scalars
}

export const candidateDevelopmentImmutableStructuralBindingPaths = new Set([
  'structuralBindings.schemaVersion',
  'structuralBindings.candidateOrdinal',
  'structuralBindings.priorTrialCount',
  'structuralBindings.strategyProtocolHash',
  'structuralBindings.strategyIdentityHash',
  'structuralBindings.candidateDevelopmentProtocolHash',
  'structuralBindings.calendarHash',
  'structuralBindings.priorTrialsHash',
  'structuralBindings.modulePath',
  'structuralBindings.sourceManifestPath',
])

export const candidateDevelopmentImmutableStrategyProtocolPaths = new Set([
  'strategyProtocol.schemaVersion',
  'strategyProtocol.universe.[]',
  'strategyProtocol.directVolatilityTarget',
  'strategyProtocol.initialCapitalMicros',
  'strategyProtocol.executionModel.schemaVersion',
  'strategyProtocol.executionModel.venue',
  'strategyProtocol.executionModel.assetClass',
  'strategyProtocol.executionModel.precision.quantityIncrementMicros',
  'strategyProtocol.executionModel.precision.priceIncrementMicros',
  'strategyProtocol.executionModel.precision.minimumBuyNotionalMicros',
  'strategyProtocol.executionModel.priceImpact.halfSpreadBps',
  'strategyProtocol.executionModel.priceImpact.slippageBps',
  'strategyProtocol.executionModel.fees.scheduleVersion',
  'strategyProtocol.executionModel.fees.commissionBps',
  'strategyProtocol.executionModel.fees.secSellBps',
  'strategyProtocol.executionModel.fees.tafSellPerShareMicros',
  'strategyProtocol.executionModel.fees.tafMaximumPerOrderMicros',
  'strategyProtocol.executionModel.fees.catPerShareMicros',
  'strategyProtocol.executionModel.fees.aggregation',
  'strategyProtocol.executionModel.fees.roundingIncrementMicros',
  'strategyProtocol.executionModel.cash.annualYieldBps',
  'strategyProtocol.executionModel.cash.dayCount',
  'strategyProtocol.executionModel.cash.accrual',
  'strategyProtocol.executionModel.partialFills.policy',
  'strategyProtocol.executionModel.partialFills.probabilityPpm',
  'strategyProtocol.executionModel.partialFills.filledFractionPpm',
  'strategyProtocol.executionModel.partialFills.remainder',
  'strategyProtocol.executionModel.doubleCostMultiplier',
  'strategyProtocol.executionModel.order.type',
  'strategyProtocol.executionModel.order.timeInForce',
  'strategyProtocol.executionModel.order.extendedHours',
  'strategyProtocol.executionModel.order.submitAfter',
  'strategyProtocol.executionModel.order.submitBefore',
  'strategyProtocol.executionModel.order.priceReference',
  'strategyProtocol.executionModel.order.planAfter',
  'strategyProtocol.executionModel.order.planningPriceReference',
  'strategyProtocol.executionModel.order.planningBrokerStateReference',
  'strategyProtocol.executionModel.order.fillPriceReference',
  'strategyProtocol.executionModel.order.buyingPowerPolicy',
  'strategyProtocol.executionModel.order.submissionCutoffLeadMinutes',
  'strategyProtocol.thresholds.minimumObservations',
  'strategyProtocol.thresholds.minimumAnnualizedReturn',
  'strategyProtocol.thresholds.minimumSharpeImprovement',
  'strategyProtocol.thresholds.maximumDrawdown',
  'strategyProtocol.thresholds.maximumAnnualTurnover',
  'strategyProtocol.thresholds.requirePositiveDoubleCostReturn',
  'strategyProtocol.marketData.schemaVersion',
  'strategyProtocol.marketData.snapshotId',
  'strategyProtocol.marketData.contentHash',
  'strategyProtocol.benchmarks.schemaVersion',
  'strategyProtocol.benchmarks.symbol',
  'strategyProtocol.benchmarks.directVolatilityWindow',
  'strategyProtocol.benchmarks.terminalPolicy',
  'strategyProtocol.strategyIdentity.schemaVersion',
  'strategyProtocol.strategyIdentity.parameters.lookbackSessions',
  'strategyProtocol.strategyIdentity.parameters.volatilityWindowSessions',
  'strategyProtocol.strategyIdentity.parameters.annualizationSessions',
  'strategyProtocol.strategyIdentity.parameters.riskAssets.[]',
  'strategyProtocol.strategyIdentity.parameters.defensiveAsset',
  'strategyProtocol.strategyIdentity.parameters.absoluteMomentumThreshold',
  'strategyProtocol.strategyIdentity.parameters.selectedAssetWeight',
  'strategyProtocol.strategyIdentity.parameters.relativeMomentumTieBreak',
  'strategyProtocol.strategyIdentity.parameters.covarianceEstimator',
  'strategyProtocol.strategyIdentity.parameters.targetAnnualizedVolatility',
  'strategyProtocol.strategyIdentity.parameters.maximumGrossExposure',
])

export const candidateDevelopmentPayloadBearingStrategyProtocolPaths = new Set([
  'strategyProtocol.strategyIdentity.family',
  'strategyProtocol.strategyIdentity.identifier',
  'strategyProtocol.strategyIdentity.researchSources.[]',
  'strategyProtocol.strategyIdentity.parameters.id',
  'strategyProtocol.strategyIdentity.input',
  'strategyProtocol.strategyIdentity.relativeMomentum',
  'strategyProtocol.strategyIdentity.absoluteMomentum',
  'strategyProtocol.strategyIdentity.defensive',
  'strategyProtocol.strategyIdentity.weighting',
  'strategyProtocol.strategyIdentity.riskScaling',
  'strategyProtocol.strategyIdentity.allocation',
  'strategyProtocol.strategyIdentity.schedule',
  'strategyProtocol.strategyIdentity.terminal',
  'strategyProtocol.strategyIdentity.missingData',
  'strategyProtocol.strategyIdentity.doubledCost',
])

export const candidateDevelopmentGovernedScalarPath = (scalar: CandidateDevelopmentGovernedScalar): string =>
  scalar.path.join('.')

export const candidateDevelopmentImmutableGovernedScalar = (scalar: CandidateDevelopmentGovernedScalar): boolean => {
  const path = candidateDevelopmentGovernedScalarPath(scalar)
  return scalar.metadata === 'structuralBindings'
    ? candidateDevelopmentImmutableStructuralBindingPaths.has(path)
    : candidateDevelopmentImmutableStrategyProtocolPaths.has(path)
}

export const candidateDevelopmentPayloadBearingGovernedString = (scalar: CandidateDevelopmentGovernedScalar): boolean =>
  scalar.metadata === 'strategyProtocol' &&
  candidateDevelopmentPayloadBearingStrategyProtocolPaths.has(candidateDevelopmentGovernedScalarPath(scalar))

export const candidateDevelopmentJavaScriptKeywordOperators = new Set([
  SyntaxKind.AwaitKeyword,
  SyntaxKind.DeleteKeyword,
  SyntaxKind.InKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.NewKeyword,
  SyntaxKind.TypeOfKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.YieldKeyword,
])

export interface CandidateDevelopmentExecutableSyntaxInspection {
  readonly executablePunctuationCount: number
  readonly executablePunctuationBytes: number
  readonly executableKeywordOperatorCount: number
  readonly executableKeywordOperatorBytes: number
}

export const candidatePunctuationIsImmutableGovernedScalarSign = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  index: number,
  governedScalars: ReadonlyMap<number, CandidateDevelopmentGovernedScalar>,
): boolean => {
  const token = tokens[index]
  if (token?.kind !== SyntaxKind.PlusToken && token?.kind !== SyntaxKind.MinusToken) return false
  const scalarToken = tokens[index + 1]
  const scalar = governedScalars.get(index + 1)
  return (
    scalarToken !== undefined &&
    (scalarToken.kind === SyntaxKind.NumericLiteral || scalarToken.kind === SyntaxKind.BigIntLiteral) &&
    scalar !== undefined &&
    candidateDevelopmentImmutableGovernedScalar(scalar)
  )
}

export const inspectCandidateDevelopmentExecutableSyntax = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  governedScalars: ReadonlyMap<number, CandidateDevelopmentGovernedScalar>,
): CandidateDevelopmentExecutableSyntaxInspection => {
  let executablePunctuationCount = 0
  let executablePunctuationBytes = 0
  let executableKeywordOperatorCount = 0
  let executableKeywordOperatorBytes = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    if (
      token.kind >= SyntaxKind.FirstPunctuation &&
      token.kind <= SyntaxKind.LastPunctuation &&
      !candidatePunctuationIsImmutableGovernedScalarSign(tokens, index, governedScalars)
    ) {
      executablePunctuationCount += 1
      executablePunctuationBytes += Buffer.byteLength(token.text, 'utf8')
    }
    if (
      candidateDevelopmentJavaScriptKeywordOperators.has(token.kind) &&
      candidateExecutableKeywordPropertyToken(tokens, index) === undefined
    ) {
      executableKeywordOperatorCount += 1
      executableKeywordOperatorBytes += Buffer.byteLength(token.text, 'utf8')
    }
  }
  return {
    executablePunctuationCount,
    executablePunctuationBytes,
    executableKeywordOperatorCount,
    executableKeywordOperatorBytes,
  }
}

export interface CandidateDevelopmentExecutableArrayInspection {
  readonly executableArrayCount: number
  readonly largestExecutableArray: number
}

export interface CandidateDevelopmentExecutableArrayFrame {
  readonly openIndex: number
  readonly literalCandidate: boolean
  elementStart: number
  curlyDepth: number
  parenDepth: number
  executableElementCount: number
}

export const candidateArrayElementIsImmutableGovernedScalar = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  start: number,
  end: number,
  governedScalars: ReadonlyMap<number, CandidateDevelopmentGovernedScalar>,
): boolean => {
  if (end - start !== 1) return false
  const token = tokens[start]
  const scalar = governedScalars.get(start)
  return (
    token !== undefined &&
    candidateScalarToken(token) !== undefined &&
    scalar !== undefined &&
    candidateDevelopmentImmutableGovernedScalar(scalar)
  )
}

export const inspectCandidateDevelopmentExecutableArrays = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  governedScalars: ReadonlyMap<number, CandidateDevelopmentGovernedScalar>,
): CandidateDevelopmentExecutableArrayInspection => {
  const frames: CandidateDevelopmentExecutableArrayFrame[] = []
  let executableArrayCount = 0
  let largestExecutableArray = 0
  const countElement = (frame: CandidateDevelopmentExecutableArrayFrame, end: number, commaTerminated: boolean) => {
    if (frame.elementStart === end) {
      if (commaTerminated) frame.executableElementCount += 1
      return
    }
    if (!candidateArrayElementIsImmutableGovernedScalar(tokens, frame.elementStart, end, governedScalars))
      frame.executableElementCount += 1
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    if (token.kind === SyntaxKind.OpenBracketToken) {
      frames.push({
        openIndex: index,
        literalCandidate: candidateRegexLiteralCanStartAfter(tokens[index - 1]?.kind),
        elementStart: index + 1,
        curlyDepth: 0,
        parenDepth: 0,
        executableElementCount: 0,
      })
      continue
    }
    if (token.kind === SyntaxKind.CloseBracketToken) {
      const frame = frames.pop()
      if (frame === undefined) continue
      const computedProperty =
        tokens[index + 1]?.kind === SyntaxKind.ColonToken &&
        (tokens[frame.openIndex - 1]?.kind === SyntaxKind.OpenBraceToken ||
          tokens[frame.openIndex - 1]?.kind === SyntaxKind.CommaToken)
      if (frame.literalCandidate && !computedProperty) {
        countElement(frame, index, false)
        if (frame.executableElementCount > 0) {
          executableArrayCount += 1
          largestExecutableArray = Math.max(largestExecutableArray, frame.executableElementCount)
        }
      }
      continue
    }
    const frame = frames.at(-1)
    if (frame === undefined) continue
    if (token.kind === SyntaxKind.OpenBraceToken) frame.curlyDepth += 1
    else if (token.kind === SyntaxKind.CloseBraceToken) frame.curlyDepth -= 1
    else if (token.kind === SyntaxKind.OpenParenToken) frame.parenDepth += 1
    else if (token.kind === SyntaxKind.CloseParenToken) frame.parenDepth -= 1
    else if (token.kind === SyntaxKind.CommaToken && frame.curlyDepth === 0 && frame.parenDepth === 0) {
      countElement(frame, index, true)
      frame.elementStart = index + 1
    }
  }
  return { executableArrayCount, largestExecutableArray }
}

export interface CandidateDevelopmentParenthesizedArgumentInspection {
  readonly parenthesizedArgumentListCount: number
  readonly parenthesizedArgumentCount: number
  readonly largestParenthesizedArgumentList: number
}

export interface CandidateDevelopmentParenthesizedArgumentFrame {
  readonly argumentListCandidate: boolean
  argumentStart: number
  curlyDepth: number
  squareDepth: number
  argumentCount: number
}

export const candidateParenthesizedArgumentListCanStartAfter = (
  token: CandidateDevelopmentSourceToken | undefined,
): boolean => {
  if (token === undefined) return false
  if (
    token.kind === SyntaxKind.Identifier ||
    token.kind === SyntaxKind.PrivateIdentifier ||
    token.kind === SyntaxKind.CloseParenToken ||
    token.kind === SyntaxKind.CloseBracketToken ||
    token.kind === SyntaxKind.CloseBraceToken ||
    token.kind === SyntaxKind.QuestionDotToken ||
    token.kind === SyntaxKind.ThisKeyword ||
    token.kind === SyntaxKind.SuperKeyword ||
    token.kind === SyntaxKind.ImportKeyword ||
    token.kind === SyntaxKind.NewKeyword ||
    token.kind === SyntaxKind.StringLiteral ||
    token.kind === SyntaxKind.NumericLiteral ||
    token.kind === SyntaxKind.BigIntLiteral ||
    token.kind === SyntaxKind.TrueKeyword ||
    token.kind === SyntaxKind.FalseKeyword ||
    token.kind === SyntaxKind.NullKeyword ||
    token.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
    token.kind === SyntaxKind.TemplateTail ||
    token.kind === SyntaxKind.RegularExpressionLiteral
  )
    return true
  return false
}

export const inspectCandidateDevelopmentParenthesizedArguments = (
  tokens: readonly CandidateDevelopmentSourceToken[],
): CandidateDevelopmentParenthesizedArgumentInspection => {
  const frames: CandidateDevelopmentParenthesizedArgumentFrame[] = []
  let parenthesizedArgumentListCount = 0
  let parenthesizedArgumentCount = 0
  let largestParenthesizedArgumentList = 0
  const countArgument = (frame: CandidateDevelopmentParenthesizedArgumentFrame, end: number) => {
    if (frame.argumentStart < end) frame.argumentCount += 1
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    if (token.kind === SyntaxKind.OpenParenToken) {
      frames.push({
        argumentListCandidate: candidateParenthesizedArgumentListCanStartAfter(tokens[index - 1]),
        argumentStart: index + 1,
        curlyDepth: 0,
        squareDepth: 0,
        argumentCount: 0,
      })
      continue
    }
    if (token.kind === SyntaxKind.CloseParenToken) {
      const frame = frames.pop()
      if (frame === undefined) continue
      const declarationOrArrow =
        tokens[index + 1]?.kind === SyntaxKind.OpenBraceToken ||
        tokens[index + 1]?.kind === SyntaxKind.EqualsGreaterThanToken
      if (frame.argumentListCandidate && !declarationOrArrow) {
        countArgument(frame, index)
        parenthesizedArgumentListCount += 1
        parenthesizedArgumentCount += frame.argumentCount
        largestParenthesizedArgumentList = Math.max(largestParenthesizedArgumentList, frame.argumentCount)
      }
      continue
    }
    const frame = frames.at(-1)
    if (frame === undefined) continue
    if (token.kind === SyntaxKind.OpenBraceToken) frame.curlyDepth += 1
    else if (token.kind === SyntaxKind.CloseBraceToken) frame.curlyDepth -= 1
    else if (token.kind === SyntaxKind.OpenBracketToken) frame.squareDepth += 1
    else if (token.kind === SyntaxKind.CloseBracketToken) frame.squareDepth -= 1
    else if (token.kind === SyntaxKind.CommaToken && frame.curlyDepth === 0 && frame.squareDepth === 0) {
      countArgument(frame, index)
      frame.argumentStart = index + 1
    }
  }
  return {
    parenthesizedArgumentListCount,
    parenthesizedArgumentCount,
    largestParenthesizedArgumentList,
  }
}

export interface CandidateDevelopmentLiteralPayloadInspection {
  readonly frozenDateLiterals: readonly string[]
  readonly governedPayloadDateLiterals: readonly string[]
  readonly regularExpressionLiteralLengths: readonly number[]
  readonly interpolatedTemplateSegmentLengths: readonly number[]
  readonly commentLengths: readonly number[]
  readonly executableCommentCount: number
  readonly executableCommentBytes: number
  readonly longIdentifierLengths: readonly number[]
  readonly encodedIdentifierLengths: readonly number[]
  readonly executableIdentifierCount: number
  readonly executableIdentifierBytes: number
  readonly keywordPropertyNameCount: number
  readonly keywordPropertyNameBytes: number
  readonly executablePunctuationCount: number
  readonly executablePunctuationBytes: number
  readonly executableKeywordOperatorCount: number
  readonly executableKeywordOperatorBytes: number
  readonly executableArrayCount: number
  readonly largestExecutableArray: number
  readonly parenthesizedArgumentListCount: number
  readonly parenthesizedArgumentCount: number
  readonly largestParenthesizedArgumentList: number
  readonly marketObjectFields: readonly (readonly string[])[]
  readonly parallelMarketFields: readonly string[]
  readonly literalArrayCount: number
  readonly largestLiteralArray: number
  readonly largestLiteralObject: number
  readonly longStringLiteralLengths: readonly number[]
  readonly encodedNumericStringLengths: readonly number[]
  readonly encodedBinaryStringLengths: readonly number[]
  readonly outOfRangeImmutableDecimalScalars: readonly {
    readonly path: string
    readonly length: number
    readonly maximumLength: number
    readonly exceedsMaximumValue: boolean
  }[]
  readonly governedPayloadStringCount: number
  readonly governedPayloadStringBytes: number
  readonly executableLiteralCount: number
  readonly executableLiteralBytes: number
}
