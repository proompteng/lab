import { createScanner, LanguageVariant, SyntaxKind } from 'typescript/unstable/ast'

export interface CandidateDevelopmentSourceToken {
  readonly kind: SyntaxKind
  readonly text: string
  readonly value: string
}

export interface CandidateDevelopmentSourceScan {
  readonly tokens: readonly CandidateDevelopmentSourceToken[]
  readonly comments: readonly string[]
}

export const candidateRegexLiteralKeywordPreceders = new Set([
  SyntaxKind.AwaitKeyword,
  SyntaxKind.CaseKeyword,
  SyntaxKind.DeleteKeyword,
  SyntaxKind.DoKeyword,
  SyntaxKind.ElseKeyword,
  SyntaxKind.InKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.NewKeyword,
  SyntaxKind.OfKeyword,
  SyntaxKind.ReturnKeyword,
  SyntaxKind.ThrowKeyword,
  SyntaxKind.TypeOfKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.YieldKeyword,
])

export const candidateRegexLiteralPunctuationPreceders = new Set([
  SyntaxKind.ColonToken,
  SyntaxKind.CommaToken,
  SyntaxKind.EqualsGreaterThanToken,
  SyntaxKind.OpenBraceToken,
  SyntaxKind.OpenBracketToken,
  SyntaxKind.OpenParenToken,
  SyntaxKind.QuestionToken,
  SyntaxKind.SemicolonToken,
])

export const candidateRegexLiteralControlFlowHeaders = new Set([
  SyntaxKind.CatchKeyword,
  SyntaxKind.ForKeyword,
  SyntaxKind.IfKeyword,
  SyntaxKind.SwitchKeyword,
  SyntaxKind.WhileKeyword,
  SyntaxKind.WithKeyword,
])

export const candidateRegexLiteralControlFlowHeaderBeforeOpenParen = (
  tokens: readonly CandidateDevelopmentSourceToken[],
): boolean => {
  const previousToken = tokens.at(-1)
  const precedingToken = tokens.at(-2)
  const propertyAccess =
    precedingToken?.kind === SyntaxKind.DotToken || precedingToken?.kind === SyntaxKind.QuestionDotToken
  if (candidateRegexLiteralControlFlowHeaders.has(previousToken?.kind ?? SyntaxKind.Unknown)) return !propertyAccess
  return (
    previousToken?.kind === SyntaxKind.AwaitKeyword &&
    precedingToken?.kind === SyntaxKind.ForKeyword &&
    tokens.at(-3)?.kind !== SyntaxKind.DotToken &&
    tokens.at(-3)?.kind !== SyntaxKind.QuestionDotToken
  )
}

export const candidateRegexLiteralCanStartAfter = (kind: SyntaxKind | undefined): boolean =>
  kind === undefined ||
  candidateRegexLiteralKeywordPreceders.has(kind) ||
  candidateRegexLiteralPunctuationPreceders.has(kind) ||
  (kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment) ||
  (kind >= SyntaxKind.FirstBinaryOperator &&
    kind <= SyntaxKind.QuestionQuestionToken &&
    kind !== SyntaxKind.PlusPlusToken &&
    kind !== SyntaxKind.MinusMinusToken)

export const candidateCommentBody = (kind: SyntaxKind, text: string): string =>
  kind === SyntaxKind.SingleLineCommentTrivia ? text.slice(2) : text.slice(2, -2)

export const scanCandidateDevelopmentSource = (source: string): CandidateDevelopmentSourceScan => {
  const scanner = createScanner(false, LanguageVariant.Standard, source)
  const tokens: CandidateDevelopmentSourceToken[] = []
  const comments: string[] = []
  const templateSubstitutionBraceDepths: number[] = []
  const controlFlowHeaderParens: boolean[] = []
  let controlFlowHeaderClosed = false
  let previousKind: SyntaxKind | undefined
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.SingleLineCommentTrivia || kind === SyntaxKind.MultiLineCommentTrivia) {
      comments.push(candidateCommentBody(kind, scanner.getTokenText()))
      continue
    }
    if (
      kind === SyntaxKind.WhitespaceTrivia ||
      kind === SyntaxKind.NewLineTrivia ||
      kind === SyntaxKind.NonTextFileMarkerTrivia ||
      kind === SyntaxKind.ConflictMarkerTrivia
    )
      continue
    const regexCanStartAfterControlFlowHeader = controlFlowHeaderClosed
    controlFlowHeaderClosed = false
    if (
      kind === SyntaxKind.SlashToken &&
      (candidateRegexLiteralCanStartAfter(previousKind) || regexCanStartAfterControlFlowHeader)
    ) {
      kind = scanner.reScanSlashToken()
    }
    const templateBraceDepth = templateSubstitutionBraceDepths.at(-1)
    if (kind === SyntaxKind.CloseBraceToken && templateBraceDepth === 0) {
      kind = scanner.reScanTemplateToken(false)
      if (kind === SyntaxKind.TemplateTail) templateSubstitutionBraceDepths.pop()
    } else {
      if (templateBraceDepth !== undefined) {
        if (kind === SyntaxKind.OpenBraceToken) {
          templateSubstitutionBraceDepths[templateSubstitutionBraceDepths.length - 1] = templateBraceDepth + 1
        } else if (kind === SyntaxKind.CloseBraceToken) {
          templateSubstitutionBraceDepths[templateSubstitutionBraceDepths.length - 1] = templateBraceDepth - 1
        }
      }
      if (kind === SyntaxKind.TemplateHead) templateSubstitutionBraceDepths.push(0)
    }
    if (kind === SyntaxKind.OpenParenToken) {
      controlFlowHeaderParens.push(candidateRegexLiteralControlFlowHeaderBeforeOpenParen(tokens))
    } else if (kind === SyntaxKind.CloseParenToken) {
      controlFlowHeaderClosed = controlFlowHeaderParens.pop() === true
    }
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() })
    previousKind = kind
  }
  return { tokens, comments }
}

export const candidateDevelopmentParserRegularExpressions = (source: string): readonly string[] => {
  let normalized: string
  try {
    normalized = new Bun.Transpiler({ loader: 'js' }).transformSync(source)
  } catch {
    return []
  }
  const scanner = createScanner(false, LanguageVariant.Standard, normalized)
  const expressions: string[] = []
  let previousKind: SyntaxKind | undefined
  let lineStart = true
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.NewLineTrivia) {
      lineStart = true
      continue
    }
    if (
      kind === SyntaxKind.WhitespaceTrivia ||
      kind === SyntaxKind.SingleLineCommentTrivia ||
      kind === SyntaxKind.MultiLineCommentTrivia ||
      kind === SyntaxKind.NonTextFileMarkerTrivia ||
      kind === SyntaxKind.ConflictMarkerTrivia
    ) {
      if (scanner.getTokenText().includes('\n')) lineStart = true
      continue
    }
    if (kind === SyntaxKind.SlashToken && (lineStart || candidateRegexLiteralCanStartAfter(previousKind))) {
      kind = scanner.reScanSlashToken()
    }
    if (kind === SyntaxKind.RegularExpressionLiteral) {
      expressions.push(candidateRegularExpressionBody(scanner.getTokenText()))
    }
    lineStart = false
    previousKind = kind
  }
  return expressions
}

export const candidateIdentifierNameToken = (token: CandidateDevelopmentSourceToken | undefined): string | undefined =>
  token !== undefined &&
  (token.kind === SyntaxKind.Identifier ||
    (token.kind >= SyntaxKind.FirstKeyword && token.kind <= SyntaxKind.LastKeyword))
    ? token.value
    : undefined

export const candidateTokenName = (token: CandidateDevelopmentSourceToken | undefined): string | undefined =>
  token?.kind === SyntaxKind.StringLiteral ? token.value : candidateIdentifierNameToken(token)

export const candidatePropertyNameAt = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  index: number,
): { readonly name: string; readonly end: number } | undefined => {
  const direct = candidateTokenName(tokens[index])
  if (direct !== undefined) return { name: direct, end: index }
  if (
    tokens[index]?.kind === SyntaxKind.OpenBracketToken &&
    tokens[index + 1]?.kind === SyntaxKind.StringLiteral &&
    tokens[index + 2]?.kind === SyntaxKind.CloseBracketToken
  )
    return { name: tokens[index + 1]?.value ?? '', end: index + 2 }
  return undefined
}

export const candidatePropertyNameBefore = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  separatorIndex: number,
): string | undefined => {
  const direct = candidateTokenName(tokens[separatorIndex - 1])
  if (direct !== undefined) return direct
  if (
    tokens[separatorIndex - 1]?.kind === SyntaxKind.CloseBracketToken &&
    tokens[separatorIndex - 2]?.kind === SyntaxKind.StringLiteral &&
    tokens[separatorIndex - 3]?.kind === SyntaxKind.OpenBracketToken
  )
    return tokens[separatorIndex - 2]?.value
  return undefined
}

export const candidateRegularExpressionBody = (text: string): string => {
  let escaped = false
  let characterClass = false
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '[') characterClass = true
    else if (character === ']') characterClass = false
    else if (character === '/' && !characterClass) return text.slice(1, index)
  }
  return text
}

export const candidateExecutableStringToken = (token: CandidateDevelopmentSourceToken): string | undefined => {
  if (
    token.kind === SyntaxKind.StringLiteral ||
    token.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
    token.kind === SyntaxKind.TemplateHead ||
    token.kind === SyntaxKind.TemplateMiddle ||
    token.kind === SyntaxKind.TemplateTail
  )
    return token.value
  if (token.kind === SyntaxKind.RegularExpressionLiteral) return candidateRegularExpressionBody(token.text)
  return undefined
}

export const candidateScalarToken = (token: CandidateDevelopmentSourceToken): string | undefined => {
  const executableString = candidateExecutableStringToken(token)
  if (executableString !== undefined) return executableString
  if (token.kind === SyntaxKind.NumericLiteral || token.kind === SyntaxKind.BigIntLiteral) return token.value
  if (token.kind === SyntaxKind.TrueKeyword) return 'true'
  if (token.kind === SyntaxKind.FalseKeyword) return 'false'
  if (token.kind === SyntaxKind.NullKeyword) return 'null'
  return undefined
}

export const candidateExecutableIdentifierToken = (token: CandidateDevelopmentSourceToken): string | undefined =>
  token.kind === SyntaxKind.Identifier || token.kind === SyntaxKind.PrivateIdentifier ? token.value : undefined

export const candidateExecutableKeywordPropertyToken = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  index: number,
): string | undefined => {
  const token = tokens[index]
  if (token === undefined || token.kind < SyntaxKind.FirstKeyword || token.kind > SyntaxKind.LastKeyword)
    return undefined
  const previousKind = tokens[index - 1]?.kind
  const nextKind = tokens[index + 1]?.kind
  if (
    nextKind === SyntaxKind.ColonToken ||
    nextKind === SyntaxKind.OpenParenToken ||
    nextKind === SyntaxKind.EqualsToken ||
    previousKind === SyntaxKind.DotToken ||
    previousKind === SyntaxKind.QuestionDotToken ||
    ((previousKind === SyntaxKind.OpenBraceToken ||
      previousKind === SyntaxKind.CommaToken ||
      previousKind === SyntaxKind.SemicolonToken) &&
      (nextKind === SyntaxKind.CommaToken ||
        nextKind === SyntaxKind.CloseBraceToken ||
        nextKind === SyntaxKind.SemicolonToken))
  )
    return token.value
  return undefined
}
