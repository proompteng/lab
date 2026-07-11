import { SyntaxKind } from 'typescript/unstable/ast'
import { computeLineStarts, createScanner, tokenIsIdentifierOrKeyword } from 'typescript/unstable/ast/scanner'

export type WorkflowSyntaxToken = {
  readonly kind: SyntaxKind
  readonly text: string
  readonly value: string
  readonly start: number
  readonly end: number
  readonly hasPrecedingLineBreak: boolean
}

export type WorkflowModuleSpecifier = {
  readonly specifier: string
  readonly start: number
  readonly end: number
}

export type WorkflowPosition = {
  readonly line: number
  readonly column: number
}

export const scanWorkflowSyntaxTokens = (sourceText: string): WorkflowSyntaxToken[] => {
  const scanner = createScanner(true, undefined, sourceText)
  const tokens: WorkflowSyntaxToken[] = []

  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    tokens.push({
      kind,
      text: scanner.getTokenText(),
      value: scanner.getTokenValue(),
      start: scanner.getTokenStart(),
      end: scanner.getTokenEnd(),
      hasPrecedingLineBreak: scanner.hasPrecedingLineBreak(),
    })
  }

  return tokens
}

export const createWorkflowPositionResolver = (sourceText: string): ((position: number) => WorkflowPosition) => {
  const lineStarts = computeLineStarts(sourceText)

  return (position: number) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const start = lineStarts[mid] ?? 0
      const next = lineStarts[mid + 1] ?? Number.POSITIVE_INFINITY
      if (position < start) {
        high = mid - 1
      } else if (position >= next) {
        low = mid + 1
      } else {
        return { line: mid + 1, column: position - start + 1 }
      }
    }

    return { line: 1, column: position + 1 }
  }
}

export const isIdentifierLikeToken = (token: WorkflowSyntaxToken | undefined): token is WorkflowSyntaxToken =>
  token != null && tokenIsIdentifierOrKeyword(token.kind)

const isStringLiteral = (token: WorkflowSyntaxToken | undefined): token is WorkflowSyntaxToken =>
  token?.kind === SyntaxKind.StringLiteral

const isStatementBoundary = (token: WorkflowSyntaxToken | undefined): boolean =>
  token == null ||
  token.kind === SyntaxKind.SemicolonToken ||
  token.kind === SyntaxKind.OpenBraceToken ||
  token.kind === SyntaxKind.CloseBraceToken

const isModuleSpecifierSearchBoundary = (token: WorkflowSyntaxToken | undefined): boolean =>
  token == null || token.kind === SyntaxKind.SemicolonToken

const findStatementStartIndex = (
  tokens: readonly WorkflowSyntaxToken[],
  index: number,
  options: { readonly lineBreaksAreBoundaries: boolean } = { lineBreaksAreBoundaries: true },
): number => {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (
      (options.lineBreaksAreBoundaries && tokens[cursor + 1]?.hasPrecedingLineBreak) ||
      isStatementBoundary(tokens[cursor])
    ) {
      return cursor + 1
    }
  }

  return 0
}

const hasTypeAliasPrefix = (
  tokens: readonly WorkflowSyntaxToken[],
  statementStart: number,
  importIndex: number,
): boolean => {
  const first = tokens[statementStart]
  const second = tokens[statementStart + 1]
  const typeIndex =
    first?.kind === SyntaxKind.TypeKeyword
      ? statementStart
      : first?.kind === SyntaxKind.ExportKeyword && second?.kind === SyntaxKind.TypeKeyword
        ? statementStart + 1
        : -1
  if (typeIndex < 0 || typeIndex >= importIndex) return false

  let hasEquals = false
  for (let index = typeIndex + 1; index < importIndex; index += 1) {
    const kind = tokens[index]?.kind
    if (kind === SyntaxKind.EqualsToken) hasEquals = true
    if (kind === SyntaxKind.ConstKeyword || kind === SyntaxKind.LetKeyword || kind === SyntaxKind.VarKeyword)
      return false
  }

  return hasEquals
}

const hasTypeContextBeforeOpenBrace = (tokens: readonly WorkflowSyntaxToken[], statementStart: number): boolean => {
  const openBraceIndex = statementStart - 1
  if (tokens[openBraceIndex]?.kind !== SyntaxKind.OpenBraceToken) return true

  const beforeOpenBrace = tokens[openBraceIndex - 1]
  if (beforeOpenBrace?.kind === SyntaxKind.ColonToken) {
    for (let index = openBraceIndex - 2; index >= 0; index -= 1) {
      const kind = tokens[index]?.kind
      if (tokens[index + 1]?.hasPrecedingLineBreak) return false
      if (
        kind === SyntaxKind.SemicolonToken ||
        kind === SyntaxKind.OpenBraceToken ||
        kind === SyntaxKind.CloseBraceToken
      )
        return false
      if (kind === SyntaxKind.ReturnKeyword || kind === SyntaxKind.EqualsToken || kind === SyntaxKind.CommaToken)
        return false
      if (kind === SyntaxKind.ConstKeyword || kind === SyntaxKind.LetKeyword || kind === SyntaxKind.VarKeyword)
        return true
      if (kind === SyntaxKind.FunctionKeyword || kind === SyntaxKind.CloseParenToken) return true
    }

    return false
  }

  for (let index = openBraceIndex - 1; index >= 0; index -= 1) {
    const kind = tokens[index]?.kind
    if (tokens[index + 1]?.hasPrecedingLineBreak) return false
    if (kind === SyntaxKind.SemicolonToken || kind === SyntaxKind.OpenBraceToken || kind === SyntaxKind.CloseBraceToken)
      return false
    if (kind === SyntaxKind.TypeKeyword || kind === SyntaxKind.InterfaceKeyword || kind === SyntaxKind.ClassKeyword)
      return true
    if (kind === SyntaxKind.ReturnKeyword) return false
  }

  return false
}

const hasTypeAnnotationBefore = (
  tokens: readonly WorkflowSyntaxToken[],
  statementStart: number,
  importIndex: number,
): boolean => {
  let colonIndex = -1
  let runtimeBoundaryIndex = statementStart - 1
  let hasTernaryQuestionAfterRuntimeBoundary = false
  for (let index = statementStart; index < importIndex; index += 1) {
    const kind = tokens[index]?.kind
    if (kind === SyntaxKind.QuestionToken && index > runtimeBoundaryIndex) hasTernaryQuestionAfterRuntimeBoundary = true
    if (kind === SyntaxKind.ColonToken) colonIndex = index
    if (kind === SyntaxKind.EqualsToken || kind === SyntaxKind.EqualsGreaterThanToken) {
      runtimeBoundaryIndex = index
      hasTernaryQuestionAfterRuntimeBoundary = false
    }
  }

  return (
    colonIndex > runtimeBoundaryIndex &&
    !hasTernaryQuestionAfterRuntimeBoundary &&
    hasTypeContextBeforeOpenBrace(tokens, statementStart)
  )
}

const tokenIsCallableTypeArgumentTarget = (token: WorkflowSyntaxToken): boolean =>
  tokenIsIdentifierOrKeyword(token.kind) || token.kind === SyntaxKind.CloseParenToken

const tokenStartsTypeParameterList = (tokens: readonly WorkflowSyntaxToken[], lessThanIndex: number): boolean => {
  const beforeLessThan = tokens[lessThanIndex - 1]
  if (!beforeLessThan || !tokenIsIdentifierOrKeyword(beforeLessThan.kind)) return false

  for (let index = lessThanIndex - 2; index >= 0; index -= 1) {
    const token = tokens[index]
    const kind = token?.kind
    if (tokens[index + 1]?.hasPrecedingLineBreak) return false
    if (
      kind === SyntaxKind.TypeKeyword ||
      kind === SyntaxKind.InterfaceKeyword ||
      kind === SyntaxKind.ClassKeyword ||
      kind === SyntaxKind.FunctionKeyword
    )
      return true
    if (
      kind === SyntaxKind.SemicolonToken ||
      kind === SyntaxKind.OpenBraceToken ||
      kind === SyntaxKind.CloseBraceToken ||
      kind === SyntaxKind.EqualsToken ||
      kind === SyntaxKind.ReturnKeyword ||
      kind === SyntaxKind.OpenParenToken ||
      kind === SyntaxKind.CloseParenToken ||
      kind === SyntaxKind.CommaToken
    )
      return false
  }

  return false
}

const hasTypeParameterConstraintImport = (tokens: readonly WorkflowSyntaxToken[], importIndex: number): boolean => {
  for (let index = importIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index]
    if (isStatementBoundary(token) || tokens[index + 1]?.hasPrecedingLineBreak) return false
    if (token?.kind === SyntaxKind.EqualsToken || token?.kind === SyntaxKind.EqualsGreaterThanToken) return false
    if (token?.kind === SyntaxKind.LessThanToken) return false
    if (token?.kind === SyntaxKind.ExtendsKeyword) {
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const candidate = tokens[cursor]
        if (isStatementBoundary(candidate) || tokens[cursor + 1]?.hasPrecedingLineBreak) return false
        if (candidate?.kind === SyntaxKind.LessThanToken) {
          const greaterThanIndex = findMatchingGreaterThanIndex(tokens, cursor)
          return (
            greaterThanIndex != null &&
            tokenStartsTypeParameterList(tokens, cursor) &&
            importCallHasTypeQualifier(tokens, importIndex, greaterThanIndex)
          )
        }
        if (candidate?.kind === SyntaxKind.EqualsToken || candidate?.kind === SyntaxKind.EqualsGreaterThanToken)
          return false
      }
    }
  }

  return false
}

const findMatchingCloseParenIndex = (
  tokens: readonly WorkflowSyntaxToken[],
  openParenIndex: number,
  endIndex: number = tokens.length,
): number | undefined => {
  let depth = 0
  for (let index = openParenIndex; index < endIndex; index += 1) {
    const kind = tokens[index]?.kind
    if (kind === SyntaxKind.OpenParenToken) depth += 1
    if (kind === SyntaxKind.CloseParenToken) {
      depth -= 1
      if (depth === 0) return index
    }
  }

  return undefined
}

const importCallHasTypeQualifier = (
  tokens: readonly WorkflowSyntaxToken[],
  importIndex: number,
  endIndex: number = tokens.length,
): boolean => {
  if (tokens[importIndex + 1]?.kind !== SyntaxKind.OpenParenToken) return false

  const closeParenIndex = findMatchingCloseParenIndex(tokens, importIndex + 1, endIndex)
  if (closeParenIndex == null || closeParenIndex + 2 >= endIndex) return false

  return tokens[closeParenIndex + 1]?.kind === SyntaxKind.DotToken && isIdentifierLikeToken(tokens[closeParenIndex + 2])
}

const findMatchingGreaterThanIndex = (
  tokens: readonly WorkflowSyntaxToken[],
  lessThanIndex: number,
): number | undefined => {
  let depth = 0
  for (let index = lessThanIndex; index < tokens.length; index += 1) {
    const kind = tokens[index]?.kind
    if (isStatementBoundary(tokens[index])) return undefined
    if (kind === SyntaxKind.LessThanToken) depth += 1
    if (kind === SyntaxKind.GreaterThanToken) {
      depth -= 1
      if (depth === 0) return index
    }
  }

  return undefined
}

const canStartAngleBracketTypeAssertion = (token: WorkflowSyntaxToken | undefined): boolean =>
  token == null ||
  token.kind === SyntaxKind.EqualsToken ||
  token.kind === SyntaxKind.ReturnKeyword ||
  token.kind === SyntaxKind.CommaToken ||
  token.kind === SyntaxKind.OpenParenToken ||
  token.kind === SyntaxKind.OpenBracketToken ||
  token.kind === SyntaxKind.ColonToken

const isAngleBracketTypeAssertionImport = (tokens: readonly WorkflowSyntaxToken[], importIndex: number): boolean => {
  for (let index = importIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index]
    if (isStatementBoundary(token) || tokens[index + 1]?.hasPrecedingLineBreak) return false
    if (token?.kind === SyntaxKind.LessThanToken) {
      const greaterThanIndex = findMatchingGreaterThanIndex(tokens, index)
      return (
        greaterThanIndex != null &&
        canStartAngleBracketTypeAssertion(tokens[index - 1]) &&
        importCallHasTypeQualifier(tokens, importIndex, greaterThanIndex)
      )
    }
    if (token?.kind === SyntaxKind.EqualsToken || token?.kind === SyntaxKind.EqualsGreaterThanToken) return false
  }

  return false
}

const isTypeArgumentImport = (tokens: readonly WorkflowSyntaxToken[], importIndex: number): boolean => {
  let angleStartIndex = -1
  for (let index = importIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index]
    if (isStatementBoundary(token)) return false
    if (token?.kind === SyntaxKind.LessThanToken) {
      angleStartIndex = index
      break
    }
    if (token?.kind === SyntaxKind.EqualsToken || token?.kind === SyntaxKind.EqualsGreaterThanToken) return false
  }
  if (angleStartIndex < 1) return false

  const calleeToken = tokens[angleStartIndex - 1]
  if (calleeToken == null || !tokenIsCallableTypeArgumentTarget(calleeToken)) return false

  const greaterThanIndex = findMatchingGreaterThanIndex(tokens, angleStartIndex)
  if (greaterThanIndex == null || !importCallHasTypeQualifier(tokens, importIndex, greaterThanIndex)) return false

  const next = tokens[greaterThanIndex + 1]
  if (
    next?.kind === SyntaxKind.OpenParenToken ||
    next?.kind === SyntaxKind.DotToken ||
    next?.kind === SyntaxKind.QuestionDotToken
  ) {
    return true
  }

  let assertionIndex = -1
  for (let index = angleStartIndex - 1; index >= 0; index -= 1) {
    const kind = tokens[index]?.kind
    if (kind === SyntaxKind.SemicolonToken) return false
    if (kind === SyntaxKind.AsKeyword || kind === SyntaxKind.SatisfiesKeyword) {
      assertionIndex = index
      break
    }
  }
  if (assertionIndex < 0) return false

  let angleDepth = 0
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  for (let index = assertionIndex + 1; index < importIndex; index += 1) {
    const kind = tokens[index]?.kind
    const isTopLevel = angleDepth === 0 && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0
    if (
      isTopLevel &&
      (kind === SyntaxKind.CommaToken ||
        kind === SyntaxKind.SemicolonToken ||
        kind === SyntaxKind.QuestionToken ||
        kind === SyntaxKind.ColonToken ||
        kind === SyntaxKind.EqualsToken ||
        kind === SyntaxKind.EqualsGreaterThanToken)
    ) {
      return false
    }

    if (kind === SyntaxKind.LessThanToken) angleDepth += 1
    if (kind === SyntaxKind.GreaterThanToken) angleDepth -= 1
    if (kind === SyntaxKind.OpenParenToken) parenDepth += 1
    if (kind === SyntaxKind.CloseParenToken) {
      if (parenDepth === 0) return false
      parenDepth -= 1
    }
    if (kind === SyntaxKind.OpenBracketToken) bracketDepth += 1
    if (kind === SyntaxKind.CloseBracketToken) {
      if (bracketDepth === 0) return false
      bracketDepth -= 1
    }
    if (kind === SyntaxKind.OpenBraceToken) braceDepth += 1
    if (kind === SyntaxKind.CloseBraceToken) {
      if (braceDepth === 0) return false
      braceDepth -= 1
    }
  }

  return angleDepth > 0 || parenDepth > 0 || bracketDepth > 0 || braceDepth > 0
}

const hasInterfaceHeritagePrefix = (
  tokens: readonly WorkflowSyntaxToken[],
  statementStart: number,
  importIndex: number,
): boolean => {
  const first = tokens[statementStart]
  const second = tokens[statementStart + 1]
  const interfaceIndex =
    first?.kind === SyntaxKind.InterfaceKeyword
      ? statementStart
      : first?.kind === SyntaxKind.ExportKeyword && second?.kind === SyntaxKind.InterfaceKeyword
        ? statementStart + 1
        : -1
  if (interfaceIndex < 0 || interfaceIndex >= importIndex) return false

  let hasExtends = false
  for (let index = interfaceIndex + 1; index < importIndex; index += 1) {
    const kind = tokens[index]?.kind
    if (kind === SyntaxKind.ExtendsKeyword) hasExtends = true
    if (kind === SyntaxKind.ConstKeyword || kind === SyntaxKind.LetKeyword || kind === SyntaxKind.VarKeyword)
      return false
  }

  return hasExtends
}

const isTypeOnlyImportCall = (tokens: readonly WorkflowSyntaxToken[], importIndex: number): boolean => {
  const statementStart = findStatementStartIndex(tokens, importIndex, { lineBreaksAreBoundaries: false })
  const previous = tokens[importIndex - 1]
  return (
    hasTypeAliasPrefix(tokens, statementStart, importIndex) ||
    hasInterfaceHeritagePrefix(tokens, statementStart, importIndex) ||
    hasTypeAnnotationBefore(tokens, statementStart, importIndex) ||
    hasTypeParameterConstraintImport(tokens, importIndex) ||
    isAngleBracketTypeAssertionImport(tokens, importIndex) ||
    isTypeArgumentImport(tokens, importIndex) ||
    previous?.kind === SyntaxKind.AsKeyword ||
    previous?.kind === SyntaxKind.SatisfiesKeyword
  )
}

const findFromModuleSpecifier = (
  tokens: readonly WorkflowSyntaxToken[],
  startIndex: number,
): WorkflowModuleSpecifier | undefined => {
  for (let index = startIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (isModuleSpecifierSearchBoundary(token)) return undefined

    if (token.kind === SyntaxKind.FromKeyword && isStringLiteral(tokens[index + 1])) {
      const specifier = tokens[index + 1]
      return { specifier: specifier.value, start: specifier.start, end: specifier.end }
    }
  }

  return undefined
}

export const collectWorkflowModuleSpecifiers = (tokens: readonly WorkflowSyntaxToken[]): WorkflowModuleSpecifier[] => {
  const specifiers: WorkflowModuleSpecifier[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind === SyntaxKind.ImportKeyword) {
      const next = tokens[index + 1]
      if (next?.kind === SyntaxKind.OpenParenToken) continue
      if (isStringLiteral(next)) {
        specifiers.push({ specifier: next.value, start: next.start, end: next.end })
        continue
      }
      const fromSpecifier = findFromModuleSpecifier(tokens, index)
      if (fromSpecifier) specifiers.push(fromSpecifier)
      continue
    }

    if (token.kind === SyntaxKind.ExportKeyword) {
      const fromSpecifier = findFromModuleSpecifier(tokens, index)
      if (fromSpecifier) specifiers.push(fromSpecifier)
    }
  }

  return specifiers
}

export const collectWorkflowDynamicImportPositions = (tokens: readonly WorkflowSyntaxToken[]): number[] => {
  const positions: number[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (
      token.kind === SyntaxKind.ImportKeyword &&
      tokens[index + 1]?.kind === SyntaxKind.OpenParenToken &&
      !isTypeOnlyImportCall(tokens, index)
    ) {
      positions.push(token.start)
    }
  }

  return positions
}
