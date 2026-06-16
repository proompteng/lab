import { describe, expect, test } from 'vitest'

import { ALL_PI_TOOL_NAMES, buildModelsJson, parseCommandList, resolveConfig } from './config'
import {
  buildAgentPrompt,
  buildNoChangeRepairPrompt,
  buildValidationRepairPrompt,
  resolveTaskPrompt,
  resolveValidationCommands,
} from './prompt'

describe('Anypi config', () => {
  test('defaults to Flamingo and all Pi coding tools', () => {
    const config = resolveConfig({})
    expect(config.provider).toBe('flamingo')
    expect(config.model).toBe('qwen3-coder-flamingo')
    expect(config.baseUrl).toBe('http://flamingo.flamingo.svc.cluster.local/v1')
    expect(config.thinkingLevel).toBe('off')
    expect(config.tools).toEqual([...ALL_PI_TOOL_NAMES])
    expect(config.noChangeRepairAttempts).toBe(2)
    expect(config.validationRepairAttempts).toBe(2)
  })

  test('renders Pi custom models.json for vLLM OpenAI-compatible serving', () => {
    const config = resolveConfig({})
    expect(buildModelsJson(config)).toMatchObject({
      providers: {
        flamingo: {
          api: 'openai-completions',
          baseUrl: 'http://flamingo.flamingo.svc.cluster.local/v1',
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
          models: [{ id: 'qwen3-coder-flamingo', reasoning: false }],
        },
      },
    })
  })

  test('parses validation commands from newline text or JSON', () => {
    expect(parseCommandList('git diff --check\nbun test')).toEqual(['git diff --check', 'bun test'])
    expect(parseCommandList('["git diff --check","bun test"]')).toEqual(['git diff --check', 'bun test'])
  })
})

describe('Anypi prompt contract', () => {
  test('prefers rendered run prompt over raw implementation text', () => {
    expect(
      resolveTaskPrompt({
        prompt: 'rendered',
        implementation: { text: 'raw' },
      }),
    ).toBe('rendered')
  })

  test('builds yolo autonomous coding instructions', () => {
    const prompt = buildAgentPrompt(
      {
        prompt: 'Refactor code and add tests.',
        vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
      },
      '/workspace/lab',
    )
    expect(prompt).toContain('YOLO-mode autonomous coding agent')
    expect(prompt).toContain('shell, read, edit, write, grep, find, and ls')
    expect(prompt).toContain('Refactor code and add tests.')
    expect(prompt).toContain('runner will validate, commit, push, and open or update the PR')
  })

  test('uses run parameters for validation commands when env commands are absent', () => {
    expect(
      resolveValidationCommands(
        {
          parameters: {
            validationCommands: 'git diff --check\nuv run pytest tests/test_check_diff_coverage.py',
          },
        },
        [],
      ),
    ).toEqual(['git diff --check', 'uv run pytest tests/test_check_diff_coverage.py'])
  })

  test('builds a validation repair prompt with failed command output', () => {
    const prompt = buildValidationRepairPrompt({
      attempt: 1,
      maxAttempts: 2,
      worktree: '/workspace/lab',
      results: [
        {
          command: 'bash',
          args: ['-lc', 'git diff --check'],
          exitCode: 2,
          stdout: 'file.py:1: trailing whitespace.',
          stderr: '',
          durationMs: 12,
          ok: false,
        },
      ],
    })
    expect(prompt).toContain('Repair attempt: 1 of 2')
    expect(prompt).toContain('git diff --check')
    expect(prompt).toContain('trailing whitespace')
    expect(prompt).toContain('do not remove tests')
  })

  test('builds a no-change repair prompt that requires implementation', () => {
    const prompt = buildNoChangeRepairPrompt({ attempt: 1, maxAttempts: 2, worktree: '/workspace/lab' })
    expect(prompt).toContain('completed without leaving any code changes')
    expect(prompt).toContain('Repair attempt: 1 of 2')
    expect(prompt).toContain('requires a real implementation')
    expect(prompt).toContain('leave the final changes in the worktree')
  })
})
