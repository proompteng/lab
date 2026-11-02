import { describe, expect, test } from 'bun:test'
import {
  codexOptionsForSelection,
  codexSelectionSchema,
  defaultCodexSelection,
  parseCodexModelPage,
} from './codex-models'

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
  test('rejects an inherited native-default preference so storage resets to the explicit High default', () => {
    expect(codexSelectionSchema.safeParse({ model: 'gpt-6.1-sol', reasoningEffort: 'default' }).success).toBe(false)
    expect(defaultCodexSelection().reasoningEffort).toBe('high')
  })

  test('defaults to High even when the native model defaults to Low, and preserves an explicit choice', () => {
    const page = parseCodexModelPage(JSON.stringify({ data: [model], nextCursor: null }))
    expect(codexOptionsForSelection(defaultCodexSelection(), page.models)).toEqual({
      model: 'gpt-6.1-sol',
      reasoningEffort: 'high',
    })
    expect(codexOptionsForSelection({ model: 'gpt-6.1-sol', reasoningEffort: 'low' }, page.models)).toEqual({
      model: 'gpt-6.1-sol',
      reasoningEffort: 'low',
    })
  })

  test('does not substitute a model or accept unsupported reasoning', () => {
    const page = parseCodexModelPage(JSON.stringify({ data: [model], nextCursor: 'next-page' }))
    expect(page.nextCursor).toBe('next-page')
    expect(codexOptionsForSelection({ model: 'unavailable-model', reasoningEffort: 'high' }, page.models)).toBeNull()
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
