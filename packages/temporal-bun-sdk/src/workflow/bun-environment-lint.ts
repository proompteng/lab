import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { lintWorkflowSourceAst, type WorkflowLintViolation } from '../bin/workflow-lint/rules'
import {
  collectWorkflowMacroImports,
  collectWorkflowModuleSpecifiers,
  createWorkflowPositionResolver,
  scanWorkflowSyntaxTokens,
} from '../bin/workflow-lint/syntax-scan'
import type { WorkflowDefinitions } from './definition'

const bunEnvironmentGlobalObjects = ['globalThis', 'global', 'self'] as const
const bunEnvironmentGlobalObjectProperties = [
  'Bun',
  'eval',
  'Function',
  'globalThis',
  'global',
  'self',
  'window',
  'valueOf',
  'process',
  'require',
  'module',
  'Worker',
] as const
const bunEnvironmentDenyGlobals = new Set(['Bun', 'eval', 'Function', 'require', 'Worker'])
const bunEnvironmentDenyMemberExpressions = new Set([
  'Bun.env',
  'import.meta',
  'import.meta.env',
  'import.meta.require',
  'process.binding',
  'process._linkedBinding',
  'process.dlopen',
  'process.getBuiltinModule',
  'process.loadEnvFile',
  'process.mainModule',
  'process.report',
  'process.valueOf',
  'module.require',
  'module.valueOf',
  ...bunEnvironmentGlobalObjects.flatMap((object) =>
    bunEnvironmentGlobalObjectProperties.map((property) => `${object}.${property}`),
  ),
])
const bunEnvironmentDenyGlobalObjectProperties = new Map([
  ...bunEnvironmentGlobalObjects.map(
    (object) => [object, new Set<string>(bunEnvironmentGlobalObjectProperties)] as const,
  ),
  [
    'process',
    new Set([
      'binding',
      '_linkedBinding',
      'dlopen',
      'getBuiltinModule',
      'loadEnvFile',
      'mainModule',
      'report',
      'valueOf',
    ]),
  ] as const,
  ['module', new Set(['require', 'valueOf'])] as const,
])
const bunEnvironmentDenyGlobalCaptures = new Set([...bunEnvironmentGlobalObjects, 'process', 'module'])
const bunEnvironmentDenyIndirectGlobalReferences = new Set(['eval', 'Function', 'require'])
const bunEnvironmentAllowIndirectGlobalMemberExpressions = new Set(['Function.prototype.apply'])
const bunEnvironmentDenyInvokedMemberProperties = new Set(['constructor'])
const bunEnvironmentDenyCapturedMemberProperties = new Set(['constructor'])
const bunEnvironmentDenyImports = new Set([
  'bun',
  'bun:ffi',
  'node:vm',
  'vm',
  'node:module',
  'module',
  'node:process',
  'process',
  'node:fs',
  'node:fs/promises',
  'fs',
  'fs/promises',
  'node:os',
  'os',
  'node:child_process',
  'child_process',
  'node:cluster',
  'cluster',
  'node:worker_threads',
  'worker_threads',
])
const inspectableWorkflowSourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
// Bundle every application module so activity imports cannot seed workflow state. Keep only the
// workflow SDK and Effect external to preserve their process-wide runtime/AsyncLocalStorage identity.
const isolatedWorkflowRuntimeImports = /^(?:@proompteng\/temporal-bun-sdk(?:\/.*)?|effect(?:\/.*)?)$/
const isolatedWorkflowRuntimeExternals = [
  '@proompteng/temporal-bun-sdk',
  '@proompteng/temporal-bun-sdk/*',
  'effect',
  'effect/*',
] as const
const couldContainMacroImport = (sourceText: string): boolean =>
  /\b(?:with|assert)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*\{/.test(sourceText)
const workflowSourceLoader = (filePath: string): 'ts' | 'tsx' | 'js' | 'jsx' => {
  const extension = extname(filePath)
  if (extension === '.tsx') return 'tsx'
  if (extension === '.jsx') return 'jsx'
  if (extension === '.ts' || extension === '.mts' || extension === '.cts') return 'ts'
  return 'js'
}

const lintWorkflowMacroImports = async (entry: string): Promise<readonly WorkflowLintViolation[]> => {
  const queue = [entry]
  const scheduled = new Set(queue)
  const violations: WorkflowLintViolation[] = []

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const filePath = queue[queueIndex]
    if (!filePath) continue

    let sourceText: string
    try {
      sourceText = await readFile(filePath, 'utf8')
    } catch (error) {
      violations.push({
        filePath,
        rule: 'unresolved-import',
        message: `Unable to inspect workflow source before bundling: ${error instanceof Error ? error.message : String(error)}`,
        line: 1,
        column: 1,
      })
      continue
    }

    const inspectImportAttributes = couldContainMacroImport(sourceText)
    const moduleSpecifiers: string[] = []
    if (inspectImportAttributes) {
      let tokens: ReturnType<typeof scanWorkflowSyntaxTokens>
      try {
        tokens = scanWorkflowSyntaxTokens(sourceText)
      } catch (error) {
        violations.push({
          filePath,
          rule: 'unresolved-import',
          message: `Unable to scan workflow source for Bun macro imports: ${error instanceof Error ? error.message : String(error)}`,
          line: 1,
          column: 1,
        })
        continue
      }
      const positionOf = createWorkflowPositionResolver(sourceText)
      for (const macroImport of collectWorkflowMacroImports(tokens)) {
        const { line, column } = positionOf(macroImport.start)
        violations.push({
          filePath,
          rule: 'deny-import',
          message: `Bun macro imports are not allowed in workflow modules: ${macroImport.specifier}`,
          line,
          column,
          details: { specifier: macroImport.specifier, importAttribute: 'macro' },
        })
      }
      moduleSpecifiers.push(
        ...collectWorkflowModuleSpecifiers(tokens)
          .filter((moduleSpecifier) => !moduleSpecifier.typeOnly)
          .map((moduleSpecifier) => moduleSpecifier.specifier),
      )
    }

    try {
      moduleSpecifiers.push(
        ...new Bun.Transpiler({ loader: workflowSourceLoader(filePath) })
          .scanImports(sourceText)
          .filter(
            (moduleImport) =>
              moduleImport.kind === 'require-call' ||
              moduleImport.kind === 'dynamic-import' ||
              (!inspectImportAttributes && moduleImport.kind === 'import-statement'),
          )
          .map((moduleImport) => moduleImport.path),
      )
    } catch (error) {
      violations.push({
        filePath,
        rule: 'unresolved-import',
        message: `Unable to scan workflow source imports: ${error instanceof Error ? error.message : String(error)}`,
        line: 1,
        column: 1,
      })
      continue
    }

    for (const moduleSpecifier of moduleSpecifiers) {
      let resolvedPath: string
      try {
        resolvedPath = Bun.resolveSync(moduleSpecifier, dirname(filePath))
      } catch {
        // Bun.build below owns unresolved-import diagnostics. This pass only prevents macro execution.
        continue
      }
      if (
        !isAbsolute(resolvedPath) ||
        !inspectableWorkflowSourceExtensions.has(extname(resolvedPath)) ||
        scheduled.has(resolvedPath)
      ) {
        continue
      }
      scheduled.add(resolvedPath)
      queue.push(resolvedPath)
    }
  }

  return violations
}

const bundleDiagnosticViolation = (entry: string, diagnostic: unknown): WorkflowLintViolation => {
  const details = diagnostic as {
    readonly message?: unknown
    readonly specifier?: unknown
    readonly position?: { readonly file?: unknown; readonly line?: unknown; readonly column?: unknown }
  }
  const specifier = typeof details.specifier === 'string' ? details.specifier : undefined
  const position = details.position
  return {
    filePath: typeof position?.file === 'string' ? position.file : entry,
    rule: 'unresolved-import',
    message: `Unable to bundle workflow source for safety inspection: ${
      typeof details.message === 'string' ? details.message : String(diagnostic)
    }`,
    line: typeof position?.line === 'number' ? position.line : 1,
    column: typeof position?.column === 'number' ? position.column : 1,
    ...(specifier ? { details: { specifier } } : {}),
  }
}

export type WorkflowBunEnvironmentBundle = {
  readonly entry: string
  readonly sourceText: string
}

type WorkflowBunEnvironmentInspection = {
  readonly violations: readonly WorkflowLintViolation[]
  readonly bundle?: WorkflowBunEnvironmentBundle
}

const rewriteIsolatedWorkflowRuntimeImports = (sourceText: string, entry: string): string => {
  const replacements = collectWorkflowModuleSpecifiers(scanWorkflowSyntaxTokens(sourceText))
    .filter((moduleSpecifier) => isolatedWorkflowRuntimeImports.test(moduleSpecifier.specifier))
    .map((moduleSpecifier) => ({
      ...moduleSpecifier,
      resolvedSpecifier: pathToFileURL(Bun.resolveSync(moduleSpecifier.specifier, dirname(entry))).href,
    }))
    .sort((left, right) => right.start - left.start)

  let rewritten = sourceText
  for (const replacement of replacements) {
    rewritten = `${rewritten.slice(0, replacement.start)}${JSON.stringify(replacement.resolvedSpecifier)}${rewritten.slice(replacement.end)}`
  }
  return rewritten
}

export class WorkflowBunEnvironmentSafetyError extends Error {
  readonly violations: readonly WorkflowLintViolation[]

  constructor(message: string, violations: readonly WorkflowLintViolation[] = []) {
    super(message)
    this.name = 'WorkflowBunEnvironmentSafetyError'
    this.violations = violations
  }
}

const inspectWorkflowBunEnvironmentSafety = async (options: {
  readonly workflowsPath: string
  readonly cwd?: string
}): Promise<WorkflowBunEnvironmentInspection> => {
  const cwd = options.cwd ?? process.cwd()
  const entry = resolve(cwd, options.workflowsPath)
  const macroViolations = await lintWorkflowMacroImports(entry)
  if (macroViolations.length > 0) return { violations: macroViolations }

  let build: Awaited<ReturnType<typeof Bun.build>>
  try {
    build = await Bun.build({
      entrypoints: [entry],
      root: cwd,
      target: 'bun',
      format: 'esm',
      packages: 'bundle',
      external: [...isolatedWorkflowRuntimeExternals],
      splitting: false,
      env: 'disable',
      treeShaking: true,
      ignoreDCEAnnotations: true,
      // Renaming local bindings lets the scanner distinguish Bun's global-object aliases
      // (`globalThis`, `global`, and `self`) from application parameters with the same names.
      minify: { identifiers: true, syntax: false, whitespace: false },
      sourcemap: 'none',
      allowUnresolved: [],
    })
  } catch (error) {
    const diagnostics = (error as { readonly errors?: unknown })?.errors
    return {
      violations:
        Array.isArray(diagnostics) && diagnostics.length > 0
          ? diagnostics.map((diagnostic) => bundleDiagnosticViolation(entry, diagnostic))
          : [bundleDiagnosticViolation(entry, error)],
    }
  }

  if (!build.success) {
    const logs = build.logs.length > 0 ? build.logs : ['Unknown workflow bundle failure']
    return { violations: logs.map((log) => bundleDiagnosticViolation(entry, log)) }
  }

  const entryOutputs = build.outputs.filter((output) => output.kind === 'entry-point')
  const unsupportedOutputs = build.outputs.filter((output) => output.kind !== 'entry-point')
  if (entryOutputs.length !== 1 || unsupportedOutputs.length > 0) {
    const detail = unsupportedOutputs.map((output) => output.path).join(', ')
    return {
      violations: [
        {
          filePath: entry,
          rule: 'unresolved-import',
          message:
            unsupportedOutputs.length > 0
              ? `Workflow bundle contains uninspectable outputs: ${detail}`
              : `Workflow bundle produced ${entryOutputs.length} entry outputs; expected exactly one`,
          line: 1,
          column: 1,
        },
      ],
    }
  }

  let sourceText: string
  try {
    sourceText = rewriteIsolatedWorkflowRuntimeImports(await entryOutputs[0]!.text(), entry)
  } catch (error) {
    return { violations: [bundleDiagnosticViolation(entry, error)] }
  }

  return {
    violations: lintWorkflowSourceAst({
      filePath: entry,
      sourceText,
      denyGlobals: bunEnvironmentDenyGlobals,
      denyMemberExpressions: bunEnvironmentDenyMemberExpressions,
      denyImports: bunEnvironmentDenyImports,
      denyReflectiveGlobalProperties: bunEnvironmentDenyGlobalObjectProperties,
      denyComputedGlobalProperties: bunEnvironmentDenyGlobalObjectProperties,
      denyGlobalCaptures: bunEnvironmentDenyGlobalCaptures,
      denyIndirectGlobalReferences: bunEnvironmentDenyIndirectGlobalReferences,
      allowIndirectGlobalMemberExpressions: bunEnvironmentAllowIndirectGlobalMemberExpressions,
      denyInvokedMemberProperties: bunEnvironmentDenyInvokedMemberProperties,
      denyCapturedMemberProperties: bunEnvironmentDenyCapturedMemberProperties,
    }),
    bundle: { entry, sourceText },
  }
}

export const lintWorkflowBunEnvironmentSafety = async (options: {
  readonly workflowsPath: string
  readonly cwd?: string
}): Promise<readonly WorkflowLintViolation[]> => (await inspectWorkflowBunEnvironmentSafety(options)).violations

const throwWorkflowBunEnvironmentSafetyError = (violations: readonly WorkflowLintViolation[], cwd: string): never => {
  const details = violations
    .slice(0, 10)
    .map(
      (violation) => `${relative(cwd, violation.filePath)}:${violation.line}:${violation.column} ${violation.message}`,
    )
    .join('\n')
  const remainder = violations.length > 10 ? `\n...and ${violations.length - 10} more violation(s)` : ''
  throw new WorkflowBunEnvironmentSafetyError(
    `Strict workflow guards could not prove workflow environment safety before loading workflows:\n${details}${remainder}`,
    violations,
  )
}

export const prepareWorkflowBunEnvironmentBundle = async (options: {
  readonly workflowsPath: string
  readonly cwd?: string
}): Promise<WorkflowBunEnvironmentBundle> => {
  const cwd = options.cwd ?? process.cwd()
  const inspection = await inspectWorkflowBunEnvironmentSafety({ ...options, cwd })
  if (inspection.violations.length > 0) {
    throwWorkflowBunEnvironmentSafetyError(inspection.violations, cwd)
  }
  if (!inspection.bundle) {
    throw new WorkflowBunEnvironmentSafetyError('Strict workflow inspection did not produce an executable bundle')
  }
  return inspection.bundle
}

export const assertWorkflowBunEnvironmentSafety = async (options: {
  readonly workflowsPath?: string
  readonly workflows?: WorkflowDefinitions
  readonly cwd?: string
}): Promise<void> => {
  if (options.workflows && options.workflows.length > 0) {
    throw new WorkflowBunEnvironmentSafetyError(
      'Strict workflow guards require file-based workflows under Bun 1.4 because Bun.env cannot be intercepted. Provide workflowsPath instead of in-memory workflow definitions.',
    )
  }
  if (!options.workflowsPath) {
    throw new WorkflowBunEnvironmentSafetyError(
      'Strict workflow guards require workflowsPath under Bun 1.4 because Bun.env cannot be intercepted.',
    )
  }

  await prepareWorkflowBunEnvironmentBundle({ workflowsPath: options.workflowsPath, cwd: options.cwd })
}
