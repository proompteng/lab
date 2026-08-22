import { relative, resolve } from 'node:path'

import { lintWorkflowSourceAst, type WorkflowLintViolation } from '../bin/workflow-lint/rules'
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
] as const
const bunEnvironmentDenyGlobals = new Set(['Bun', 'eval', 'Function', 'require'])
const bunEnvironmentDenyMemberExpressions = new Set([
  'Bun.env',
  'import.meta',
  'import.meta.env',
  'import.meta.require',
  'process.getBuiltinModule',
  'process.mainModule',
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
  ['process', new Set(['getBuiltinModule', 'mainModule', 'valueOf'])] as const,
  ['module', new Set(['require', 'valueOf'])] as const,
])
const bunEnvironmentDenyGlobalCaptures = new Set([...bunEnvironmentGlobalObjects, 'process', 'module'])
const bunEnvironmentDenyIndirectGlobalReferences = new Set(['eval', 'Function', 'require'])
const bunEnvironmentAllowIndirectGlobalMemberExpressions = new Set(['Function.prototype.apply'])
const bunEnvironmentDenyInvokedMemberProperties = new Set(['constructor'])
const bunEnvironmentDenyImports = new Set(['node:vm', 'vm', 'node:module', 'module', 'node:process', 'process'])

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

export class WorkflowBunEnvironmentSafetyError extends Error {
  readonly violations: readonly WorkflowLintViolation[]

  constructor(message: string, violations: readonly WorkflowLintViolation[] = []) {
    super(message)
    this.name = 'WorkflowBunEnvironmentSafetyError'
    this.violations = violations
  }
}

export const lintWorkflowBunEnvironmentSafety = async (options: {
  readonly workflowsPath: string
  readonly cwd?: string
}): Promise<readonly WorkflowLintViolation[]> => {
  const cwd = options.cwd ?? process.cwd()
  const entry = resolve(cwd, options.workflowsPath)
  let build: Awaited<ReturnType<typeof Bun.build>>
  try {
    build = await Bun.build({
      entrypoints: [entry],
      root: cwd,
      target: 'bun',
      format: 'esm',
      packages: 'bundle',
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
    return Array.isArray(diagnostics) && diagnostics.length > 0
      ? diagnostics.map((diagnostic) => bundleDiagnosticViolation(entry, diagnostic))
      : [bundleDiagnosticViolation(entry, error)]
  }

  if (!build.success) {
    const logs = build.logs.length > 0 ? build.logs : ['Unknown workflow bundle failure']
    return logs.map((log) => bundleDiagnosticViolation(entry, log))
  }

  const scriptOutputs = build.outputs.filter((output) => output.kind === 'entry-point' || output.kind === 'chunk')
  const opaqueOutputs = build.outputs.filter((output) => output.kind !== 'entry-point' && output.kind !== 'chunk')
  if (scriptOutputs.length === 0 || opaqueOutputs.length > 0) {
    return [
      {
        filePath: entry,
        rule: 'unresolved-import',
        message:
          opaqueOutputs.length > 0
            ? `Workflow bundle contains uninspectable outputs: ${opaqueOutputs.map((output) => output.path).join(', ')}`
            : 'Workflow bundle did not produce inspectable JavaScript',
        line: 1,
        column: 1,
      },
    ]
  }

  const violations: WorkflowLintViolation[] = []
  for (const output of scriptOutputs) {
    violations.push(
      ...lintWorkflowSourceAst({
        filePath: entry,
        sourceText: await output.text(),
        denyGlobals: bunEnvironmentDenyGlobals,
        denyMemberExpressions: bunEnvironmentDenyMemberExpressions,
        denyImports: bunEnvironmentDenyImports,
        denyReflectiveGlobalProperties: bunEnvironmentDenyGlobalObjectProperties,
        denyComputedGlobalProperties: bunEnvironmentDenyGlobalObjectProperties,
        denyGlobalCaptures: bunEnvironmentDenyGlobalCaptures,
        denyIndirectGlobalReferences: bunEnvironmentDenyIndirectGlobalReferences,
        allowIndirectGlobalMemberExpressions: bunEnvironmentAllowIndirectGlobalMemberExpressions,
        denyInvokedMemberProperties: bunEnvironmentDenyInvokedMemberProperties,
      }),
    )
  }
  return violations
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

  const cwd = options.cwd ?? process.cwd()
  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath: options.workflowsPath, cwd })
  if (violations.length === 0) return

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
