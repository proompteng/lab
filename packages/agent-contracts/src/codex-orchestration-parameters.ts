export type CodexOrchestrationParametersInput = {
  repository?: string | null
  issueNumber?: number | string | null
  base?: string | null
  head?: string | null
  prompt?: string | null
  judgePrompt?: string | null
  attempt?: number | string | null
  parentRunUid?: string | null
  iterationCycle?: number | string | null
  iterationsCount?: number | string | null
  resumeKey?: string | null
  changesKey?: string | null
}

const addParam = (params: Record<string, string>, key: string, value: unknown) => {
  if (value == null) return
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length > 0) {
      params[key] = trimmed
    }
    return
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    params[key] = String(value)
    return
  }
  if (typeof value === 'boolean') {
    params[key] = value ? 'true' : 'false'
    return
  }
  params[key] = JSON.stringify(value)
}

const addParamAlias = (params: Record<string, string>, keys: string[], value: unknown) => {
  for (const key of keys) {
    addParam(params, key, value)
  }
}

export const buildCodexOrchestrationParameters = (input: CodexOrchestrationParametersInput) => {
  const params: Record<string, string> = {}
  addParam(params, 'repository', input.repository)
  addParamAlias(params, ['issueNumber', 'issue_number'], input.issueNumber)
  addParam(params, 'base', input.base)
  addParam(params, 'head', input.head)
  addParam(params, 'stage', 'implementation')
  addParamAlias(params, ['codexPrompt', 'codex_prompt', 'nextPrompt', 'next_prompt'], input.prompt)
  addParamAlias(params, ['judgePrompt', 'judge_prompt'], input.judgePrompt)
  addParam(params, 'attempt', input.attempt)
  addParamAlias(params, ['parentRunUid', 'parent_run_uid'], input.parentRunUid)
  addParamAlias(params, ['iterationCycle', 'iteration_cycle'], input.iterationCycle)
  addParamAlias(params, ['implementationIterations', 'implementation_iterations'], input.iterationsCount)
  addParamAlias(params, ['implementationResumeKey', 'implementation_resume_key'], input.resumeKey)
  addParamAlias(params, ['implementationChangesKey', 'implementation_changes_key'], input.changesKey)
  return params
}
