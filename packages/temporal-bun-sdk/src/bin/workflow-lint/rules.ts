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
  readonly message: string
  readonly line: number
  readonly column: number
  readonly details?: Record<string, unknown>
}

const memberExpressionName = (
  tokens: readonly WorkflowSyntaxToken[],
  index: number,
): { name: string; token: WorkflowSyntaxToken } | undefined => {
  const objectToken = tokens[index]
  const previous = index > 0 ? tokens[index - 1] : undefined
  if (previous?.kind === SyntaxKind.DotToken || previous?.kind === SyntaxKind.QuestionDotToken) return undefined

  const dotToken = tokens[index + 1]
  const propertyToken = tokens[index + 2]
  if (
    isIdentifierLikeToken(objectToken) &&
    (dotToken?.kind === SyntaxKind.DotToken || dotToken?.kind === SyntaxKind.QuestionDotToken) &&
    isIdentifierLikeToken(propertyToken)
  ) {
    return { name: `${objectToken.text}.${propertyToken.text}`, token: objectToken }
  }

  const bracketIndex =
    tokens[index + 1]?.kind === SyntaxKind.QuestionDotToken && tokens[index + 2]?.kind === SyntaxKind.OpenBracketToken
      ? index + 2
      : index + 1
  const openBracketToken = tokens[bracketIndex]
  const elementToken = tokens[bracketIndex + 1]
  const closeBracketToken = tokens[bracketIndex + 2]
  if (
    isIdentifierLikeToken(objectToken) &&
    openBracketToken?.kind === SyntaxKind.OpenBracketToken &&
    elementToken?.kind === SyntaxKind.StringLiteral &&
    closeBracketToken?.kind === SyntaxKind.CloseBracketToken
  ) {
    return { name: `${objectToken.text}.${elementToken.value}`, token: objectToken }
  }

  return undefined
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
  if (previous?.kind !== SyntaxKind.EqualsToken) return false

  const statementStart = findStatementStartIndex(tokens, index, { lineBreaksAreBoundaries: false })
  for (let cursor = statementStart; cursor < index; cursor += 1) {
    const kind = tokens[cursor]?.kind
    if (kind === SyntaxKind.ConstKeyword || kind === SyntaxKind.LetKeyword || kind === SyntaxKind.VarKeyword)
      return true
  }

  return false
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

const isDeclarationLikeGlobalCallShape = (
  tokens: readonly WorkflowSyntaxToken[],
  index: number,
  previous: WorkflowSyntaxToken | undefined,
): boolean => {
  if (previous?.kind === SyntaxKind.FunctionKeyword) return true

  const closeParenIndex = findMatchingCloseParenIndex(tokens, index + 1)
  if (closeParenIndex == null) return false

  const afterCloseParen = tokens[closeParenIndex + 1]
  if (afterCloseParen?.kind === SyntaxKind.OpenBraceToken) return true
  if (afterCloseParen?.kind !== SyntaxKind.ColonToken) return false

  const statementStart = findStatementStartIndex(tokens, index, { lineBreaksAreBoundaries: false })
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

export const lintWorkflowModuleAst = async (options: {
  readonly filePath: string
  readonly denyGlobals: ReadonlySet<string>
  readonly denyMemberExpressions: ReadonlySet<string>
  readonly denyImports: ReadonlySet<string>
}): Promise<WorkflowLintViolation[]> => {
  const violations: WorkflowLintViolation[] = []
  const sourceText = await readFile(options.filePath, 'utf8')
  const tokens = scanWorkflowSyntaxTokens(sourceText)
  const positionOf = createWorkflowPositionResolver(sourceText)

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
    if (!isIdentifierLikeToken(token)) continue

    const previous = previousToken(tokens, index)
    const next = nextToken(tokens, index)
    const name = token.text

    if (options.denyGlobals.has(name)) {
      const isDirectGlobalCall = next?.kind === SyntaxKind.OpenParenToken
      const isOptionalGlobalCall =
        next?.kind === SyntaxKind.QuestionDotToken && tokens[index + 2]?.kind === SyntaxKind.OpenParenToken
      const isMemberCall = previous?.kind === SyntaxKind.DotToken || previous?.kind === SyntaxKind.QuestionDotToken

      const isDeclarationLikeGlobalCall =
        isDirectGlobalCall && isDeclarationLikeGlobalCallShape(tokens, index, previous)

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

      if (isRuntimeVariableInitializerCapture(tokens, index, previous)) {
        report(token.start, {
          rule: 'capture-global',
          message: `Capturing disallowed global in workflow module: const x = ${name}`,
          details: { global: name },
        })
      }
    }

    const member = memberExpressionName(tokens, index)
    if (!member) continue

    if (options.denyMemberExpressions.has(member.name) && !isTypeOnlyTypeofMemberExpression(tokens, index, previous)) {
      report(member.token.start, {
        rule: 'deny-member-expression',
        message: `Disallowed member expression in workflow module: ${member.name}`,
        details: { memberExpression: member.name },
      })
    }

    if (member.name === 'Bun.spawn' && options.denyGlobals.has('Bun.spawn')) {
      report(member.token.start, {
        rule: 'deny-global',
        message: 'Disallowed global in workflow module: Bun.spawn(...)',
        details: { global: 'Bun.spawn' },
      })
    }

    if (
      previous?.kind === SyntaxKind.EqualsToken &&
      (options.denyMemberExpressions.has(member.name) || member.name === 'Date.now')
    ) {
      report(member.token.start, {
        rule: 'capture-member-expression',
        message: `Capturing disallowed member expression in workflow module: const x = ${member.name}`,
        details: { memberExpression: member.name },
      })
    }
  }

  return violations
}
