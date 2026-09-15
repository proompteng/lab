import { describe, expect, it } from 'vitest'

import { buildCodexOrchestrationParameters } from './codex-orchestration-parameters'

describe('codex-orchestration-parameters', () => {
  it('builds the Codex rerun orchestration parameter contract with camel and snake aliases', () => {
    const params = buildCodexOrchestrationParameters({
      repository: 'proompteng/lab',
      issueNumber: 7152,
      base: 'main',
      head: 'codex/agents-split',
      prompt: 'Finish the migration.',
      judgePrompt: 'Judge the migration.',
      attempt: 2,
      parentRunUid: 'uid-123',
      iterationCycle: 3,
      iterationsCount: 5,
      resumeKey: 'runs/resume.json',
      changesKey: 'runs/changes.patch',
    })

    expect(params).toEqual({
      repository: 'proompteng/lab',
      issueNumber: '7152',
      issue_number: '7152',
      base: 'main',
      head: 'codex/agents-split',
      stage: 'implementation',
      codexPrompt: 'Finish the migration.',
      codex_prompt: 'Finish the migration.',
      nextPrompt: 'Finish the migration.',
      next_prompt: 'Finish the migration.',
      judgePrompt: 'Judge the migration.',
      judge_prompt: 'Judge the migration.',
      attempt: '2',
      parentRunUid: 'uid-123',
      parent_run_uid: 'uid-123',
      iterationCycle: '3',
      iteration_cycle: '3',
      implementationIterations: '5',
      implementation_iterations: '5',
      implementationResumeKey: 'runs/resume.json',
      implementation_resume_key: 'runs/resume.json',
      implementationChangesKey: 'runs/changes.patch',
      implementation_changes_key: 'runs/changes.patch',
    })
  })

  it('omits empty optional values but preserves stage', () => {
    expect(
      buildCodexOrchestrationParameters({
        repository: ' proompteng/lab ',
        prompt: '   ',
        issueNumber: null,
      }),
    ).toEqual({
      repository: 'proompteng/lab',
      stage: 'implementation',
    })
  })
})
