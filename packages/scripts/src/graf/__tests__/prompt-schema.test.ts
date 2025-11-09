import { describe, expect, it } from 'bun:test'

import { promptDefinitionSchema } from '../schema'

const minimalPrompt = {
  promptId: 'test-prompt',
  title: 'Test prompt',
  streamId: 'test-stream',
  objective: 'Confirm the schema exports validation helpers.',
  promptTemplate: 'Please return JSON.',
  inputs: [
    {
      name: 'context',
      type: 'string',
      description: 'Any contextual payload.',
    },
  ],
  expectedJsonEnvelope: {
    summary: 'A summary field',
    fields: [
      {
        name: 'testField',
        type: 'string',
        description: 'A test field.',
      },
    ],
  },
  scoringHeuristics: ['Score high when metadata is referenced.'],
  citationPolicy: {
    summary: 'Cite docs/nvidia-supply-chain-graph-design.md when referencing context.',
    references: ['docs/nvidia-supply-chain-graph-design.md (Purpose)'],
  },
}

describe('promptDefinitionSchema', () => {
  it('rejects a definition without streamId', () => {
    const { streamId: _, ...broken } = minimalPrompt
    const result = promptDefinitionSchema.safeParse(broken)
    expect(result.success).toBe(false)
    if (!result.success) {
      const hasStreamIdIssue = result.error.issues.some((issue) => issue.path.includes('streamId'))
      expect(hasStreamIdIssue).toBe(true)
    }
  })

  it('accepts a minimal valid definition', () => {
    const parsed = promptDefinitionSchema.parse(minimalPrompt)
    expect(parsed.promptId).toBe('test-prompt')
  })
})
