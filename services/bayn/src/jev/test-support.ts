import { jevModel, type JevRequest, type JevResponse } from './contract'

export const requestFixture = {
  model: jevModel,
  state: { subject: 'ExampleCo', headline: 'ExampleCo raises its revenue outlook.' },
  questions: {
    relevant: { type: 'noul', instructions: 'Does this contain a fact directly about ExampleCo?' },
    direction: {
      type: 'choice',
      instructions: 'Which outlook direction does the announcement support?',
      criteria: {
        favorable: 'Improved outlook.',
        unfavorable: 'Worsened outlook.',
        unclear: 'Neither is established.',
      },
    },
  },
} satisfies JevRequest

export const responseFixture = () =>
  ({
    model: jevModel,
    answers: {
      relevant: { type: 'noul', noul: 0.95 },
      direction: {
        type: 'choice',
        choice: 'favorable',
        confidence: 0.82,
        probabilities: { favorable: 0.9, unfavorable: 0.02, unclear: 0.08 },
      },
    },
    usage: { input_tokens: 250, output_tokens: 80 },
  }) satisfies JevResponse
