import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'

import ts from 'typescript'

export type ImportEdge = {
  readonly from: string
  readonly specifier: string
  readonly resolved?: string
}

export type WorkflowLintGraph = {
  readonly entry: string
  readonly modules: ReadonlySet<string>
  readonly edges: readonly ImportEdge[]
}

export type WorkflowLintGraphViolation = {
  readonly filePath: string
  readonly rule: 'deny-import' | 'dynamic-import'
  readonly message: string
  readonly specifier?: string
}

const isRelative = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.'

const tryResolveFile = (baseDir: string, specifier: string): string | undefined => {
  const base = resolve(baseDir, specifier)
  const explicitExt = extname(base)
  if (explicitExt && existsSync(base)) {
    return base
  }

  const candidates = explicitExt
    ? [base]
    : [
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.mts`,
        `${base}.cts`,
        `${base}.js`,
        `${base}.jsx`,
        `${base}.mjs`,
        `${base}.cjs`,
        resolve(base, 'index.ts'),
        resolve(base, 'index.tsx'),
        resolve(base, 'index.mts'),
        resolve(base, 'index.cts'),
        resolve(base, 'index.js'),
        resolve(base, 'index.jsx'),
        resolve(base, 'index.mjs'),
        resolve(base, 'index.cjs'),
      ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return undefined
}

const collectImportSpecifiers = (sourceFile: ts.SourceFile): { specifiers: string[]; hasDynamicImport: boolean } => {
  const specifiers: string[] = []
  let hasDynamicImport = false

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const module = node.moduleSpecifier
      if (module && ts.isStringLiteral(module)) {
        specifiers.push(module.text)
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      hasDynamicImport = true
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { specifiers, hasDynamicImport }
}

export const buildWorkflowLintGraph = async (options: {
  readonly entry: string
  readonly cwd: string
  readonly denyImports: ReadonlySet<string>
}): Promise<{ graph: WorkflowLintGraph; violations: WorkflowLintGraphViolation[] }> => {
  const entryPath = resolve(options.cwd, options.entry)
  const seen = new Set<string>()
  const edges: ImportEdge[] = []
  const violations: WorkflowLintGraphViolation[] = []

  const queue: string[] = [entryPath]
  while (queue.length > 0) {
    const filePath = queue.shift()
    if (!filePath || seen.has(filePath)) {
      continue
    }
    seen.add(filePath)

    let sourceText: string
    try {
      sourceText = await readFile(filePath, 'utf8')
    } catch (_error) {
      violations.push({
        filePath,
        rule: 'deny-import',
        message: `Failed to read module: ${filePath}`,
      })
      continue
    }

    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)
    const { specifiers, hasDynamicImport } = collectImportSpecifiers(sourceFile)
    if (hasDynamicImport) {
      violations.push({
        filePath,
        rule: 'dynamic-import',
        message: 'Dynamic import() is not allowed in workflow modules',
      })
    }

    const baseDir = dirname(filePath)
    for (const specifier of specifiers) {
      edges.push({ from: filePath, specifier })

      if (!isRelative(specifier)) {
        if (options.denyImports.has(specifier)) {
          violations.push({
            filePath,
            rule: 'deny-import',
            specifier,
            message: `Disallowed import in workflow module: ${specifier}`,
          })
        }
        continue
      }

      const resolvedPath = tryResolveFile(baseDir, specifier)
      if (!resolvedPath) {
        // Unresolved relative imports are not necessarily fatal for linting (generated files, build artifacts, etc.)
        continue
      }
      edges[edges.length - 1] = { from: filePath, specifier, resolved: resolvedPath }
      if (!seen.has(resolvedPath)) {
        queue.push(resolvedPath)
      }
    }
  }

  return {
    graph: {
      entry: entryPath,
      modules: seen,
      edges,
    },
    violations,
  }
}
