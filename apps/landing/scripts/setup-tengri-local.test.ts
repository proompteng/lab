import { describe, expect, test } from 'bun:test'
import { mergeEnvironment, readEnvironmentValue, retainOrGenerateSecret } from './setup-tengri-local'

describe('Tengri local environment setup', () => {
  test('updates Tengri values without dropping unrelated local configuration', () => {
    const source = [
      'NEXT_PUBLIC_CONVEX_URL=https://example.convex.cloud',
      'BETTER_AUTH_URL=http://localhost:3000',
      '',
    ].join('\n')

    const output = mergeEnvironment(source, {
      BETTER_AUTH_URL: 'http://127.0.0.1:3000',
      GITHUB_CLIENT_ID: 'client-id',
    })

    expect(output).toContain('NEXT_PUBLIC_CONVEX_URL=https://example.convex.cloud')
    expect(output).toContain('BETTER_AUTH_URL=http://127.0.0.1:3000')
    expect(output).toContain('GITHUB_CLIENT_ID=client-id')
    expect(output.endsWith('\n')).toBeTrue()
  })

  test('quotes values only when dotenv parsing requires it', () => {
    const output = mergeEnvironment('', {
      BETTER_AUTH_SECRET: 'safe-secret_value',
      GITHUB_CLIENT_SECRET: 'contains a space',
    })

    expect(readEnvironmentValue(output, 'BETTER_AUTH_SECRET')).toBe('safe-secret_value')
    expect(readEnvironmentValue(output, 'GITHUB_CLIENT_SECRET')).toBe('contains a space')
  })

  test('preserves valid signing keys and generates missing ones', () => {
    const existing = 'x'.repeat(32)
    expect(retainOrGenerateSecret(existing, () => 'replacement')).toBe(existing)
    expect(retainOrGenerateSecret('short', () => 'replacement')).toBe('replacement')
  })
})
