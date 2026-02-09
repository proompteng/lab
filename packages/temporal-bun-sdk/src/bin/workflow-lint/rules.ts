import { readFile } from 'node:fs/promises'

import ts from 'typescript'

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

const positionOf = (sourceFile: ts.SourceFile, node: ts.Node) => {
  const start = node.getStart(sourceFile, false)
  const lc = sourceFile.getLineAndCharacterOfPosition(start)
  return { line: lc.line + 1, column: lc.character + 1 }
}

const isIdentifierNamed = (node: ts.Node, name: string): node is ts.Identifier =>
  ts.isIdentifier(node) && node.text === name

const isPropertyAccess = (node: ts.Node, base: string, prop: string): boolean =>
  ts.isPropertyAccessExpression(node) && isIdentifierNamed(node.expression, base) && node.name.text === prop

const isElementAccessLiteral = (node: ts.Node, base: string, prop: string): boolean =>
  ts.isElementAccessExpression(node) &&
  isIdentifierNamed(node.expression, base) &&
  ts.isStringLiteral(node.argumentExpression) &&
  node.argumentExpression.text === prop

export const lintWorkflowModuleAst = async (options: {
  readonly filePath: string
  readonly denyGlobals: ReadonlySet<string>
  readonly denyMemberExpressions: ReadonlySet<string>
  readonly denyImports: ReadonlySet<string>
}): Promise<WorkflowLintViolation[]> => {
  const violations: WorkflowLintViolation[] = []
  const sourceText = await readFile(options.filePath, 'utf8')
  const sourceFile = ts.createSourceFile(options.filePath, sourceText, ts.ScriptTarget.Latest, true)

  const report = (node: ts.Node, violation: Omit<WorkflowLintViolation, 'filePath' | 'line' | 'column'>) => {
    const { line, column } = positionOf(sourceFile, node)
    violations.push({
      filePath: options.filePath,
      line,
      column,
      ...violation,
    })
  }

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const module = node.moduleSpecifier
      if (module && ts.isStringLiteral(module) && options.denyImports.has(module.text)) {
        report(module, {
          rule: 'deny-import',
          message: `Disallowed import in workflow module: ${module.text}`,
          details: { specifier: module.text },
        })
      }
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      report(node, {
        rule: 'dynamic-import',
        message: 'Dynamic import() is not allowed in workflow modules',
      })
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text
      if (options.denyGlobals.has(name)) {
        report(node.expression, {
          rule: 'deny-global',
          message: `Disallowed global in workflow module: ${name}()`,
          details: { global: name },
        })
      }
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text
      if (options.denyGlobals.has(name)) {
        report(node.expression, {
          rule: 'deny-global',
          message: `Disallowed global in workflow module: new ${name}(...)`,
          details: { global: name },
        })
      }
    }

    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const fq = `${node.expression.text}.${node.name.text}`
      if (options.denyMemberExpressions.has(fq)) {
        report(node, {
          rule: 'deny-member-expression',
          message: `Disallowed member expression in workflow module: ${fq}`,
          details: { memberExpression: fq },
        })
      }
      if (fq === 'Bun.spawn' && options.denyGlobals.has('Bun.spawn')) {
        report(node, {
          rule: 'deny-global',
          message: 'Disallowed global in workflow module: Bun.spawn(...)',
          details: { global: 'Bun.spawn' },
        })
      }
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      const fq = `${node.expression.text}.${node.argumentExpression.text}`
      if (options.denyMemberExpressions.has(fq)) {
        report(node, {
          rule: 'deny-member-expression',
          message: `Disallowed member expression in workflow module: ${fq}`,
          details: { memberExpression: fq },
        })
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer
      if (ts.isIdentifier(init) && options.denyGlobals.has(init.text)) {
        report(init, {
          rule: 'capture-global',
          message: `Capturing disallowed global in workflow module: const x = ${init.text}`,
          details: { global: init.text },
        })
      }
      if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression)) {
        const fq = `${init.expression.text}.${init.name.text}`
        if (options.denyMemberExpressions.has(fq) || fq === 'Date.now') {
          report(init, {
            rule: 'capture-member-expression',
            message: `Capturing disallowed member expression in workflow module: const x = ${fq}`,
            details: { memberExpression: fq },
          })
        }
      }
      if (
        ts.isElementAccessExpression(init) &&
        ts.isIdentifier(init.expression) &&
        ts.isStringLiteral(init.argumentExpression)
      ) {
        const fq = `${init.expression.text}.${init.argumentExpression.text}`
        if (options.denyMemberExpressions.has(fq)) {
          report(init, {
            rule: 'capture-member-expression',
            message: `Capturing disallowed member expression in workflow module: const x = ${fq}`,
            details: { memberExpression: fq },
          })
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}
