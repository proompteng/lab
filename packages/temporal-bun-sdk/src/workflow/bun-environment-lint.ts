import { relative, resolve } from 'node:path'

import { buildWorkflowLintGraph } from '../bin/workflow-lint/graph'
import { lintWorkflowModuleAst, type WorkflowLintViolation } from '../bin/workflow-lint/rules'
import type { WorkflowDefinitions } from './definition'

const bunEnvironmentDenyGlobals = new Set(['Bun'])
const bunEnvironmentDenyMemberExpressions = new Set(['Bun.env', 'globalThis.Bun', 'import.meta.env'])

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
  const { graph, violations: graphViolations } = await buildWorkflowLintGraph({
    entry,
    cwd,
    denyImports: new Set<string>(),
    inspectBareImports: true,
    rejectUninspectableImports: true,
  })
  const violations: WorkflowLintViolation[] = graphViolations.map((violation) => ({
    filePath: violation.filePath,
    rule: violation.rule,
    message: violation.message,
    line: 1,
    column: 1,
    ...(violation.specifier ? { details: { specifier: violation.specifier } } : {}),
  }))

  for (const filePath of [...graph.modules].sort()) {
    violations.push(
      ...(await lintWorkflowModuleAst({
        filePath,
        denyGlobals: bunEnvironmentDenyGlobals,
        denyMemberExpressions: bunEnvironmentDenyMemberExpressions,
        denyImports: new Set<string>(),
      })),
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
