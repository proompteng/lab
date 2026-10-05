import { describe, expect, test } from 'bun:test'
import { codexOptionsForSelection, defaultCodexSelection, parseCodexModelPage } from './codex-models'

const model = {
  model: 'gpt-6.1-sol',
  displayName: 'GPT-6.1 Sol',
  description: 'A coding model',
  defaultReasoningEffort: 'low',
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Fast responses' },
    { reasoningEffort: 'high', description: 'Deeper reasoning' },
  ],
}

describe('Codex model selection', () => {
  test('uses the native model default and carries an explicit selected effort', () => {
    const page = parseCodexModelPage(JSON.stringify({ data: [model], nextCursor: null }))
    expect(codexOptionsForSelection(defaultCodexSelection(), page.models)).toEqual({
      model: 'gpt-6.1-sol',
      reasoningEffort: 'low',
    })
    expect(codexOptionsForSelection({ model: 'gpt-6.1-sol', reasoningEffort: 'high' }, page.models)).toEqual({
      model: 'gpt-6.1-sol',
      reasoningEffort: 'high',
    })
  })

  test('does not substitute a model or accept unsupported reasoning', () => {
    const page = parseCodexModelPage(JSON.stringify({ data: [model], nextCursor: 'next-page' }))
    expect(page.nextCursor).toBe('next-page')
    expect(codexOptionsForSelection({ model: 'unavailable-model', reasoningEffort: 'default' }, page.models)).toBeNull()
    expect(codexOptionsForSelection({ model: 'gpt-6.1-sol', reasoningEffort: 'none' }, page.models)).toBeNull()
  })

  test('rejects broken native capability metadata', () => {
    for (const invalid of [
      { ...model, defaultReasoningEffort: 'max' },
      { ...model, supportedReasoningEfforts: [] },
      { ...model, supportedReasoningEfforts: [{ reasoningEffort: 'unknown', description: '' }] },
    ]) {
      expect(() => parseCodexModelPage(JSON.stringify({ data: [invalid], nextCursor: null }))).toThrow()
    }
    expect(() => parseCodexModelPage(JSON.stringify({ data: [model], nextCursor: 7 }))).toThrow()
  })
})
