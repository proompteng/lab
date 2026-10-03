import { describe, expect, it } from 'vitest'
import { CredentialMasker, maskCredentialValues } from './credential-masker'

const marker = '[REDACTED_CREDENTIAL]'
const samples = [
  [
    '{"Authorization":"synthetic-test-secret ","ordinary":"next-line"}',
    `{"Authorization":"${marker}","ordinary":"next-line"}`,
  ],
  ['Authorization: CustomScheme synthetic-test-secret\nnext', `Authorization: ${marker}\nnext`],
  ['Authorization: synthetic-test-secret \nordinary-next-line', `Authorization: ${marker}\nordinary-next-line`],
  [
    'Authorization: Token synthetic-test-secret\\\nordinary-next-line',
    `Authorization: Token ${marker}\nordinary-next-line`,
  ],
  ['Authorization: Token synthetic-test-secret\nnext', `Authorization: Token ${marker}\nnext`],
  ['Authorization: Negotiate synthetic-test-secret\nnext', `Authorization: Negotiate ${marker}\nnext`],
  [
    'Authorization: Digest username="alice", nonce="synthetic-test-secret", response="synthetic-response"\nnext',
    `Authorization: Digest ${marker}\nnext`,
  ],
  [
    "curl -H 'Authorization: Token synthetic-test-secret' https://example.test",
    `curl -H 'Authorization: Token ${marker}' https://example.test`,
  ],
  ['{"Authorization":"Token synthetic-test-secret","count":3}', `{"Authorization":"Token ${marker}","count":3}`],
  ['Authorization: synthetic-test-secret\nnext', `Authorization: ${marker}\nnext`],
  ['curl --user "alice:first synthetic-test-secret" next', `curl --user "alice:${marker}" next`],
  ["https://example.test?token='synthetic-test-secret'&limit=3", `https://example.test?token='${marker}'&limit=3`],
  ['token=synthetic-test-secret next', `token=${marker} next`],
  ['password=[REDACTED_CREDENTIAL]synthetic-test-secret next', `password=${marker} next`],
  ['curl -u name:synthetic-test-secret https://example.test', `curl -u name:${marker} https://example.test`],
  ['curl -uname:synthetic-test-secret https://example.test', `curl -uname:${marker} https://example.test`],
  ['curl --user=name:synthetic-test-secret https://example.test', `curl --user=name:${marker} https://example.test`],
  ['--token=synthetic-test-secret next', `--token=${marker} next`],
  ['--token' + ' '.repeat(300) + 'synthetic-test-secret next', '--token' + ' '.repeat(300) + `${marker} next`],
  ['{"token"' + ' '.repeat(300) + ':"synthetic-test-secret"}', '{"token"' + ' '.repeat(300) + `:"${marker}"}`],
  ['mongodb://user:synthetic-test-secret@host/path', `mongodb://user:${marker}@host/path`],
  ['Authorization: Bearer synthetic-test-secret\nnext', `Authorization: Bearer ${marker}\nnext`],
  ['Authorization: Basic synthetic-test-secret\nnext', `Authorization: Basic ${marker}\nnext`],
  ['password="synthetic-test-secret" next', `password="${marker}" next`],
  ['--password synthetic-test-secret --verbose', `--password ${marker} --verbose`],
  ['{"token":"synthetic-test-secret","count":3}', `{"token":"${marker}","count":3}`],
  ['AWS_SECRET_ACCESS_KEY=synthetic-test-secret next', `AWS_SECRET_ACCESS_KEY=${marker} next`],
  ['https://user:synthetic-test-secret@example.test/path', `https://user:${marker}@example.test/path`],
  [
    'https://example.test?token=synthetic-test-secret&limit=3 next',
    `https://example.test?token=${marker}&limit=3 next`,
  ],
  [
    'before\n-----BEGIN PRIVATE KEY-----\nsynthetic-test-secret\n-----END PRIVATE KEY-----\nafter',
    `before\n${marker}\nafter`,
  ],
  [
    'https://' + 'u'.repeat(300) + ':synthetic-test-secret@host/path',
    'https://' + 'u'.repeat(300) + `:${marker}@host/path`,
  ],
  ['password' + ' '.repeat(300) + '=synthetic-test-secret next', 'password' + ' '.repeat(300) + `=${marker} next`],
]

describe('minimal streaming credential masking', () => {
  it.each(samples)('preserves surrounding content across every split: %s', (input, expected) => {
    for (let split = 0; split <= input.length; split += 1) {
      const masker = new CredentialMasker([])
      expect(masker.write(input.slice(0, split)) + masker.write(input.slice(split), true)).toBe(expected)
      expect(masker.consumedBytes).toBe(Buffer.byteLength(input))
    }
    const masker = new CredentialMasker([])
    expect([...input].map((char) => masker.write(char)).join('') + masker.write('', true)).toBe(expected)
  })

  it('masks a known runtime credential across every split without hiding neighboring text', () => {
    const secret = 'synthetic-runtime-credential'
    const input = `before:${secret}:after`
    for (let split = 0; split <= input.length; split += 1) {
      const masker = new CredentialMasker([secret])
      expect(masker.write(input.slice(0, split)) + masker.write(input.slice(split), true)).toBe(
        `before:${marker}:after`,
      )
    }
  })

  it.each([
    'A'.repeat(100) + 'notpassword=ordinary' + ' '.repeat(239),
    'Authorization: \nordinary-next-line',
    'git show abc123 -- src/token-count.ts',
    'tokenCount=400 token_budget=20000 sessionId=repo-agent-a requestId=abcd',
    'https://example.test:8080/path?limit=4',
    'const tokenCount = stats.total; const keyPath = "keys/public.pem";',
    'password strength: strong; no credential value here',
    '😀' + 'x'.repeat(255),
    '雪😀'.repeat(1000),
  ])('does not mask ordinary operational content: %s', (input) => {
    const masker = new CredentialMasker([])
    expect([...input].map((char) => masker.write(char)).join('') + masker.write('', true)).toBe(input)
    expect(masker.maskedValues).toBe(0)
    expect(masker.consumedBytes).toBe(Buffer.byteLength(input))
  })

  it('preserves lexical boundaries at every streaming carry split', () => {
    const input = 'A'.repeat(100) + 'notpassword=ordinary' + ' '.repeat(239)
    for (let split = 0; split <= input.length; split += 1) {
      const masker = new CredentialMasker([])
      expect(masker.write(input.slice(0, split)) + masker.write(input.slice(split), true)).toBe(input)
    }
  })

  it('is idempotent for already marked credential values', () => {
    for (const [input] of samples) {
      const once = maskCredentialValues(input, []).text
      expect(maskCredentialValues(once, []).text).toBe(once)
    }
  })
})
