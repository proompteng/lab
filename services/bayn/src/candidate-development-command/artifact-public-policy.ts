import { relative, sep } from 'node:path'

import { Result } from 'effect'

import type { CandidateDevelopmentCommandFailure } from './contracts'
import { sourceVerificationFailure } from './evaluation'
import { candidateArtifactDowncompiledHelpers, candidateArtifactIdentifierIssues } from './artifact-identifiers'
import { inspectCandidateDevelopmentLiteralPayload } from './artifact-payload'

export const validateCandidateDevelopmentModuleSource = (
  source: string,
  modulePath: string,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const byteCount = Buffer.byteLength(source, 'utf8')
  const lineCount = source.length === 0 ? 0 : source.split('\n').length
  const generatedHelpers = candidateArtifactDowncompiledHelpers.filter((helper) =>
    new RegExp(`(?:\\b(?:const|function|let|var)\\s+${helper}\\b|\\b${helper}\\s*=)`, 'u').test(source),
  )
  const literalPayload = inspectCandidateDevelopmentLiteralPayload(source, modulePath)
  const parallelPriceFieldCount = ['open', 'high', 'low', 'close', 'volume'].filter((field) =>
    literalPayload.parallelMarketFields.includes(field),
  ).length
  const issues = {
    typeCheckDisabled: /^\s*\/\/\s*@ts-nocheck\b/mu.test(source),
    oversized: byteCount > 262_144 || lineCount > 4_096,
    generatedHelpers,
    embeddedFrozenSessions: literalPayload.frozenDateLiterals.length > 0,
    embeddedMarketBars:
      literalPayload.marketObjectFields.length > 0 ||
      (literalPayload.parallelMarketFields.includes('sessionDate') && parallelPriceFieldCount >= 3) ||
      parallelPriceFieldCount === 5 ||
      literalPayload.literalArrayCount >= 3 ||
      literalPayload.largestLiteralArray >= 4 ||
      literalPayload.executableArrayCount >= 3 ||
      literalPayload.largestExecutableArray >= 4 ||
      literalPayload.largestLiteralObject >= 5 ||
      literalPayload.longStringLiteralLengths.length > 0 ||
      literalPayload.longIdentifierLengths.length > 0 ||
      literalPayload.encodedIdentifierLengths.length > 0 ||
      literalPayload.executablePunctuationCount > 512 ||
      literalPayload.executablePunctuationBytes > 1_024 ||
      literalPayload.executableKeywordOperatorCount > 32 ||
      literalPayload.executableKeywordOperatorBytes > 192 ||
      literalPayload.parenthesizedArgumentCount > 64 ||
      literalPayload.largestParenthesizedArgumentList > 32 ||
      literalPayload.encodedNumericStringLengths.length > 0 ||
      literalPayload.encodedBinaryStringLengths.length > 0 ||
      literalPayload.outOfRangeImmutableDecimalScalars.length > 0 ||
      literalPayload.governedPayloadDateLiterals.length >= 4 ||
      literalPayload.governedPayloadStringBytes > 1_024 ||
      literalPayload.executableLiteralCount > 64 ||
      literalPayload.executableLiteralBytes > 1_024,
  }
  return !issues.typeCheckDisabled &&
    !issues.oversized &&
    issues.generatedHelpers.length === 0 &&
    !issues.embeddedFrozenSessions &&
    !issues.embeddedMarketBars
    ? Result.succeed(undefined)
    : Result.fail(
        sourceVerificationFailure('verify-module-format', {
          modulePath,
          byteCount,
          lineCount,
          maximumByteCount: 262_144,
          maximumLineCount: 4_096,
          literalPayload,
          ...issues,
        }),
      )
}

export const verifySelfContainedEsm = (
  source: string,
  modulePath: string,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  try {
    const transpiler = new Bun.Transpiler({ loader: 'js' })
    const imports = transpiler.scanImports(source)
    const normalized = transpiler.transformSync(source)
    const identifiers = candidateArtifactIdentifierIssues(normalized)
    return imports.length === 0 && identifiers.length === 0
      ? Result.succeed(undefined)
      : Result.fail(sourceVerificationFailure('verify-module-format', { modulePath, imports, identifiers }))
  } catch (cause) {
    return Result.fail(sourceVerificationFailure('verify-module-format', { modulePath, cause }))
  }
}

export const repositoryRelativePath = (
  repositoryRoot: string,
  absolutePath: string,
): Result.Result<string, CandidateDevelopmentCommandFailure> => {
  const path = relative(repositoryRoot, absolutePath)
  return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`)
    ? Result.succeed(path.split(sep).join('/'))
    : Result.fail(
        sourceVerificationFailure('verify-source-paths', {
          repositoryRoot,
          absolutePath,
        }),
      )
}
