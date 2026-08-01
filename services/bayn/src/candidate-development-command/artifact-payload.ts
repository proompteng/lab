import { SyntaxKind } from 'typescript/unstable/ast'
import { candidateMarketPayloadField } from './artifact-identifiers'
import {
  candidateDevelopmentParserRegularExpressions,
  candidateExecutableIdentifierToken,
  candidateExecutableKeywordPropertyToken,
  candidateExecutableStringToken,
  candidatePropertyNameAt,
  candidatePropertyNameBefore,
  candidateRegularExpressionBody,
  candidateScalarToken,
  scanCandidateDevelopmentSource,
} from './artifact-scanner'
import {
  candidateDevelopmentGovernedMetadataRanges,
  candidateDevelopmentGovernedScalarPath,
  candidateDevelopmentGovernedScalars,
  candidateDevelopmentImmutableGovernedScalar,
  candidateDevelopmentPayloadBearingGovernedString,
  inspectCandidateDevelopmentExecutableArrays,
  inspectCandidateDevelopmentExecutableSyntax,
  inspectCandidateDevelopmentParenthesizedArguments,
  type CandidateDevelopmentLiteralPayloadInspection,
  type CandidateDevelopmentTokenRange,
} from './artifact-structure'

export const candidateDevelopmentMaximumImmutableDecimal = '340282366920938463463374607431768211455'

export const inspectCandidateDevelopmentLiteralPayload = (
  source: string,
  _modulePath: string,
): CandidateDevelopmentLiteralPayloadInspection => {
  const { comments, tokens } = scanCandidateDevelopmentSource(source)
  const rawRegularExpressionCounts = new Map<string, number>()
  for (const token of tokens) {
    if (token.kind !== SyntaxKind.RegularExpressionLiteral) continue
    const body = candidateRegularExpressionBody(token.text)
    rawRegularExpressionCounts.set(body, (rawRegularExpressionCounts.get(body) ?? 0) + 1)
  }
  const parserOnlyRegularExpressions: string[] = []
  for (const body of candidateDevelopmentParserRegularExpressions(source)) {
    const rawCount = rawRegularExpressionCounts.get(body) ?? 0
    if (rawCount > 0) rawRegularExpressionCounts.set(body, rawCount - 1)
    else parserOnlyRegularExpressions.push(body)
  }
  const governedRanges = candidateDevelopmentGovernedMetadataRanges(tokens)
  const governedScalars = candidateDevelopmentGovernedScalars(tokens, governedRanges)
  const executableSyntax = inspectCandidateDevelopmentExecutableSyntax(tokens, governedScalars)
  const executableArrays = inspectCandidateDevelopmentExecutableArrays(tokens, governedScalars)
  const parenthesizedArguments = inspectCandidateDevelopmentParenthesizedArguments(tokens)
  const frozenDateLiterals: string[] = []
  const governedPayloadDateLiterals: string[] = []
  const regularExpressionLiteralLengths: number[] = []
  const interpolatedTemplateSegmentLengths: number[] = []
  const commentLengths: number[] = []
  const longIdentifierLengths: number[] = []
  const encodedIdentifierLengths: number[] = []
  const marketObjectFields: string[][] = []
  const parallelMarketFields = new Set<string>()
  const longStringLiteralLengths: number[] = []
  const encodedNumericStringLengths: number[] = []
  const encodedBinaryStringLengths: number[] = []
  const outOfRangeImmutableDecimalScalars: {
    readonly path: string
    readonly length: number
    readonly maximumLength: number
    readonly exceedsMaximumValue: boolean
  }[] = []
  let literalArrayCount = 0
  let largestLiteralArray = 0
  let largestLiteralObject = 0
  let governedPayloadStringCount = 0
  let governedPayloadStringBytes = 0
  let executableCommentCount = 0
  let executableCommentBytes = 0
  let executableIdentifierCount = 0
  let executableIdentifierBytes = 0
  let keywordPropertyNameCount = 0
  let keywordPropertyNameBytes = 0
  let executableLiteralCount = 0
  let executableLiteralBytes = 0
  const objects: { readonly fields: Set<string>; numericLiteralCount: number }[] = []
  const arrays: { literalCount: number }[] = []
  const governedRangeAt = (index: number): CandidateDevelopmentTokenRange | undefined =>
    governedRanges.find((range) => index >= range.start && index < range.end)

  for (const comment of comments) {
    const commentBytes = Buffer.byteLength(comment, 'utf8')
    commentLengths.push(comment.length)
    executableCommentCount += 1
    executableCommentBytes += commentBytes
    executableLiteralCount += 1
    executableLiteralBytes += commentBytes
    frozenDateLiterals.push(...(comment.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []))
    if (comment.length > 128) longStringLiteralLengths.push(comment.length)
    const numericTokens = comment.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/gu) ?? []
    const delimiters = comment.match(/[,|;\t\n]/gu) ?? []
    if (comment.length >= 24 && numericTokens.length >= 6 && delimiters.length >= 5)
      encodedNumericStringLengths.push(comment.length)
    if (
      comment.length >= 96 &&
      (/^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(comment) ||
        /^[a-f0-9]+$/u.test(comment))
    )
      encodedBinaryStringLengths.push(comment.length)
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    const governedRange = governedRangeAt(index)
    const governedScalar = governedScalars.get(index)
    const regularExpressionLiteral = token.kind === SyntaxKind.RegularExpressionLiteral
    const interpolatedTemplateSegment =
      token.kind === SyntaxKind.TemplateHead ||
      token.kind === SyntaxKind.TemplateMiddle ||
      token.kind === SyntaxKind.TemplateTail
    const dynamicExecutableString = regularExpressionLiteral || interpolatedTemplateSegment
    const immutableGovernedScalar =
      !dynamicExecutableString &&
      governedScalar !== undefined &&
      candidateDevelopmentImmutableGovernedScalar(governedScalar)
    const payloadBearingGovernedString =
      governedScalar !== undefined && candidateDevelopmentPayloadBearingGovernedString(governedScalar)
    const executableString = candidateExecutableStringToken(token)

    const keywordPropertyName = candidateExecutableKeywordPropertyToken(tokens, index)
    const executableIdentifier = candidateExecutableIdentifierToken(token) ?? keywordPropertyName
    if (executableIdentifier !== undefined) {
      const identifier = executableIdentifier
      const identifierBytes = Buffer.byteLength(identifier, 'utf8')
      if (keywordPropertyName !== undefined) {
        keywordPropertyNameCount += 1
        keywordPropertyNameBytes += identifierBytes
      }
      if (identifier.length > 128) longIdentifierLengths.push(identifier.length)
      if (identifier.length >= 96) encodedIdentifierLengths.push(identifier.length)
      executableIdentifierCount += 1
      executableIdentifierBytes += identifierBytes
      executableLiteralCount += 1
      executableLiteralBytes += identifierBytes
    }

    if (
      executableString !== undefined &&
      (dynamicExecutableString || governedRange === undefined || governedScalar !== undefined)
    ) {
      const value = executableString
      if (
        immutableGovernedScalar &&
        governedScalar !== undefined &&
        /^\d+$/u.test(value) &&
        (value.length > candidateDevelopmentMaximumImmutableDecimal.length ||
          (value.length === candidateDevelopmentMaximumImmutableDecimal.length &&
            value > candidateDevelopmentMaximumImmutableDecimal))
      ) {
        outOfRangeImmutableDecimalScalars.push({
          path: candidateDevelopmentGovernedScalarPath(governedScalar),
          length: value.length,
          maximumLength: candidateDevelopmentMaximumImmutableDecimal.length,
          exceedsMaximumValue: true,
        })
      }
      if (regularExpressionLiteral) regularExpressionLiteralLengths.push(value.length)
      if (interpolatedTemplateSegment) interpolatedTemplateSegmentLengths.push(value.length)
      if (payloadBearingGovernedString) {
        const dates = value.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []
        governedPayloadDateLiterals.push(...dates)
        governedPayloadStringCount += 1
        governedPayloadStringBytes += Buffer.byteLength(value, 'utf8')
      } else if (!immutableGovernedScalar) {
        const dates = value.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []
        frozenDateLiterals.push(...dates)
      }
      if (!immutableGovernedScalar) {
        if (value.length > 128) longStringLiteralLengths.push(value.length)
        const numericTokens = value.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/gu) ?? []
        const delimiters = value.match(/[,|;\t\n]/gu) ?? []
        if (value.length >= 24 && numericTokens.length >= 6 && delimiters.length >= 5)
          encodedNumericStringLengths.push(value.length)
        if (
          value.length >= 96 &&
          (/^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value) ||
            /^[a-f0-9]+$/u.test(value))
        )
          encodedBinaryStringLengths.push(value.length)
      }
      if (
        dynamicExecutableString ||
        governedRange === undefined ||
        (!immutableGovernedScalar && !payloadBearingGovernedString)
      ) {
        executableLiteralCount += 1
        executableLiteralBytes += Buffer.byteLength(value, 'utf8')
      }
    } else if (executableString === undefined && (governedRange === undefined || !immutableGovernedScalar)) {
      const literal = candidateScalarToken(token)
      if (literal !== undefined) {
        executableLiteralCount += 1
        executableLiteralBytes += Buffer.byteLength(literal, 'utf8')
      }
    }

    if (token.kind === SyntaxKind.OpenBraceToken) objects.push({ fields: new Set(), numericLiteralCount: 0 })
    else if (token.kind === SyntaxKind.CloseBraceToken) {
      const object = objects.pop()
      if (object !== undefined) {
        const priceFieldCount = ['open', 'high', 'low', 'close', 'volume'].filter((field) =>
          object.fields.has(field),
        ).length
        if ((object.fields.has('sessionDate') && priceFieldCount >= 3) || priceFieldCount === 5)
          marketObjectFields.push([...object.fields].sort())
        largestLiteralObject = Math.max(largestLiteralObject, object.numericLiteralCount)
      }
    }

    const property = candidatePropertyNameAt(tokens, index)
    if (property !== undefined && tokens[property.end + 1]?.kind === SyntaxKind.ColonToken) {
      const field = candidateMarketPayloadField(property.name)
      if (field !== undefined) objects.at(-1)?.fields.add(field)
    }
    if (token.kind === SyntaxKind.ColonToken || token.kind === SyntaxKind.EqualsToken) {
      const name = candidatePropertyNameBefore(tokens, index)
      const field = name === undefined ? undefined : candidateMarketPayloadField(name)
      if (field !== undefined) parallelMarketFields.add(field)
    }
    if (
      (token.kind === SyntaxKind.NumericLiteral || token.kind === SyntaxKind.BigIntLiteral) &&
      tokens[index + 1]?.kind !== SyntaxKind.ColonToken &&
      !immutableGovernedScalar
    ) {
      const object = objects.at(-1)
      if (object !== undefined) object.numericLiteralCount += 1
    }

    if (token.kind === SyntaxKind.OpenBracketToken) {
      arrays.push({ literalCount: 0 })
    } else if (token.kind === SyntaxKind.CloseBracketToken) {
      const array = arrays.pop()
      if (array !== undefined && array.literalCount > 0) {
        literalArrayCount += 1
        largestLiteralArray = Math.max(largestLiteralArray, array.literalCount)
      }
    } else if (
      arrays.length > 0 &&
      candidateScalarToken(token) !== undefined &&
      (governedRange === undefined || governedScalar !== undefined) &&
      !immutableGovernedScalar
    ) {
      const array = arrays.at(-1)
      if (array !== undefined) array.literalCount += 1
    }
  }

  for (const value of parserOnlyRegularExpressions) {
    regularExpressionLiteralLengths.push(value.length)
    frozenDateLiterals.push(...(value.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []))
    if (value.length > 128) longStringLiteralLengths.push(value.length)
    const numericTokens = value.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/gu) ?? []
    const delimiters = value.match(/[,|;\t\n]/gu) ?? []
    if (value.length >= 24 && numericTokens.length >= 6 && delimiters.length >= 5)
      encodedNumericStringLengths.push(value.length)
    if (
      value.length >= 96 &&
      (/^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value) || /^[a-f0-9]+$/u.test(value))
    )
      encodedBinaryStringLengths.push(value.length)
    executableLiteralCount += 1
    executableLiteralBytes += Buffer.byteLength(value, 'utf8')
  }

  return {
    frozenDateLiterals,
    governedPayloadDateLiterals,
    regularExpressionLiteralLengths,
    interpolatedTemplateSegmentLengths,
    commentLengths,
    executableCommentCount,
    executableCommentBytes,
    longIdentifierLengths,
    encodedIdentifierLengths,
    executableIdentifierCount,
    executableIdentifierBytes,
    keywordPropertyNameCount,
    keywordPropertyNameBytes,
    executablePunctuationCount: executableSyntax.executablePunctuationCount,
    executablePunctuationBytes: executableSyntax.executablePunctuationBytes,
    executableKeywordOperatorCount: executableSyntax.executableKeywordOperatorCount,
    executableKeywordOperatorBytes: executableSyntax.executableKeywordOperatorBytes,
    executableArrayCount: executableArrays.executableArrayCount,
    largestExecutableArray: executableArrays.largestExecutableArray,
    parenthesizedArgumentListCount: parenthesizedArguments.parenthesizedArgumentListCount,
    parenthesizedArgumentCount: parenthesizedArguments.parenthesizedArgumentCount,
    largestParenthesizedArgumentList: parenthesizedArguments.largestParenthesizedArgumentList,
    marketObjectFields,
    parallelMarketFields: [...parallelMarketFields].sort(),
    literalArrayCount,
    largestLiteralArray,
    largestLiteralObject,
    longStringLiteralLengths,
    encodedNumericStringLengths,
    encodedBinaryStringLengths,
    outOfRangeImmutableDecimalScalars,
    governedPayloadStringCount,
    governedPayloadStringBytes,
    executableLiteralCount,
    executableLiteralBytes,
  }
}
