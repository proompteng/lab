import { describe, expect, it } from 'vitest'

import { createImplementationContractTools } from '~/server/agents-controller/implementation-contract'

const resolveParam = (params: Record<string, string>, keys: string[]) => {
  for (const key of keys) {
    const value = params[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

const { buildContractStatus, buildEventContext, buildEventPayload, validateImplementationContract } =
  createImplementationContractTools(resolveParam)

describe('agents controller implementation-contract module', () => {
  it('builds metadata/payload from mapped parameters and fallback prompt', () => {
    const implementation = {
      source: {
        provider: 'github',
        url: 'https://github.com/proompteng/lab/issues/123',
      },
      summary: 'Fallback summary',
      text: 'Fallback prompt from text',
      contract: {
        requiredKeys: ['repository', 'issueNumber', 'stage'],
      },
    }

    const parameters = {
      repo: 'proompteng/lab',
      issue: '123',
      codexStage: 'implementation',
      baseBranch: 'main',
      headBranch: 'codex/123',
      prompt: 'do-not-override',
    }

    const context = buildEventContext(implementation, parameters)
    expect(context.missingRequiredKeys).toEqual([])
    expect(context.metadata).toMatchObject({
      repository: 'proompteng/lab',
      issueNumber: '123',
      stage: 'implementation',
      base: 'main',
      head: 'codex/123',
      prompt: 'Fallback prompt from text',
    })

    expect(context.payload).toMatchObject({
      repository: 'proompteng/lab',
      issueNumber: '123',
      stage: 'implementation',
      base: 'main',
      head: 'codex/123',
      prompt: 'Fallback prompt from text',
    })
  })

  it('validates repository-backed specs without github issue metadata', () => {
    const implementation = {
      source: {
        provider: 'manual',
        externalId: 'manual:task-1',
      },
      text: 'Implement the task from the prompt',
      contract: {
        requiredKeys: ['repository', 'base', 'head', 'stage'],
      },
    }

    const parameters = {
      repository: 'proompteng/lab',
      base: 'main',
      head: 'codex/no-issue-task',
      stage: 'implementation',
    }

    const validation = validateImplementationContract(implementation, parameters)
    expect(validation).toMatchObject({ ok: true, requiredKeys: ['repository', 'base', 'head', 'stage'] })

    const context = buildEventContext(implementation, parameters)
    expect(context.missingRequiredKeys).toEqual([])
    expect(context.payload).toMatchObject({
      repository: 'proompteng/lab',
      base: 'main',
      head: 'codex/no-issue-task',
      stage: 'implementation',
      prompt: 'Implement the task from the prompt',
    })
    expect(context.payload).not.toHaveProperty('issueNumber')
    expect(context.payload).not.toHaveProperty('issueTitle')
    expect(context.payload).not.toHaveProperty('issueBody')
    expect(context.metadata).not.toHaveProperty('issueNumber')
    expect(context.metadata).not.toHaveProperty('issueTitle')
    expect(context.metadata).not.toHaveProperty('issueBody')
  })

  it('does not synthesize github issue title or body for repository-backed specs without an issue number', () => {
    const implementation = {
      source: {
        provider: 'codex',
        externalId: 'proompteng/lab:codex/no-issue-task',
      },
      summary: 'Repository-backed task summary',
      text: 'Repository-backed task body',
      contract: {
        requiredKeys: ['repository', 'base', 'head', 'stage'],
      },
    }

    const context = buildEventContext(implementation, {
      repository: 'proompteng/lab',
      base: 'main',
      head: 'codex/no-issue-task',
      stage: 'implementation',
    })

    expect(context.payload).toMatchObject({
      repository: 'proompteng/lab',
      base: 'main',
      head: 'codex/no-issue-task',
      stage: 'implementation',
      prompt: 'Repository-backed task body',
    })
    expect(context.payload).not.toHaveProperty('issueNumber')
    expect(context.payload).not.toHaveProperty('issueTitle')
    expect(context.payload).not.toHaveProperty('issueBody')
    expect(context.metadata).not.toHaveProperty('issueTitle')
    expect(context.metadata).not.toHaveProperty('issueBody')
  })

  it('renders parameterized implementation text for prompt and issue body', () => {
    const implementation = {
      source: {
        provider: 'github',
      },
      summary: 'Compile ${repository}',
      text: 'Run compile for ${datasetRef} with {{parameters.optimizer}} -> ${artifactPath}',
      contract: {
        requiredKeys: ['repository', 'datasetRef', 'optimizer', 'artifactPath'],
      },
    }

    const parameters = {
      repository: 'proompteng/lab',
      issueNumber: '123',
      datasetRef: 'artifacts/dspy/run-1/dataset-build/dspy-dataset.json',
      optimizer: 'miprov2',
      artifactPath: 'artifacts/dspy/run-1/compile',
    }

    const context = buildEventContext(implementation, parameters)
    expect(context.missingRequiredKeys).toEqual([])
    expect(context.payload.prompt).toBe(
      'Run compile for artifacts/dspy/run-1/dataset-build/dspy-dataset.json with miprov2 -> artifacts/dspy/run-1/compile',
    )
    expect(context.payload.issueBody).toBe(
      'Run compile for artifacts/dspy/run-1/dataset-build/dspy-dataset.json with miprov2 -> artifacts/dspy/run-1/compile',
    )
    expect(context.payload.issueTitle).toBe('Compile proompteng/lab')
  })

  it('preserves unknown shell placeholders while interpolating known parameters', () => {
    const implementation = {
      source: {
        provider: 'github',
      },
      text: 'SCRIPT_ROOT=/root/.codex && test -f "${SCRIPT_ROOT}/run.py" && echo ${symbol}',
      contract: {
        requiredKeys: ['symbol'],
      },
    }

    const parameters = {
      issueNumber: '123',
      symbol: 'AAPL',
    }

    const context = buildEventContext(implementation, parameters)
    expect(context.missingRequiredKeys).toEqual([])
    expect(context.payload.prompt).toBe('SCRIPT_ROOT=/root/.codex && test -f "${SCRIPT_ROOT}/run.py" && echo AAPL')
    expect(context.payload.issueBody).toBe('SCRIPT_ROOT=/root/.codex && test -f "${SCRIPT_ROOT}/run.py" && echo AAPL')
  })

  it('preserves explicit issue body metadata without requiring an issue number', () => {
    const context = buildEventContext(
      {
        text: 'Prompt text',
        contract: {
          requiredKeys: ['repository', 'issueBody'],
        },
      },
      {
        repository: 'proompteng/lab',
        issueBody: 'Explicit issue body',
      },
    )

    expect(context.missingRequiredKeys).toEqual([])
    expect(context.payload).toMatchObject({
      repository: 'proompteng/lab',
      prompt: 'Prompt text',
      issueBody: 'Explicit issue body',
    })
    expect(context.payload).not.toHaveProperty('issueNumber')
  })

  it('falls back to github external id when repository metadata is missing', () => {
    const implementation = {
      source: {
        provider: 'github',
        externalId: 'acme/repo#77',
      },
      contract: {
        requiredKeys: ['repository', 'issueNumber'],
      },
    }

    const payload = buildEventPayload(implementation, {})
    expect(payload).toMatchObject({
      repository: 'acme/repo',
      issueNumber: '77',
    })
  })

  it('rejects invalid requiredKeys contract entries', () => {
    const result = validateImplementationContract(
      {
        contract: {
          requiredKeys: ['repository', '', 42],
        },
      },
      {},
    )

    expect(result).toMatchObject({
      ok: false,
      reason: 'InvalidContract',
      requiredKeys: ['repository'],
    })
  })

  it('rejects invalid mappings contract entries', () => {
    const result = validateImplementationContract(
      {
        contract: {
          requiredKeys: ['repository'],
          mappings: [{ from: 'repo', to: '' }],
        },
      },
      {},
    )

    expect(result).toMatchObject({
      ok: false,
      reason: 'InvalidContract',
      requiredKeys: ['repository'],
    })
  })

  it('reports missing required metadata and builds contract status', () => {
    const validation = validateImplementationContract(
      {
        contract: {
          requiredKeys: ['repository', 'issueNumber'],
        },
      },
      {},
    )

    expect(validation).toMatchObject({
      ok: false,
      reason: 'MissingRequiredMetadata',
      requiredKeys: ['repository', 'issueNumber'],
      missing: ['repository', 'issueNumber'],
    })

    const status = buildContractStatus(validation)
    expect(status).toEqual({
      requiredKeys: ['repository', 'issueNumber'],
      missingKeys: ['repository', 'issueNumber'],
    })

    expect(buildContractStatus({ ok: true, requiredKeys: [] })).toBeUndefined()
  })
})
