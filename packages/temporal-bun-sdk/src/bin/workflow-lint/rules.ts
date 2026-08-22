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

const reflectiveGlobalPropertyAccessors = new Set(['Reflect.get', 'Object.getOwnPropertyDescriptor'])

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
  if (
    next?.kind === SyntaxKind.DotToken &&
    isIdentifierLikeToken(tokens[range.startIndex + 2]) &&
    range.startIndex + 2 === range.endIndex
  ) {
    return { kind: 'symbol' }
  }

  return undefined
}

const isSymbolUnshadowed = (tokens: readonly WorkflowSyntaxToken[]): boolean =>
  !tokens.some((token, index) => {
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

const collectStaticPropertyBindings = (
  tokens: readonly WorkflowSyntaxToken[],
  symbolIsUnshadowed: boolean,
): ReadonlyMap<string, StaticPropertyKey> => {
  const bindings = new Map<string, StaticPropertyBinding>()

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
  symbolIsUnshadowed: boolean,
): StaticPropertyKey | undefined => {
  const range = stripParentheses(tokens, startIndex, endIndex)
  const token = tokens[range.startIndex]
  if (range.startIndex === range.endIndex && isIdentifierLikeToken(token)) return bindings.get(token.text)
  return staticPropertyKeyAt(tokens, range.startIndex, range.endIndex, { symbolIsUnshadowed })
}

const computedMemberPropertyAtBracket = (
  tokens: readonly WorkflowSyntaxToken[],
  bracketIndex: number,
): { propertyStartIndex: number; propertyEndIndex: number; endIndex: number } | undefined => {
  if (tokens[bracketIndex]?.kind !== SyntaxKind.OpenBracketToken) return undefined

  let depth = 0
  for (let index = bracketIndex; index < tokens.length; index += 1) {
    const kind = tokens[index]?.kind
    if (kind === SyntaxKind.OpenBracketToken) depth += 1
    if (kind === SyntaxKind.CloseBracketToken) {
      depth -= 1
      if (depth === 0) {
        return { propertyStartIndex: bracketIndex + 1, propertyEndIndex: index - 1, endIndex: index }
      }
    }
  }

  return undefined
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
  const property = computedMemberPropertyAtBracket(tokens, bracketIndex)
  return property ? { object, ...property } : undefined
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
  readonly denyCapturedMemberProperties?: ReadonlySet<string>
}): WorkflowLintViolation[] => {
  const violations: WorkflowLintViolation[] = []
  const sourceText = options.sourceText
  const tokens = scanWorkflowSyntaxTokens(sourceText)
  const positionOf = createWorkflowPositionResolver(sourceText)
  const symbolIsUnshadowed = isSymbolUnshadowed(tokens)
  const staticPropertyBindings = collectStaticPropertyBindings(tokens, symbolIsUnshadowed)
  const reportedInvokedMemberProperties = new Set<number>()
  const safeReflectiveGlobalTargets = new Set<number>()

  const report = (position: number, violation: Omit<WorkflowLintViolation, 'filePath' | 'line' | 'column'>) => {
    const { line, column } = positionOf(position)
    violations.push({
      filePath: options.filePath,
      line,
      column,
      ...violation,
    })
  }

  const findInitializerEndIndex = (startIndex: number): number => {
    let parenthesisDepth = 0
    let bracketDepth = 0
    let braceDepth = 0
    for (let index = startIndex; index < tokens.length; index += 1) {
      const kind = tokens[index]?.kind
      if (
        (kind === SyntaxKind.CloseParenToken && parenthesisDepth === 0) ||
        (kind === SyntaxKind.CloseBracketToken && bracketDepth === 0) ||
        (kind === SyntaxKind.CloseBraceToken && braceDepth === 0)
      ) {
        return index - 1
      }
      if (
        parenthesisDepth === 0 &&
        bracketDepth === 0 &&
        braceDepth === 0 &&
        (kind === SyntaxKind.SemicolonToken || kind === SyntaxKind.CommaToken)
      ) {
        return index - 1
      }
      if (kind === SyntaxKind.OpenParenToken) parenthesisDepth += 1
      if (kind === SyntaxKind.CloseParenToken) parenthesisDepth -= 1
      if (kind === SyntaxKind.OpenBracketToken) bracketDepth += 1
      if (kind === SyntaxKind.CloseBracketToken) bracketDepth -= 1
      if (kind === SyntaxKind.OpenBraceToken) braceDepth += 1
      if (kind === SyntaxKind.CloseBraceToken) braceDepth -= 1
    }
    return tokens.length - 1
  }

  const findEnclosingScopeEndIndex = (index: number): number => {
    let nesting = 0
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const kind = tokens[cursor]?.kind
      if (kind === SyntaxKind.CloseBraceToken) {
        nesting += 1
        continue
      }
      if (kind !== SyntaxKind.OpenBraceToken) continue
      if (nesting > 0) {
        nesting -= 1
        continue
      }

      let forwardNesting = 0
      for (let end = cursor; end < tokens.length; end += 1) {
        const forwardKind = tokens[end]?.kind
        if (forwardKind === SyntaxKind.OpenBraceToken) forwardNesting += 1
        if (forwardKind === SyntaxKind.CloseBraceToken) {
          forwardNesting -= 1
          if (forwardNesting === 0) return end
        }
      }
      return tokens.length
    }
    return tokens.length
  }

  const capturedMemberPropertyAt = (
    startIndex: number,
    endIndex: number,
  ): { readonly property: string; readonly position: number } | undefined => {
    const range = stripParentheses(tokens, startIndex, endIndex)
    const safeCapturedMemberAccess = (expressionStartIndex: number, expressionEndIndex: number): boolean => {
      const previous = tokens[expressionStartIndex - 1]
      const next = tokens[expressionEndIndex + 1]
      const previousIsStrictComparison =
        previous?.kind === SyntaxKind.EqualsEqualsEqualsToken ||
        previous?.kind === SyntaxKind.ExclamationEqualsEqualsToken
      const nextIsStrictComparison =
        next?.kind === SyntaxKind.EqualsEqualsEqualsToken || next?.kind === SyntaxKind.ExclamationEqualsEqualsToken
      if (previousIsStrictComparison || nextIsStrictComparison) return true
      if (previous?.kind === SyntaxKind.TypeOfKeyword || previous?.kind === SyntaxKind.ExclamationToken) return true
      if (next?.kind === SyntaxKind.AmpersandAmpersandToken || next?.kind === SyntaxKind.QuestionToken) return true
      if (
        (next?.kind === SyntaxKind.DotToken || next?.kind === SyntaxKind.QuestionDotToken) &&
        tokens[expressionEndIndex + 2]?.text === 'name' &&
        !isAssignmentOperator(tokens[expressionEndIndex + 3]) &&
        !isInvokedMemberExpression(tokens, expressionEndIndex + 2)
      ) {
        return true
      }
      return false
    }

    const deferredRanges: Array<{ readonly startIndex: number; readonly endIndex: number }> = []

    const findMatchingDelimiterIndex = (
      openIndex: number,
      openKind: SyntaxKind,
      closeKind: SyntaxKind,
    ): number | undefined => {
      let depth = 0
      for (let cursor = openIndex; cursor <= range.endIndex; cursor += 1) {
        const kind = tokens[cursor]?.kind
        if (kind === openKind) depth += 1
        if (kind !== closeKind) continue
        depth -= 1
        if (depth === 0) return cursor
      }
      return undefined
    }

    const findMatchingOpenParenIndex = (closeIndex: number): number | undefined => {
      let depth = 0
      for (let cursor = closeIndex; cursor >= range.startIndex; cursor -= 1) {
        const kind = tokens[cursor]?.kind
        if (kind === SyntaxKind.CloseParenToken) depth += 1
        if (kind !== SyntaxKind.OpenParenToken) continue
        depth -= 1
        if (depth === 0) return cursor
      }
      return undefined
    }

    const tokenEndsExpression = (token: WorkflowSyntaxToken | undefined): boolean =>
      token?.kind === SyntaxKind.Identifier ||
      token?.kind === SyntaxKind.ThisKeyword ||
      token?.kind === SyntaxKind.SuperKeyword ||
      token?.kind === SyntaxKind.CloseParenToken ||
      token?.kind === SyntaxKind.CloseBracketToken ||
      token?.kind === SyntaxKind.CloseBraceToken ||
      token?.kind === SyntaxKind.StringLiteral ||
      token?.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
      token?.kind === SyntaxKind.NumericLiteral

    const functionExpressionIsInvoked = (expressionStartIndex: number, expressionEndIndex: number): boolean => {
      let start = expressionStartIndex
      let end = expressionEndIndex
      while (
        tokens[start - 1]?.kind === SyntaxKind.OpenParenToken &&
        tokens[end + 1]?.kind === SyntaxKind.CloseParenToken &&
        findMatchingCloseParenIndex(tokens, start - 1) === end + 1 &&
        !tokenEndsExpression(tokens[start - 2])
      ) {
        start -= 1
        end += 1
      }
      return isInvokedMemberExpression(tokens, end)
    }

    for (let cursor = range.startIndex; cursor <= range.endIndex; cursor += 1) {
      const kind = tokens[cursor]?.kind
      if (kind === SyntaxKind.FunctionKeyword) {
        for (let bodyStart = cursor + 1; bodyStart <= range.endIndex; bodyStart += 1) {
          if (tokens[bodyStart]?.kind !== SyntaxKind.OpenBraceToken) continue
          const bodyEnd = findMatchingDelimiterIndex(bodyStart, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken)
          if (bodyEnd != null && !functionExpressionIsInvoked(cursor, bodyEnd)) {
            deferredRanges.push({ startIndex: bodyStart + 1, endIndex: bodyEnd - 1 })
          }
          break
        }
        continue
      }
      if (kind !== SyntaxKind.EqualsGreaterThanToken) continue

      const parameterEnd = cursor - 1
      const expressionStart =
        tokens[parameterEnd]?.kind === SyntaxKind.CloseParenToken
          ? (findMatchingOpenParenIndex(parameterEnd) ?? parameterEnd)
          : parameterEnd
      const bodyStart = cursor + 1
      let bodyEnd = range.endIndex
      if (tokens[bodyStart]?.kind === SyntaxKind.OpenBraceToken) {
        bodyEnd =
          findMatchingDelimiterIndex(bodyStart, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken) ?? range.endIndex
      } else {
        let parenthesisDepth = 0
        let bracketDepth = 0
        let braceDepth = 0
        for (let bodyCursor = bodyStart; bodyCursor <= range.endIndex; bodyCursor += 1) {
          const bodyKind = tokens[bodyCursor]?.kind
          if (
            (bodyKind === SyntaxKind.CloseParenToken && parenthesisDepth === 0) ||
            (bodyKind === SyntaxKind.CloseBracketToken && bracketDepth === 0) ||
            (bodyKind === SyntaxKind.CloseBraceToken && braceDepth === 0) ||
            ((bodyKind === SyntaxKind.CommaToken || bodyKind === SyntaxKind.SemicolonToken) &&
              parenthesisDepth === 0 &&
              bracketDepth === 0 &&
              braceDepth === 0)
          ) {
            bodyEnd = bodyCursor - 1
            break
          }
          if (bodyKind === SyntaxKind.OpenParenToken) parenthesisDepth += 1
          if (bodyKind === SyntaxKind.CloseParenToken) parenthesisDepth -= 1
          if (bodyKind === SyntaxKind.OpenBracketToken) bracketDepth += 1
          if (bodyKind === SyntaxKind.CloseBracketToken) bracketDepth -= 1
          if (bodyKind === SyntaxKind.OpenBraceToken) braceDepth += 1
          if (bodyKind === SyntaxKind.CloseBraceToken) braceDepth -= 1
        }
      }

      if (!functionExpressionIsInvoked(expressionStart, bodyEnd)) {
        deferredRanges.push({ startIndex: bodyStart, endIndex: bodyEnd })
      }
    }

    const isDeferred = (index: number): boolean =>
      deferredRanges.some((deferredRange) => index >= deferredRange.startIndex && index <= deferredRange.endIndex)

    for (let cursor = range.startIndex; cursor <= range.endIndex; cursor += 1) {
      if (isDeferred(cursor)) continue
      const token = tokens[cursor]
      const previous = tokens[cursor - 1]
      if (
        isIdentifierLikeToken(token) &&
        (previous?.kind === SyntaxKind.DotToken || previous?.kind === SyntaxKind.QuestionDotToken) &&
        options.denyCapturedMemberProperties?.has(token.text)
      ) {
        const objectToken = tokens[cursor - 2]
        const expressionStartIndex = isIdentifierLikeToken(objectToken) ? cursor - 2 : cursor
        if (safeCapturedMemberAccess(expressionStartIndex, cursor)) continue
        return { property: token.text, position: token.start }
      }

      if (token?.kind !== SyntaxKind.OpenBracketToken) continue
      const optionalMember = previous?.kind === SyntaxKind.QuestionDotToken
      const objectEnd = tokens[optionalMember ? cursor - 2 : cursor - 1]
      const followsExpression =
        objectEnd?.kind === SyntaxKind.CloseParenToken ||
        objectEnd?.kind === SyntaxKind.CloseBracketToken ||
        objectEnd?.kind === SyntaxKind.CloseBraceToken ||
        objectEnd?.kind === SyntaxKind.StringLiteral ||
        objectEnd?.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
        isIdentifierLikeToken(objectEnd)
      if (!followsExpression) continue

      const computedProperty = computedMemberPropertyAtBracket(tokens, cursor)
      if (!computedProperty || computedProperty.endIndex > range.endIndex) continue
      const property = resolveStaticPropertyKey(
        tokens,
        computedProperty.propertyStartIndex,
        computedProperty.propertyEndIndex,
        staticPropertyBindings,
        symbolIsUnshadowed,
      )
      const computedPropertyToken = tokens[computedProperty.propertyStartIndex]
      if (
        property?.kind === 'string' &&
        options.denyCapturedMemberProperties?.has(property.value) &&
        computedPropertyToken
      ) {
        const expressionStartIndex = isIdentifierLikeToken(objectEnd)
          ? optionalMember
            ? cursor - 2
            : cursor - 1
          : cursor
        if (safeCapturedMemberAccess(expressionStartIndex, computedProperty.endIndex)) continue
        return { property: property.value, position: computedPropertyToken.start }
      }
    }
    return undefined
  }

  const safeCapturedMemberReference = (index: number): boolean => {
    const previous = tokens[index - 1]
    let expressionEndIndex = index
    while (expressionEndIndex < tokens.length - 1) {
      const separator = tokens[expressionEndIndex + 1]
      if (
        (separator?.kind === SyntaxKind.DotToken || separator?.kind === SyntaxKind.QuestionDotToken) &&
        isIdentifierLikeToken(tokens[expressionEndIndex + 2])
      ) {
        expressionEndIndex += 2
        continue
      }

      const bracketIndex =
        separator?.kind === SyntaxKind.QuestionDotToken &&
        tokens[expressionEndIndex + 2]?.kind === SyntaxKind.OpenBracketToken
          ? expressionEndIndex + 2
          : separator?.kind === SyntaxKind.OpenBracketToken
            ? expressionEndIndex + 1
            : undefined
      if (bracketIndex == null) break
      const computedProperty = computedMemberPropertyAtBracket(tokens, bracketIndex)
      if (!computedProperty) break
      expressionEndIndex = computedProperty.endIndex
    }

    const next = tokens[expressionEndIndex + 1]
    const previousIsStrictComparison =
      previous?.kind === SyntaxKind.EqualsEqualsEqualsToken ||
      previous?.kind === SyntaxKind.ExclamationEqualsEqualsToken
    const nextIsStrictComparison =
      next?.kind === SyntaxKind.EqualsEqualsEqualsToken || next?.kind === SyntaxKind.ExclamationEqualsEqualsToken
    if (previousIsStrictComparison || nextIsStrictComparison) return true
    if (previous?.kind === SyntaxKind.TypeOfKeyword || previous?.kind === SyntaxKind.ExclamationToken) return true
    if (next?.kind === SyntaxKind.AmpersandAmpersandToken || next?.kind === SyntaxKind.QuestionToken) return true
    if (
      tokens[expressionEndIndex]?.text === 'name' &&
      !isAssignmentOperator(tokens[expressionEndIndex + 1]) &&
      !isInvokedMemberExpression(tokens, expressionEndIndex)
    ) {
      return true
    }
    return false
  }

  const findBindingPatternEndIndex = (openIndex: number): number | undefined => {
    const openKind = tokens[openIndex]?.kind
    const closeKind =
      openKind === SyntaxKind.OpenBraceToken
        ? SyntaxKind.CloseBraceToken
        : openKind === SyntaxKind.OpenBracketToken
          ? SyntaxKind.CloseBracketToken
          : undefined
    if (closeKind == null) return undefined

    let depth = 0
    for (let cursor = openIndex; cursor < tokens.length; cursor += 1) {
      const kind = tokens[cursor]?.kind
      if (kind === openKind) depth += 1
      if (kind !== closeKind) continue
      depth -= 1
      if (depth === 0) return cursor
    }
    return undefined
  }

  const findBindingElementEndIndex = (startIndex: number, containerEndIndex: number): number => {
    let parenthesisDepth = 0
    let bracketDepth = 0
    let braceDepth = 0
    for (let cursor = startIndex; cursor < containerEndIndex; cursor += 1) {
      const kind = tokens[cursor]?.kind
      if (kind === SyntaxKind.CommaToken && parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return cursor - 1
      }
      if (kind === SyntaxKind.OpenParenToken) parenthesisDepth += 1
      if (kind === SyntaxKind.CloseParenToken) parenthesisDepth -= 1
      if (kind === SyntaxKind.OpenBracketToken) bracketDepth += 1
      if (kind === SyntaxKind.CloseBracketToken) bracketDepth -= 1
      if (kind === SyntaxKind.OpenBraceToken) braceDepth += 1
      if (kind === SyntaxKind.CloseBraceToken) braceDepth -= 1
    }
    return containerEndIndex - 1
  }

  type DestructuredMemberCapture = {
    readonly binding: WorkflowSyntaxToken
    readonly property: string
    readonly position: number
  }

  type DestructuredBindingScan = {
    readonly bindings: WorkflowSyntaxToken[]
    readonly captures: DestructuredMemberCapture[]
  }

  const collectDestructuredMemberCaptures = (
    patternStartIndex: number,
    patternEndIndex: number,
  ): DestructuredBindingScan => {
    const bindings: WorkflowSyntaxToken[] = []
    const captures: DestructuredMemberCapture[] = []
    const patternKind = tokens[patternStartIndex]?.kind

    for (let cursor = patternStartIndex + 1; cursor < patternEndIndex; ) {
      if (tokens[cursor]?.kind === SyntaxKind.CommaToken) {
        cursor += 1
        continue
      }

      const elementEndIndex = findBindingElementEndIndex(cursor, patternEndIndex)
      if (tokens[cursor]?.kind === SyntaxKind.DotDotDotToken) {
        const restBinding = tokens[cursor + 1]
        if (isIdentifierLikeToken(restBinding)) bindings.push(restBinding)
        cursor = elementEndIndex + 2
        continue
      }

      if (patternKind === SyntaxKind.OpenBracketToken) {
        const binding = tokens[cursor]
        if (isIdentifierLikeToken(binding)) bindings.push(binding)
        const nestedPatternEndIndex = findBindingPatternEndIndex(cursor)
        if (nestedPatternEndIndex != null && nestedPatternEndIndex <= elementEndIndex) {
          const nested = collectDestructuredMemberCaptures(cursor, nestedPatternEndIndex)
          bindings.push(...nested.bindings)
          captures.push(...nested.captures)
        }
        cursor = elementEndIndex + 2
        continue
      }

      const propertyToken = tokens[cursor]
      let propertyEndIndex = cursor
      let property: string | undefined
      let propertyPosition = propertyToken?.start

      if (propertyToken?.kind === SyntaxKind.OpenBracketToken) {
        const computedProperty = computedMemberPropertyAtBracket(tokens, cursor)
        if (!computedProperty || computedProperty.endIndex > elementEndIndex) {
          cursor = elementEndIndex + 2
          continue
        }
        propertyEndIndex = computedProperty.endIndex
        propertyPosition = tokens[computedProperty.propertyStartIndex]?.start ?? propertyToken.start
        const resolvedProperty = resolveStaticPropertyKey(
          tokens,
          computedProperty.propertyStartIndex,
          computedProperty.propertyEndIndex,
          staticPropertyBindings,
          symbolIsUnshadowed,
        )
        if (resolvedProperty?.kind === 'string') property = resolvedProperty.value
        if (!resolvedProperty) property = '[...]'
      } else if (propertyToken?.kind === SyntaxKind.StringLiteral) {
        property = propertyToken.value
      } else if (isIdentifierLikeToken(propertyToken)) {
        property = propertyToken.text
      }

      const hasDeniedProperty = property === '[...]' || options.denyCapturedMemberProperties?.has(property ?? '')
      const colonIndex = propertyEndIndex + 1
      const hasAlias = tokens[colonIndex]?.kind === SyntaxKind.ColonToken
      const bindingStartIndex = hasAlias ? colonIndex + 1 : cursor
      const binding = tokens[bindingStartIndex]

      if (isIdentifierLikeToken(binding)) bindings.push(binding)
      if (hasDeniedProperty && isIdentifierLikeToken(binding) && propertyPosition != null) {
        captures.push({ binding, property: property ?? '[...]', position: propertyPosition })
      }

      if (hasAlias && (binding?.kind === SyntaxKind.OpenBraceToken || binding?.kind === SyntaxKind.OpenBracketToken)) {
        const nestedPatternEndIndex = findBindingPatternEndIndex(bindingStartIndex)
        if (nestedPatternEndIndex != null && nestedPatternEndIndex <= elementEndIndex) {
          const nested = collectDestructuredMemberCaptures(bindingStartIndex, nestedPatternEndIndex)
          bindings.push(...nested.bindings)
          captures.push(...nested.captures)
        }
      }

      cursor = elementEndIndex + 2
    }

    return { bindings, captures }
  }

  if (options.denyCapturedMemberProperties) {
    const processedBindingPatterns = new Set<number>()
    const reportedCaptures = new Set<string>()
    for (let index = 0; index < tokens.length; index += 1) {
      const declaration = tokens[index]
      const standaloneBindingPattern =
        declaration?.kind === SyntaxKind.OpenBraceToken || declaration?.kind === SyntaxKind.OpenBracketToken
      const bindingIndex = isVariableDeclarationKeyword(declaration)
        ? index + 1
        : standaloneBindingPattern
          ? index
          : undefined
      if (bindingIndex == null) continue

      const binding = tokens[bindingIndex]
      if (!binding || processedBindingPatterns.has(binding.start)) continue

      const patternEndIndex =
        binding.kind === SyntaxKind.OpenBraceToken || binding.kind === SyntaxKind.OpenBracketToken
          ? findBindingPatternEndIndex(bindingIndex)
          : undefined
      const bindingEndIndex = patternEndIndex ?? bindingIndex
      if (tokens[bindingEndIndex + 1]?.kind !== SyntaxKind.EqualsToken) continue
      processedBindingPatterns.add(binding.start)

      const initializerStartIndex = bindingEndIndex + 2
      const initializerEndIndex = findInitializerEndIndex(initializerStartIndex)
      const capturedBindings: DestructuredMemberCapture[] = []
      if (isIdentifierLikeToken(binding)) {
        const capturedProperty = capturedMemberPropertyAt(initializerStartIndex, initializerEndIndex)
        if (capturedProperty) {
          capturedBindings.push({ binding, ...capturedProperty })
        }
      } else if (patternEndIndex != null) {
        const bindingScan = collectDestructuredMemberCaptures(bindingIndex, patternEndIndex)
        capturedBindings.push(...bindingScan.captures)
        const capturedInitializerProperty = capturedMemberPropertyAt(initializerStartIndex, initializerEndIndex)
        if (capturedInitializerProperty) {
          for (const destructuredBinding of bindingScan.bindings) {
            if (bindingScan.captures.some((capture) => capture.binding.start === destructuredBinding.start)) continue
            capturedBindings.push({ binding: destructuredBinding, ...capturedInitializerProperty })
          }
        }
      }
      if (capturedBindings.length === 0) continue

      const scopeEndIndex = findEnclosingScopeEndIndex(index)
      for (const capturedBinding of capturedBindings) {
        let unsafeReference = false
        for (let cursor = initializerEndIndex + 1; cursor < scopeEndIndex; cursor += 1) {
          const reference = tokens[cursor]
          if (!isIdentifierLikeToken(reference) || reference.text !== capturedBinding.binding.text) continue
          const previous = tokens[cursor - 1]
          if (
            isVariableDeclarationKeyword(previous) ||
            previous?.kind === SyntaxKind.FunctionKeyword ||
            previous?.kind === SyntaxKind.ClassKeyword ||
            previous?.kind === SyntaxKind.DotToken ||
            previous?.kind === SyntaxKind.QuestionDotToken
          ) {
            continue
          }
          if (!safeCapturedMemberReference(cursor)) {
            unsafeReference = true
            break
          }
        }
        if (!unsafeReference) continue

        const captureKey = `${capturedBinding.position}:${capturedBinding.binding.start}`
        if (reportedCaptures.has(captureKey)) continue
        reportedCaptures.add(captureKey)

        report(capturedBinding.position, {
          rule: 'capture-member-expression',
          message: `Capturing disallowed member property in workflow module: const ${capturedBinding.binding.text} = object.${capturedBinding.property}`,
          details: { memberProperty: capturedBinding.property, binding: capturedBinding.binding.text },
        })
      }
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if (!isIdentifierLikeToken(tokens[index])) continue
    const member = memberExpressionName(tokens, index)
    if (!member || !reflectiveGlobalPropertyAccessors.has(member.name)) continue
    const reflectiveAccess = reflectivelyAccessedGlobalProperty(tokens, member.endIndex)
    const deniedReflectiveProperties = reflectiveAccess
      ? options.denyReflectiveGlobalProperties?.get(reflectiveAccess.target.text)
      : undefined
    if (!reflectiveAccess || !deniedReflectiveProperties) continue
    const property = resolveStaticPropertyKey(
      tokens,
      reflectiveAccess.propertyStartIndex,
      reflectiveAccess.propertyEndIndex,
      staticPropertyBindings,
      symbolIsUnshadowed,
    )
    if (property && (property.kind !== 'string' || !deniedReflectiveProperties.has(property.value))) {
      safeReflectiveGlobalTargets.add(reflectiveAccess.target.start)
    }
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
    if (token.kind === SyntaxKind.OpenBracketToken && options.denyInvokedMemberProperties) {
      const optionalMember = previousToken(tokens, index)?.kind === SyntaxKind.QuestionDotToken
      const objectEndIndex = optionalMember ? index - 2 : index - 1
      const objectEnd = tokens[objectEndIndex]
      // Parenthesized inline receivers include function expressions such as (() => {})[key](...).
      // Fail closed when their invoked key cannot be resolved; known dynamic dispatch on application
      // objects remains valid and is protected by the workflow runtime's code-generation guards.
      const inlineObject = objectEnd?.kind === SyntaxKind.CloseParenToken
      const followsExpression =
        objectEnd?.kind === SyntaxKind.CloseParenToken ||
        objectEnd?.kind === SyntaxKind.CloseBracketToken ||
        objectEnd?.kind === SyntaxKind.StringLiteral ||
        objectEnd?.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
        isIdentifierLikeToken(objectEnd)
      const computedProperty = followsExpression ? computedMemberPropertyAtBracket(tokens, index) : undefined
      if (computedProperty && isInvokedMemberExpression(tokens, computedProperty.endIndex)) {
        const property = resolveStaticPropertyKey(
          tokens,
          computedProperty.propertyStartIndex,
          computedProperty.propertyEndIndex,
          staticPropertyBindings,
          symbolIsUnshadowed,
        )
        const propertyToken = tokens[computedProperty.propertyStartIndex]
        if (
          ((!property && inlineObject) ||
            (property?.kind === 'string' && options.denyInvokedMemberProperties.has(property.value))) &&
          propertyToken &&
          !reportedInvokedMemberProperties.has(propertyToken.start)
        ) {
          reportedInvokedMemberProperties.add(propertyToken.start)
          report(propertyToken.start, {
            rule: 'deny-member-expression',
            message: property
              ? `Disallowed invoked member property in workflow module: ${property.value}`
              : 'Unable to prove invoked member property safe in workflow module: object[...]()',
            details: { memberProperty: property?.kind === 'string' ? property.value : '[...]' },
          })
        }
      }
    }
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

    if (options.denyGlobalCaptures?.has(name)) {
      const directMemberAccess =
        next?.kind === SyntaxKind.DotToken ||
        next?.kind === SyntaxKind.QuestionDotToken ||
        next?.kind === SyntaxKind.OpenBracketToken
      const memberProperty = previous?.kind === SyntaxKind.DotToken || previous?.kind === SyntaxKind.QuestionDotToken
      const safeInspection = previous?.kind === SyntaxKind.InKeyword || previous?.kind === SyntaxKind.TypeOfKeyword
      const safeReflectiveTarget = safeReflectiveGlobalTargets.has(token.start)
      const declarationName =
        next?.kind === SyntaxKind.ColonToken ||
        (next?.kind === SyntaxKind.SemicolonToken && isStatementBoundary(previous))
      if (!directMemberAccess && !memberProperty && !safeInspection && !safeReflectiveTarget && !declarationName) {
        const directCapture = isDirectRuntimeVariableInitializerCapture(tokens, index, previous)
        report(token.start, {
          rule: 'capture-global',
          message: directCapture
            ? `Capturing disallowed global in workflow module: const x = ${name}`
            : `Disallowed global object escape in workflow module: ${name}`,
          details: { global: name },
        })
      }
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
        symbolIsUnshadowed,
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
        symbolIsUnshadowed,
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
          message: property
            ? `Disallowed invoked member property in workflow module: ${property.value}`
            : 'Unable to prove invoked member property safe in workflow module: object[...]()',
          details: { memberProperty: property?.kind === 'string' ? property.value : '[...]' },
        })
      }
    }

    if (!member) continue

    if (reflectiveGlobalPropertyAccessors.has(member.name)) {
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
          symbolIsUnshadowed,
        )
        if (!property || (property.kind === 'string' && deniedReflectiveProperties.has(property.value))) {
          report(member.token.start, {
            rule: 'deny-member-expression',
            message: property
              ? `Disallowed reflective global access in workflow module: ${member.name}(${reflectiveAccess.target.text}, '${property.value}')`
              : `Unable to prove reflective global property safe in workflow module: ${member.name}(${reflectiveAccess.target.text}, ...)`,
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
