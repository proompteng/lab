import type { TengriCodexModel } from '@/lib/tengri/codex-models'

export const codexModelFixtures = [
  {
    model: 'gpt-6.1-sol',
    displayName: 'GPT-6.1 Sol',
    description: 'Coding and everyday work',
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast responses' },
      { reasoningEffort: 'medium', description: 'Balanced reasoning' },
      { reasoningEffort: 'high', description: 'Deeper reasoning' },
      { reasoningEffort: 'max', description: 'Maximum reasoning' },
    ],
  },
  {
    model: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    description: 'Focused work',
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast responses' },
      { reasoningEffort: 'medium', description: 'Balanced reasoning' },
    ],
  },
] satisfies TengriCodexModel[]
