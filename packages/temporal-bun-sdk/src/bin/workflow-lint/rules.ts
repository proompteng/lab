import { readFile } from 'node:fs/promises'

import { SyntaxKind } from 'typescript/unstable/ast'

import {
  collectWorkflowDynamicImportPositions,
  collectWorkflowModuleSpecifiers,
  createWorkflowPositionResolver,
  isIdentifierLikeToken,
  scanWorkflowSyntaxTokens,
  type WorkflowSyntaxToken,
} from './syntax-scan'

export type WorkflowLintViolation = {
  readonly filePath: string
  readonly rule:
    | 'deny-global'
    | 'deny-member-expression'
    | 'deny-import'
    | 'capture-global'
    | 'capture-member-expression'
    | 'dynamic-import'
    | 'unresolved-import'
  readonly message: string
  readonly line: number
  readonly column: number
  readonly details?: Record<string, unknown>
}

const memberExpressionName = (
  tokens: readonly WorkflowSyntaxToken[],
  index: number,
): { name: string; token: WorkflowSyntaxToken; endIndex: number } | undefined => {
  const objectToken = tokens[index]
  let objectStartIndex = index
  let objectEndIndex = index
  while (
    tokens[objectStartIndex - 1]?.kind === SyntaxKind.OpenParenToken &&
    tokens[objectEndIndex + 1]?.kind === SyntaxKind.CloseParenToken
  ) {
    objectStartIndex -= 1
    objectEndIndex += 1
  }

  const previous = objectStartIndex > 0 ? tokens[objectStartIndex - 1] : undefined
  if (previous?.kind === SyntaxKind.DotToken || previous?.kind === SyntaxKind.QuestionDotToken) return undefined

  const dotToken = tokens[objectEndIndex + 1]
  const propertyToken = tokens[objectEndIndex + 2]
  if (
    isIdentifierLikeToken(objectToken) &&
    (dotToken?.kind === SyntaxKind.DotToken || dotToken?.kind === SyntaxKind.QuestionDotToken) &&
    isIdentifierLikeToken(propertyToken)
  ) {
    const name = `${objectToken.text}.${propertyToken.text}`
    if (name === 'import.meta') {
      let expressionStartIndex = objectStartIndex
      let expressionEndIndex = objectEndIndex + 2
      while (
        tokens[expressionStartIndex - 1]?.kind === SyntaxKind.OpenParenToken &&
        tokens[expressionEndIndex + 1]?.kind === SyntaxKind.CloseParenToken
      ) {
        expressionStartIndex -= 1
        expressionEndIndex += 1
      }

      const nestedDotToken = tokens[expressionEndIndex + 1]
      const nestedPropertyToken = tokens[expressionEndIndex + 2]
      if (
        (nestedDotToken?.kind === SyntaxKind.DotToken || nestedDotToken?.kind === SyntaxKind.QuestionDotToken) &&
        isIdentifierLikeToken(nestedPropertyToken)
      ) {
        return { name: `${name}.${nestedPropertyToken.text}`, token: objectToken, endIndex: expressionEndIndex + 2 }
      }

      const nestedOpenBracketToken = tokens[expressionEndIndex + 1]
      const nestedElementToken = tokens[expressionEndIndex + 2]
      const nestedCloseBracketToken = tokens[expressionEndIndex + 3]
      if (
        nestedOpenBracketToken?.kind === SyntaxKind.OpenBracketToken &&
        nestedElementToken?.kind === SyntaxKind.StringLiteral &&
        nestedCloseBracketToken?.kind === SyntaxKind.CloseBracketToken
      ) {
        return { name: `${name}.${nestedElementToken.value}`, token: objectToken, endIndex: expressionEndIndex + 3 }
      }
    }
    return { name, token: objectToken, endIndex: objectEndIndex + 2 }
  }

  const bracketIndex =
    tokens[objectEndIndex + 1]?.kind === SyntaxKind.QuestionDotToken &&
    tokens[objectEndIndex + 2]?.kind === SyntaxKind.OpenBracketToken
      ? objectEndIndex + 2
      : objectEndIndex + 1
  const openBracketToken = tokens[bracketIndex]
  const elementToken = tokens[bracketIndex + 1]
  const closeBracketToken = tokens[bracketIndex + 2]
  if (
    isIdentifierLikeToken(objectToken) &&
    openBracketToken?.kind === SyntaxKind.OpenBracketToken &&
    elementToken?.kind === SyntaxKind.StringLiteral &&
    closeBracketToken?.kind === SyntaxKind.CloseBracketToken
  ) {
    return { name: `${objectToken.text}.${elementToken.value}`, token: objectToken, endIndex: bracketIndex + 2 }
  }

  return undefined
}

const memberExpressionChainName = (tokens: readonly WorkflowSyntaxToken[], index: number): string | undefined => {
  const objectToken = tokens[index]
  if (!isIdentifierLikeToken(objectToken)) return undefined

  let expressionStartIndex = index
  let expressionEndIndex = index
  while (
    tokens[expressionStartIndex - 1]?.kind === SyntaxKind.OpenParenToken &&
    tokens[expressionEndIndex + 1]?.kind === SyntaxKind.CloseParenToken
  ) {
    expressionStartIndex -= 1
    expressionEndIndex += 1
  }

  const parts = [objectToken.text]
  let cursor = expressionEndIndex + 1
  while (
    (tokens[cursor]?.kind === SyntaxKind.DotToken || tokens[cursor]?.kind === SyntaxKind.QuestionDotToken) &&
    isIdentifierLikeToken(tokens[cursor + 1])
  ) {
    parts.push(tokens[cursor + 1].text)
    cursor += 2
  }

  return parts.length > 1 ? parts.join('.') : undefined
}

const parenthesizedIdentifier = (
  tokens: readonly WorkflowSyntaxToken[],
  index: number,
): { token: WorkflowSyntaxToken; endIndex: number } | undefined => {
  let cursor = index
  let parenthesisDepth = 0
  while (tokens[cursor]?.kind === SyntaxKind.OpenParenToken) {
    parenthesisDepth += 1
    cursor += 1
  }

  const token = tokens[cursor]
  if (!isIdentifierLikeToken(token)) return undefined
  cursor += 1
  for (let depth = 0; depth < parenthesisDepth; depth += 1) {
    if (tokens[cursor]?.kind !== SyntaxKind.CloseParenToken) return undefined
    cursor += 1
  }

  return { token, endIndex: cursor - 1 }
}

const reflectivelyAccessedGlobalProperty = (
  tokens: readonly WorkflowSyntaxToken[],
  memberEndIndex: number,
): { target: WorkflowSyntaxToken; propertyStartIndex: number; propertyEndIndex: number } | undefined => {
  if (tokens[memberEndIndex + 1]?.kind !== SyntaxKind.OpenParenToken) return undefined
  const target = parenthesizedIdentifier(tokens, memberEndIndex + 2)
  if (!target) return undefined
  if (tokens[target.endIndex + 1]?.kind !== SyntaxKind.CommaToken) return undefined

  const propertyStartIndex = target.endIndex + 2
  let parenthesisDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  for (let index = propertyStartIndex; index < tokens.length; index += 1) {
    const kind = tokens[index]?.kind
    if (kind === SyntaxKind.OpenParenToken) parenthesisDepth += 1
    if (kind === SyntaxKind.OpenBracketToken) bracketDepth += 1
    if (kind === SyntaxKind.OpenBraceToken) braceDepth += 1
    if (kind === SyntaxKind.CloseBracketToken) bracketDepth -= 1
    if (kind === SyntaxKind.CloseBraceToken) braceDepth -= 1
    if (kind === SyntaxKind.CloseParenToken) {
      if (parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return { target: target.token, propertyStartIndex, propertyEndIndex: index - 1 }
      }
      parenthesisDepth -= 1
    }
    if (kind === SyntaxKind.CommaToken && parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      return { target: target.token, propertyStartIndex, propertyEndIndex: index - 1 }
    }
  }

  return undefined
}

type StaticPropertyKey =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'symbol' }
  | { readonly kind: 'primitive' }

type StaticPropertyBinding = {
  declarations: number
  mutations: number
  initializer?: StaticPropertyKey
}

const assignmentOperators = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '**=',
  '/=',
  '%=',
  '<<=',
  '>>=',
  '>>>=',
  '&=',
  '|=',
  '^=',
  '&&=',
  '||=',
  '??=',
])

const isVariableDeclarationKeyword = (token: WorkflowSyntaxToken | undefined): boolean =>
  token?.kind === SyntaxKind.ConstKeyword ||
  token?.kind === SyntaxKind.LetKeyword ||
  token?.kind === SyntaxKind.VarKeyword

const isAssignmentOperator = (token: WorkflowSyntaxToken | undefined): boolean =>
  token != null && assignmentOperators.has(token.text)

const stripParentheses = (
  tokens: readonly WorkflowSyntaxToken[],
  startIndex: number,
  endIndex: number,
): { startIndex: number; endIndex: number } => {
  let start = startIndex
  let end = endIndex
  while (tokens[start]?.kind === SyntaxKind.OpenParenToken && tokens[end]?.kind === SyntaxKind.CloseParenToken) {
    const matchingClose = findMatchingCloseParenIndex(tokens, start)
    if (matchingClose !== end) break
    start += 1
    end -= 1
  }
  return { startIndex: start, endIndex: end }
}

const staticPropertyKeyAt = (
  tokens: readonly WorkflowSyntaxToken[],
  startIndex: number,
  endIndex: number,
  options: { readonly symbolIsUnshadowed: boolean },
): StaticPropertyKey | undefined => {
  const range = stripParentheses(tokens, startIndex, endIndex)
  const token = tokens[range.startIndex]
  if (!token || range.endIndex < range.startIndex) return undefined

  if (
    range.startIndex === range.endIndex &&
    (token.kind === SyntaxKind.StringLiteral || token.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
  ) {
    return { kind: 'string', value: token.value }
  }
  if (
    range.startIndex === range.endIndex &&
    (token.kind === SyntaxKind.NumericLiteral ||
      token.kind === SyntaxKind.BigIntLiteral ||
      token.kind === SyntaxKind.TrueKeyword ||
      token.kind === SyntaxKind.FalseKeyword ||
      token.kind === SyntaxKind.NullKeyword)
  ) {
    return { kind: 'primitive' }
  }
  if (!options.symbolIsUnshadowed || token.text !== 'Symbol') return undefined

  const next = tokens[range.startIndex + 1]
  if (
    next?.kind === SyntaxKind.OpenParenToken &&
    findMatchingCloseParenIndex(tokens, range.startIndex + 1) === range.endIndex
  ) {
    return { kind: 'symbol' }
  }
  if (
    next?.kind === SyntaxKind.DotToken &&
    tokens[range.startIndex + 2]?.text === 'for' &&
    tokens[range.startIndex + 3]?.kind === SyntaxKind.OpenParenToken &&
    findMatchingCloseParenIndex(tokens, range.startIndex + 3) === range.endIndex
  ) {
    return { kind: 'symbol' }
  }

  return undefined
}

const collectStaticPropertyBindings = (
  tokens: readonly WorkflowSyntaxToken[],
): ReadonlyMap<string, StaticPropertyKey> => {
  const bindings = new Map<string, StaticPropertyBinding>()
  const symbolIsUnshadowed = !tokens.some((token, index) => {
    if (token.text !== 'Symbol') return false
    const previous = tokens[index - 1]
    const next = tokens[index + 1]
    return (
      isVariableDeclarationKeyword(previous) ||
      previous?.kind === SyntaxKind.FunctionKeyword ||
      previous?.kind === SyntaxKind.ClassKeyword ||
      (isAssignmentOperator(next) &&
        previous?.kind !== SyntaxKind.DotToken &&
        previous?.kind !== SyntaxKind.QuestionDotToken)
    )
  })

  for (let index = 0; index < tokens.length; index += 1) {
    const declarationKeyword = tokens[index]
    const identifier = tokens[index + 1]
    if (!isVariableDeclarationKeyword(declarationKeyword) || !isIdentifierLikeToken(identifier)) continue

    const existing = bindings.get(identifier.text) ?? { declarations: 0, mutations: 0 }
    existing.declarations += 1
    if (tokens[index + 2]?.kind === SyntaxKind.EqualsToken) {
      const initializerStartIndex = index + 3
      let initializerEndIndex = tokens.length - 1
      let parenthesisDepth = 0
      for (let cursor = initializerStartIndex; cursor < tokens.length; cursor += 1) {
        const kind = tokens[cursor]?.kind
        if (kind === SyntaxKind.OpenParenToken) parenthesisDepth += 1
        if (kind === SyntaxKind.CloseParenToken) parenthesisDepth -= 1
        if (parenthesisDepth === 0 && (kind === SyntaxKind.SemicolonToken || kind === SyntaxKind.CommaToken)) {
          initializerEndIndex = cursor - 1
          break
        }
        if (parenthesisDepth === 0 && tokens[cursor + 1]?.hasPrecedingLineBreak) {
          initializerEndIndex = cursor
          break
        }
      }
      existing.initializer = staticPropertyKeyAt(tokens, initializerStartIndex, initializerEndIndex, {
        symbolIsUnshadowed,
      })
    }
    bindings.set(identifier.text, existing)
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!isIdentifierLikeToken(token)) continue
    const binding = bindings.get(token.text)
    if (!binding) continue

    const previous = tokens[index - 1]
    const next = tokens[index + 1]
    const declaration = isVariableDeclarationKeyword(previous)
    const memberProperty = previous?.kind === SyntaxKind.DotToken || previous?.kind === SyntaxKind.QuestionDotToken
    if (!declaration && !memberProperty && isAssignmentOperator(next)) binding.mutations += 1
    if (previous?.kind === SyntaxKind.PlusPlusToken || previous?.kind === SyntaxKind.MinusMinusToken)
      binding.mutations += 1
    if (next?.kind === SyntaxKind.PlusPlusToken || next?.kind === SyntaxKind.MinusMinusToken) binding.mutations += 1
  }

  return new Map(
    [...bindings.entries()].flatMap(([name, binding]) =>
      binding.declarations === 1 && binding.mutations === 0 && binding.initializer
        ? [[name, binding.initializer] as const]
        : [],
    ),
  )
}

const resolveStaticPropertyKey = (
  tokens: readonly WorkflowSyntaxToken[],
  startIndex: number,
  endIndex: number,
  bindings: ReadonlyMap<string, StaticPropertyKey>,
): StaticPropertyKey | undefined => {
  const range = stripParentheses(tokens, startIndex, endIndex)
  const token = tokens[range.startIndex]
  if (range.startIndex === range.endIndex && isIdentifierLikeToken(token)) return bindings.get(token.text)
  return staticPropertyKeyAt(tokens, range.startIndex, range.endIndex, { symbolIsUnshadowed: false })
}

const computedMemberProperty = (
  tokens: readonly WorkflowSyntaxToken[],
  objectIndex: number,
):
  | { object: WorkflowSyntaxToken; propertyStartIndex: number; propertyEndIndex: number; endIndex: number }
  | undefined => {
  const object = tokens[objectIndex]
  if (!isIdentifierLikeToken(object)) return undefined

  const bracketIndex =
    tokens[objectIndex + 1]?.kind === SyntaxKind.QuestionDotToken &&
    tokens[objectIndex + 2]?.kind === SyntaxKind.OpenBracketToken
      ? objectIndex + 2
      : objectIndex + 1
  if (tokens[bracketIndex]?.kind !== SyntaxKind.OpenBracketToken) return undefined

  let depth = 0
  for (let index = bracketIndex; index < tokens.length; index += 1) {
    const kind = tokens[index]?.kind
    if (kind === SyntaxKind.OpenBracketToken) depth += 1
    if (kind === SyntaxKind.CloseBracketToken) {
      depth -= 1
      if (depth === 0) {
        return { object, propertyStartIndex: bracketIndex + 1, propertyEndIndex: index - 1, endIndex: index }
      }
    }
  }

  return undefined
}

const isInvokedMemberExpression = (tokens: readonly WorkflowSyntaxToken[], endIndex: number): boolean => {
  const next = tokens[endIndex + 1]
  if (next?.kind === SyntaxKind.OpenParenToken) return true
  if (next?.kind === SyntaxKind.QuestionDotToken && tokens[endIndex + 2]?.kind === SyntaxKind.OpenParenToken)
    return true
  if (
    (next?.kind === SyntaxKind.DotToken || next?.kind === SyntaxKind.QuestionDotToken) &&
    (tokens[endIndex + 2]?.text === 'call' ||
      tokens[endIndex + 2]?.text === 'apply' ||
      tokens[endIndex + 2]?.text === 'bind') &&
    tokens[endIndex + 3]?.kind === SyntaxKind.OpenParenToken
  )
    return true
  return false
}

const previousToken = (tokens: readonly WorkflowSyntaxToken[], index: number): WorkflowSyntaxToken | undefined =>
  index > 0 ? tokens[index - 1] : undefined

const nextToken = (tokens: readonly WorkflowSyntaxToken[], index: number): WorkflowSyntaxToken | undefined =>
  tokens[index + 1]

const isStatementBoundary = (token: WorkflowSyntaxToken | undefined): boolean =>
  token == null ||
  token.kind === SyntaxKind.SemicolonToken ||
  token.kind === SyntaxKind.OpenBraceToken ||
  token.kind === SyntaxKind.CloseBraceToken

const findStatementStartIndex = (
  tokens: readonly WorkflowSyntaxToken[],
  index: number,
  options: { readonly lineBreaksAreBoundaries: boolean } = { lineBreaksAreBoundaries: true },
): number => {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (
      (options.lineBreaksAreBoundaries && tokens[cursor + 1]?.hasPrecedingLineBreak) ||
      isStatementBoundary(tokens[cursor])
    )
      return cursor + 1
  }

  return 0
}

const isRuntimeVariableInitializerCapture = (
  tokens: readonly WorkflowSyntaxToken[],
  index: number,
  previous: WorkflowSyntaxToken | undefined,
): boolean => {
  let assignmentIndex = index - 1
  while (tokens[assignmentIndex]?.kind === SyntaxKind.OpenParenToken) assignmentIndex -= 1
  if (tokens[assignmentIndex]?.kind !== SyntaxKind.EqualsToken && previous?.kind !== SyntaxKind.EqualsToken)
    return false

  const statementStart = findStatementStartIndex(tokens, index, { lineBreaksAreBoundaries: false })
  for (let cursor = statementStart; cursor < index; cursor += 1) {
    const kind = tokens[cursor]?.kind
    if (kind === SyntaxKind.ConstKeyword || kind === SyntaxKind.LetKeyword || kind === SyntaxKind.VarKeyword)
      return true
  }

  return false
}

const isDirectRuntimeVariableInitializerCapture = (
  tokens: readonly WorkflowSyntaxToken[],
  index: number,
  previous: WorkflowSyntaxToken | undefined,
): boolean => {
  if (!isRuntimeVariableInitializerCapture(tokens, index, previous)) return false

  let expressionStartIndex = index
  let expressionEndIndex = index
  while (
    tokens[expressionStartIndex - 1]?.kind === SyntaxKind.OpenParenToken &&
    tokens[expressionEndIndex + 1]?.kind === SyntaxKind.CloseParenToken
  ) {
    expressionStartIndex -= 1
    expressionEndIndex += 1
  }

  const next = tokens[expressionEndIndex + 1]
  return (
    next?.kind !== SyntaxKind.DotToken &&
    next?.kind !== SyntaxKind.QuestionDotToken &&
    next?.kind !== SyntaxKind.OpenBracketToken
  )
}

const findMatchingCloseParenIndex = (
  tokens: readonly WorkflowSyntaxToken[],
  openParenIndex: number,
): number | undefined => {
  let depth = 0
  for (let index = openParenIndex; index < tokens.length; index += 1) {
    const kind = tokens[index]?.kind
    if (kind === SyntaxKind.OpenParenToken) depth += 1
    if (kind === SyntaxKind.CloseParenToken) {
      depth -= 1
      if (depth === 0) return index
    }
    if (depth <= 0 && index > openParenIndex) return undefined
  }

  return undefined
}

const hasTernaryQuestionBefore = (
  tokens: readonly WorkflowSyntaxToken[],
  statementStart: number,
  index: number,
): boolean => {
  for (let cursor = statementStart; cursor < index; cursor += 1) {
    if (tokens[cursor]?.kind === SyntaxKind.QuestionToken) return true
  }

  return false
}

const findEnclosingOpenBraceIndex = (tokens: readonly WorkflowSyntaxToken[], index: number): number | undefined => {
  let depth = 0
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor]?.kind
    if (kind === SyntaxKind.CloseBraceToken) {
      depth += 1
      continue
    }
    if (kind !== SyntaxKind.OpenBraceToken) continue
    if (depth === 0) return cursor
    depth -= 1
  }

  return undefined
}

const isDeclarationMemberContainer = (tokens: readonly WorkflowSyntaxToken[], index: number): boolean => {
  const openBraceIndex = findEnclosingOpenBraceIndex(tokens, index)
  if (openBraceIndex == null) return false

  const containerStart = findStatementStartIndex(tokens, openBraceIndex, { lineBreaksAreBoundaries: false })
  for (let cursor = containerStart; cursor < openBraceIndex; cursor += 1) {
    const kind = tokens[cursor]?.kind
    if (kind === SyntaxKind.ClassKeyword || kind === SyntaxKind.InterfaceKeyword || kind === SyntaxKind.TypeKeyword)
      return true
  }

  const beforeOpenBrace = tokens[openBraceIndex - 1]?.kind
  return (
    beforeOpenBrace === SyntaxKind.EqualsToken ||
    beforeOpenBrace === SyntaxKind.ReturnKeyword ||
    beforeOpenBrace === SyntaxKind.DefaultKeyword ||
    beforeOpenBrace === SyntaxKind.OpenParenToken ||
    beforeOpenBrace === SyntaxKind.OpenBracketToken ||
    beforeOpenBrace === SyntaxKind.CommaToken ||
    beforeOpenBrace === SyntaxKind.ColonToken ||
    beforeOpenBrace === SyntaxKind.QuestionToken
  )
}

const isDeclarationLikeGlobalCallShape = (tokens: readonly WorkflowSyntaxToken[], index: number): boolean => {
  const statementStart = findStatementStartIndex(tokens, index, { lineBreaksAreBoundaries: false })
  for (let cursor = statementStart; cursor < index; cursor += 1) {
    if (tokens[cursor]?.kind === SyntaxKind.FunctionKeyword) return true
  }

  const closeParenIndex = findMatchingCloseParenIndex(tokens, index + 1)
  if (closeParenIndex == null) return false

  const afterCloseParen = tokens[closeParenIndex + 1]
  if (afterCloseParen?.kind === SyntaxKind.OpenBraceToken) return isDeclarationMemberContainer(tokens, index)
  if (afterCloseParen?.kind !== SyntaxKind.ColonToken) return false

  return !hasTernaryQuestionBefore(tokens, statementStart, index)
}

const hasTypeContextBeforeOpenBrace = (tokens: readonly WorkflowSyntaxToken[], statementStart: number): boolean => {
  const openBraceIndex = statementStart - 1
  if (tokens[openBraceIndex]?.kind !== SyntaxKind.OpenBraceToken) return true

  const beforeOpenBrace = tokens[openBraceIndex - 1]
  if (beforeOpenBrace?.kind === SyntaxKind.ColonToken) {
    for (let cursor = openBraceIndex - 2; cursor >= 0; cursor -= 1) {
      const kind = tokens[cursor]?.kind
      if (tokens[cursor + 1]?.hasPrecedingLineBreak) return false
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

  for (let cursor = openBraceIndex - 1; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor]?.kind
    if (tokens[cursor + 1]?.hasPrecedingLineBreak) return false
    if (kind === SyntaxKind.SemicolonToken || kind === SyntaxKind.OpenBraceToken || kind === SyntaxKind.CloseBraceToken)
      return false
    if (kind === SyntaxKind.TypeKeyword || kind === SyntaxKind.InterfaceKeyword || kind === SyntaxKind.ClassKeyword)
      return true
    if (kind === SyntaxKind.ReturnKeyword) return false
  }

  return false
}

const isTypeOnlyTypeofMemberExpression = (
  tokens: readonly WorkflowSyntaxToken[],
  index: number,
  previous: WorkflowSyntaxToken | undefined,
): boolean => {
  if (previous?.kind !== SyntaxKind.TypeOfKeyword) return false

  const statementStart = findStatementStartIndex(tokens, index, { lineBreaksAreBoundaries: false })
  let sawTypeKeyword = false
  let sawTypeAssertion = false
  let colonIndex = -1
  let runtimeBoundaryIndex = statementStart - 1
  for (let cursor = statementStart; cursor < index; cursor += 1) {
    const kind = tokens[cursor]?.kind
    if (kind === SyntaxKind.TypeKeyword) sawTypeKeyword = true
    if (kind === SyntaxKind.AsKeyword || kind === SyntaxKind.SatisfiesKeyword) sawTypeAssertion = true
    if (kind === SyntaxKind.ColonToken) colonIndex = cursor
    if (
      kind === SyntaxKind.CommaToken ||
      kind === SyntaxKind.QuestionToken ||
      kind === SyntaxKind.CloseParenToken ||
      kind === SyntaxKind.CloseBracketToken ||
      kind === SyntaxKind.CloseBraceToken
    ) {
      sawTypeAssertion = false
    }
    if (kind === SyntaxKind.EqualsToken || kind === SyntaxKind.EqualsGreaterThanToken) {
      runtimeBoundaryIndex = cursor
      sawTypeAssertion = false
    }
  }

  return (
    sawTypeKeyword ||
    sawTypeAssertion ||
    (colonIndex > runtimeBoundaryIndex && hasTypeContextBeforeOpenBrace(tokens, statementStart))
  )
}

export const lintWorkflowSourceAst = (options: {
  readonly filePath: string
  readonly sourceText: string
  readonly denyGlobals: ReadonlySet<string>
  readonly denyMemberExpressions: ReadonlySet<string>
  readonly denyImports: ReadonlySet<string>
  readonly denyReflectiveGlobalProperties?: ReadonlyMap<string, ReadonlySet<string>>
  readonly denyComputedGlobalProperties?: ReadonlyMap<string, ReadonlySet<string>>
  readonly denyGlobalCaptures?: ReadonlySet<string>
  readonly denyIndirectGlobalReferences?: ReadonlySet<string>
  readonly allowIndirectGlobalMemberExpressions?: ReadonlySet<string>
  readonly denyInvokedMemberProperties?: ReadonlySet<string>
}): WorkflowLintViolation[] => {
  const violations: WorkflowLintViolation[] = []
  const sourceText = options.sourceText
  const tokens = scanWorkflowSyntaxTokens(sourceText)
  const positionOf = createWorkflowPositionResolver(sourceText)
  const staticPropertyBindings = collectStaticPropertyBindings(tokens)
  const reportedInvokedMemberProperties = new Set<number>()

  const report = (position: number, violation: Omit<WorkflowLintViolation, 'filePath' | 'line' | 'column'>) => {
    const { line, column } = positionOf(position)
    violations.push({
      filePath: options.filePath,
      line,
      column,
      ...violation,
    })
  }

  for (const moduleSpecifier of collectWorkflowModuleSpecifiers(tokens)) {
    if (options.denyImports.has(moduleSpecifier.specifier)) {
      report(moduleSpecifier.start, {
        rule: 'deny-import',
        message: `Disallowed import in workflow module: ${moduleSpecifier.specifier}`,
        details: { specifier: moduleSpecifier.specifier },
      })
    }
  }

  for (const position of collectWorkflowDynamicImportPositions(tokens)) {
    report(position, {
      rule: 'dynamic-import',
      message: 'Dynamic import() is not allowed in workflow modules',
    })
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (
      (token.kind === SyntaxKind.StringLiteral || token.kind === SyntaxKind.NoSubstitutionTemplateLiteral) &&
      options.denyInvokedMemberProperties?.has(token.value) &&
      previousToken(tokens, index)?.kind === SyntaxKind.OpenBracketToken &&
      nextToken(tokens, index)?.kind === SyntaxKind.CloseBracketToken &&
      isInvokedMemberExpression(tokens, index + 1) &&
      !reportedInvokedMemberProperties.has(token.start)
    ) {
      reportedInvokedMemberProperties.add(token.start)
      report(token.start, {
        rule: 'deny-member-expression',
        message: `Disallowed invoked member property in workflow module: ${token.value}`,
        details: { memberProperty: token.value },
      })
    }
    if (!isIdentifierLikeToken(token)) continue

    const previous = previousToken(tokens, index)
    const next = nextToken(tokens, index)
    const name = token.text
    const runtimeVariableCapture = isRuntimeVariableInitializerCapture(tokens, index, previous)
    const isDirectGlobalCall = next?.kind === SyntaxKind.OpenParenToken
    const isOptionalGlobalCall =
      next?.kind === SyntaxKind.QuestionDotToken && tokens[index + 2]?.kind === SyntaxKind.OpenParenToken
    const isMemberCall = previous?.kind === SyntaxKind.DotToken || previous?.kind === SyntaxKind.QuestionDotToken
    const directRuntimeVariableCapture = isDirectRuntimeVariableInitializerCapture(tokens, index, previous)
    const allowedIndirectGlobalMemberExpression = options.allowIndirectGlobalMemberExpressions?.has(
      memberExpressionChainName(tokens, index) ?? '',
    )

    if (
      options.denyInvokedMemberProperties?.has(name) &&
      (previous?.kind === SyntaxKind.DotToken || previous?.kind === SyntaxKind.QuestionDotToken) &&
      isInvokedMemberExpression(tokens, index) &&
      !reportedInvokedMemberProperties.has(token.start)
    ) {
      reportedInvokedMemberProperties.add(token.start)
      report(token.start, {
        rule: 'deny-member-expression',
        message: `Disallowed invoked member property in workflow module: ${name}`,
        details: { memberProperty: name },
      })
    }

    if (
      options.denyIndirectGlobalReferences?.has(name) &&
      !directRuntimeVariableCapture &&
      !isDirectGlobalCall &&
      !isOptionalGlobalCall &&
      !isMemberCall &&
      previous?.kind !== SyntaxKind.NewKeyword &&
      !allowedIndirectGlobalMemberExpression
    ) {
      report(token.start, {
        rule: 'deny-global',
        message: `Disallowed indirect global reference in workflow module: ${name}`,
        details: { global: name },
      })
    }

    if (options.denyGlobalCaptures?.has(name) && isDirectRuntimeVariableInitializerCapture(tokens, index, previous)) {
      report(token.start, {
        rule: 'capture-global',
        message: `Capturing disallowed global in workflow module: const x = ${name}`,
        details: { global: name },
      })
    }

    if (
      name === 'Bun' &&
      options.denyGlobals.has(name) &&
      !runtimeVariableCapture &&
      previous?.kind !== SyntaxKind.DotToken &&
      previous?.kind !== SyntaxKind.QuestionDotToken &&
      next?.kind !== SyntaxKind.ColonToken &&
      !isTypeOnlyTypeofMemberExpression(tokens, index, previous)
    ) {
      report(token.start, {
        rule: 'deny-global',
        message: 'Disallowed Bun runtime reference in workflow module',
        details: { global: name },
      })
    }

    if (options.denyGlobals.has(name)) {
      const isDeclarationLikeGlobalCall = isDirectGlobalCall && isDeclarationLikeGlobalCallShape(tokens, index)

      if ((isDirectGlobalCall || isOptionalGlobalCall) && !isMemberCall && !isDeclarationLikeGlobalCall) {
        report(token.start, {
          rule: 'deny-global',
          message: `Disallowed global in workflow module: ${name}()`,
          details: { global: name },
        })
      }

      if (previous?.kind === SyntaxKind.NewKeyword) {
        report(token.start, {
          rule: 'deny-global',
          message: `Disallowed global in workflow module: new ${name}(...)`,
          details: { global: name },
        })
      }

      if (
        runtimeVariableCapture &&
        (!options.denyIndirectGlobalReferences?.has(name) || directRuntimeVariableCapture)
      ) {
        report(token.start, {
          rule: 'capture-global',
          message: `Capturing disallowed global in workflow module: const x = ${name}`,
          details: { global: name },
        })
      }
    }

    const member = memberExpressionName(tokens, index)
    const computedProperty = computedMemberProperty(tokens, index)
    const deniedComputedProperties = computedProperty
      ? options.denyComputedGlobalProperties?.get(computedProperty.object.text)
      : undefined
    if (computedProperty && deniedComputedProperties) {
      const property = resolveStaticPropertyKey(
        tokens,
        computedProperty.propertyStartIndex,
        computedProperty.propertyEndIndex,
        staticPropertyBindings,
      )
      if (!property || (property.kind === 'string' && deniedComputedProperties.has(property.value))) {
        report(computedProperty.object.start, {
          rule: 'deny-member-expression',
          message: property
            ? `Disallowed computed global access in workflow module: ${computedProperty.object.text}['${property.value}']`
            : `Unable to prove computed global property safe in workflow module: ${computedProperty.object.text}[...]`,
          details: {
            memberExpression: `${computedProperty.object.text}[...]`,
            ...(property?.kind === 'string' ? { global: property.value } : {}),
          },
        })
      }
    }
    if (computedProperty && options.denyInvokedMemberProperties) {
      const property = resolveStaticPropertyKey(
        tokens,
        computedProperty.propertyStartIndex,
        computedProperty.propertyEndIndex,
        staticPropertyBindings,
      )
      const propertyToken = tokens[computedProperty.propertyStartIndex]
      if (
        property?.kind === 'string' &&
        options.denyInvokedMemberProperties.has(property.value) &&
        isInvokedMemberExpression(tokens, computedProperty.endIndex) &&
        propertyToken &&
        !reportedInvokedMemberProperties.has(propertyToken.start)
      ) {
        reportedInvokedMemberProperties.add(propertyToken.start)
        report(propertyToken.start, {
          rule: 'deny-member-expression',
          message: `Disallowed invoked member property in workflow module: ${property.value}`,
          details: { memberProperty: property.value },
        })
      }
    }

    if (!member) continue

    if (member.name === 'Reflect.get') {
      const reflectiveAccess = reflectivelyAccessedGlobalProperty(tokens, member.endIndex)
      const deniedReflectiveProperties = reflectiveAccess
        ? options.denyReflectiveGlobalProperties?.get(reflectiveAccess.target.text)
        : undefined
      if (reflectiveAccess && deniedReflectiveProperties) {
        const property = resolveStaticPropertyKey(
          tokens,
          reflectiveAccess.propertyStartIndex,
          reflectiveAccess.propertyEndIndex,
          staticPropertyBindings,
        )
        if (!property || (property.kind === 'string' && deniedReflectiveProperties.has(property.value))) {
          report(member.token.start, {
            rule: 'deny-member-expression',
            message: property
              ? `Disallowed reflective global access in workflow module: Reflect.get(${reflectiveAccess.target.text}, '${property.value}')`
              : `Unable to prove reflective global property safe in workflow module: Reflect.get(${reflectiveAccess.target.text}, ...)`,
            details: {
              memberExpression: member.name,
              ...(property?.kind === 'string' ? { global: property.value } : {}),
            },
          })
        }
      }
    }

    if (options.denyMemberExpressions.has(member.name) && !isTypeOnlyTypeofMemberExpression(tokens, index, previous)) {
      report(member.token.start, {
        rule: 'deny-member-expression',
        message: `Disallowed member expression in workflow module: ${member.name}`,
        details: { memberExpression: member.name },
      })
    }

    if (
      member.name === 'Bun.spawn' &&
      options.denyGlobals.has('Bun.spawn') &&
      !isTypeOnlyTypeofMemberExpression(tokens, index, previous)
    ) {
      report(member.token.start, {
        rule: 'deny-global',
        message: 'Disallowed global in workflow module: Bun.spawn(...)',
        details: { global: 'Bun.spawn' },
      })
    }

    if (previous?.kind === SyntaxKind.EqualsToken && options.denyMemberExpressions.has(member.name)) {
      report(member.token.start, {
        rule: 'capture-member-expression',
        message: `Capturing disallowed member expression in workflow module: const x = ${member.name}`,
        details: { memberExpression: member.name },
      })
    }
  }

  return violations
}

export const lintWorkflowModuleAst = async (options: {
  readonly filePath: string
  readonly denyGlobals: ReadonlySet<string>
  readonly denyMemberExpressions: ReadonlySet<string>
  readonly denyImports: ReadonlySet<string>
}): Promise<WorkflowLintViolation[]> =>
  lintWorkflowSourceAst({
    ...options,
    sourceText: await readFile(options.filePath, 'utf8'),
  })
