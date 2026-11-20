import { expect, test } from 'bun:test'
import { activityResources } from './activity'

test('renders execution resource references and typed historical grant details without dumping commands', () => {
  expect(
    activityResources([
      'kubernetes.namespace/fixture#pod',
      JSON.stringify({
        Relationships: {
          administrator: { session_id: 'not-for-display' },
          relationships: [
            {
              resource: { kind: 'kubernetes.namespace', id: 'fixture' },
              relation: 'log_reader',
              subject_kind: 'human',
              subject_id: 'fixture-person',
              enabled: false,
            },
          ],
        },
      }),
    ]),
  ).toEqual([
    'kubernetes.namespace/fixture#pod',
    'Revoke log reader · kubernetes.namespace/fixture · human/fixture-person',
  ])
})
test('unknown or malformed receipt commands never expose future credential fields', () => {
  expect(activityResources([JSON.stringify({ NewCommand: { credential: 'not-for-display' } })])).toEqual([])
  expect(activityResources(['{invalid'])).toEqual(['Resource details unavailable for this receipt'])
})
