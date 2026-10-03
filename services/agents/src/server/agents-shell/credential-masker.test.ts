import { describe, expect, it } from 'vitest'
import {
  CredentialMasker,
  credentialOptionNames,
  credentialValuesFromEnv,
  maskCredentialValues,
} from './credential-masker'

const marker = '[REDACTED_CREDENTIAL]'
const samples = [
  ['curl --password opaque\\ synthetic-test-secret --verbose', `curl --password ${marker} --verbose`],
  ['password=opaque\\ synthetic-test-secret; echo ordinary', `password=${marker}; echo ordinary`],
  ['password=opaque\\;synthetic-test-secret next', `password=${marker} next`],
  ['curl --user alice:opaque\\ synthetic-test-secret --verbose', `curl --user alice:${marker} --verbose`],
  ['database_password=synthetic-test-secret next', `database_password=${marker} next`],
  ['github_token=synthetic-test-secret next', `github_token=${marker} next`],
  ['service_api_key="synthetic-test-secret" next', `service_api_key="${marker}" next`],
  [
    'database_password' + ' '.repeat(300) + '=synthetic-test-secret next',
    'database_password' + ' '.repeat(300) + `=${marker} next`,
  ],
  ['Cookie: [REDACTED_CREDENTIAL]; sid=synthetic-test-secret\nordinary', `Cookie: ${marker}\nordinary`],
  ['Set-Cookie: [REDACTED_CREDENTIAL]; sid=synthetic-test-secret\nordinary', `Set-Cookie: ${marker}\nordinary`],
  ['Authorization: [REDACTED_CREDENTIAL], synthetic-test-secret\nordinary', `Authorization: ${marker}\nordinary`],
  ['https://user:[REDACTED_CREDENTIAL];synthetic-test-secret@host/path', `https://user:${marker}@host/path`],
  [
    'https://host/path?token=[REDACTED_CREDENTIAL];synthetic-test-secret&limit=3',
    `https://host/path?token=${marker}&limit=3`,
  ],
  ['Cookie: sid=synthetic-test-secret; session=other-value\nordinary', `Cookie: ${marker}\nordinary`],
  ['Set-Cookie: sid=synthetic-test-secret; Path=/; HttpOnly\nordinary', `Set-Cookie: ${marker}\nordinary`],
  [
    "curl -H 'Cookie: sid=synthetic-test-secret' https://example.test",
    `curl -H 'Cookie: ${marker}' https://example.test`,
  ],
  ['{"Cookie":"sid=synthetic-test-secret","ordinary":"next"}', `{"Cookie":"${marker}","ordinary":"next"}`],
  ['Cookie: sid=synthetic-test-secret\\\nordinary', `Cookie: ${marker}\nordinary`],
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
    'Cookie: \nordinary-next-line',
    'const cookieCount = 4; const cookiePath = "/cookie-values.ts";',
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

describe('repository credential context table', () => {
  const scalarNames = [
    'password',
    'passwd',
    'token',
    'secret',
    'accessToken',
    'access_token',
    'access-token',
    'refreshToken',
    'idToken',
    'apiKey',
    'clientSecret',
    'privateKey',
    'secretAccessKey',
    'secret_access_key',
    'secret-access-key',
    'secretKey',
    'sessionToken',
    'authToken',
    'reconnectToken',
    'githubToken',
    'dbPassword',
    'adminPassword',
    'natsPassword',
    'discordBotToken',
    'bot-token',
    'githubWebhookSecret',
    'linearWebhookSecret',
    'webhook-secret',
    'AGENTS_ARTIFACTS_SECRET_ACCESS_KEY',
    'MINIO_SECRET_KEY',
    'database_password',
  ]
  for (const name of scalarNames)
    it(`masks explicit ${name} in assignments at every split`, () => {
      const input = `${name}="synthetic-table-credential" ordinary`
      for (let split = 0; split <= input.length; split += 1) {
        const masker = new CredentialMasker([])
        expect(masker.write(input.slice(0, split)) + masker.write(input.slice(split), true)).toBe(
          `${name}="${marker}" ordinary`,
        )
      }
    })
  for (const name of ['HTTP_AUTHORIZATION', 'PROXY_AUTHORIZATION'])
    it(`masks ${name} across chunks`, () => {
      for (const input of [
        `${name}=Bearer synthetic-table-credential\nordinary`,
        `{"${name}":"Digest nonce=synthetic-table-credential","ordinary":1}`,
        `${name}` + ' '.repeat(300) + '=Basic synthetic-table-credential\nordinary',
      ]) {
        for (let split = 0; split <= input.length; split += 1) {
          const masker = new CredentialMasker([])
          const output = masker.write(input.slice(0, split)) + masker.write(input.slice(split), true)
          expect(output).not.toContain('synthetic-table-credential')
          expect(output).toContain('ordinary')
        }
      }
    })
  it('recognizes actual runtime credential env families without masking reference names', () => {
    const names = [
      'HTTP_AUTHORIZATION',
      'PROXY_AUTHORIZATION',
      'AGENTS_ARTIFACTS_SECRET_ACCESS_KEY',
      'MINIO_SECRET_KEY',
    ]
    for (const name of names)
      expect(credentialValuesFromEnv({ [name]: 'synthetic-runtime-credential' })).toContain(
        'synthetic-runtime-credential',
      )
    for (const name of ['TOKEN_PATH', 'AUTHORIZATION_FILE', 'SECRET_KEY_NAME', 'SECRET_KEY_PATH', 'TOKEN_TYPE'])
      expect(credentialValuesFromEnv({ [name]: 'ordinary-reference' })).toEqual([])
  })
  it('preserves ordinary similarly named values and reference objects', () => {
    for (const name of [
      'tokenCount',
      'token_budget',
      'pageToken',
      'cancellationToken',
      'tokenType',
      'privateKeyPath',
      'secretKeyRef',
      'secretName',
      'AGENTS_TOKEN_PATH',
      'MINIO_SECRET_KEY_NAME',
      'accessKeyId',
    ]) {
      const input = `${name}=ordinary-reference`
      expect(maskCredentialValues(input, []).text).toBe(input)
    }
  })
  it('processes a multi-megabyte repeated credential input in bounded chunks', () => {
    const count = 30_000
    expect(maskCredentialValues('password=synthetic-table-credential ordinary\n'.repeat(count), []).text).toBe(
      `password=${marker} ordinary\n`.repeat(count),
    )
  }, 10_000)
})

describe('explicit credential options', () => {
  for (const option of credentialOptionNames.split('|')) {
    it(`masks --${option} spaced/equal values at every split`, () => {
      for (const separator of [' ', '=', ' '.repeat(300)]) {
        const input = `--${option}${separator}synthetic-table-credential --verbose`
        for (let split = 0; split <= input.length; split += 1) {
          const masker = new CredentialMasker([])
          expect(masker.write(input.slice(0, split)) + masker.write(input.slice(split), true)).toBe(
            `--${option}${separator}${marker} --verbose`,
          )
        }
      }
    })
  }
})
