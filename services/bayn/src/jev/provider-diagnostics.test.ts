import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { JevProviderDiagnosticsSchema, projectJevProviderDiagnostics } from './provider-diagnostics'

const credential = 'secret-fixture-credential'

test('projects only bounded provider identifiers and a retry hint independently of metering', () => {
  const body = {
    request_id: 'body-request',
    error: { code: 'capacity_exceeded', type: 'overloaded_error', message: 'private provider explanation' },
    authorization: credential,
    request: { state: 'private trading inputs' },
  }
  const result = projectJevProviderDiagnostics(
    { 'x-request-id': 'header-request', 'retry-after': '10', 'x-api-key': credential },
    body,
    credential,
  )
  expect(result).toEqual({
    schemaVersion: 'bayn.jev-provider-diagnostics.v1',
    requestId: 'header-request',
    errorCode: 'capacity_exceeded',
    errorType: 'overloaded_error',
    retryAfter: { kind: 'DELAY', seconds: 10 },
  })
  if (result === undefined) throw new Error('Expected provider diagnostics')
  expect(Result.getOrThrow(Schema.decodeUnknownResult(JevProviderDiagnosticsSchema)(result))).toEqual(result)
  for (const privateText of [credential, 'private provider explanation', 'private trading inputs'])
    expect(JSON.stringify(result)).not.toContain(privateText)
})

test('omits malformed identifiers, raw error text and echoed credentials without truncating them', () => {
  for (const body of [
    null,
    ['error'],
    { error: 'private provider message' },
    { error: { message: credential } },
    { request_id: 'request\n', error: { code: 'overloaded\n', type: 'error\n' } },
  ])
    expect(projectJevProviderDiagnostics({}, body, credential)).toBeUndefined()
  expect(
    projectJevProviderDiagnostics(
      { 'request-id': `request-${credential}`, 'retry-after': 'Bearer private' },
      { request_id: credential, error: { code: credential, type: 'not a safe identifier' } },
      credential,
    ),
  ).toBeUndefined()
  expect(
    projectJevProviderDiagnostics(
      { 'request-id': 'r'.repeat(129) },
      { error: { code: 'c'.repeat(65), type: 't'.repeat(65) } },
      credential,
    ),
  ).toBeUndefined()
  expect(
    projectJevProviderDiagnostics(
      { 'request-id': 'r'.repeat(128) },
      { error: { code: 'c'.repeat(64), type: 't'.repeat(64) } },
      credential,
    ),
  ).toMatchObject({ requestId: 'r'.repeat(128), errorCode: 'c'.repeat(64), errorType: 't'.repeat(64) })
})

test('retains valid Retry-After hints as data without accepting unbounded or invalid values', () => {
  for (const seconds of [0, 86_400])
    expect(projectJevProviderDiagnostics({ 'retry-after': String(seconds) }, null, credential)?.retryAfter).toEqual({
      kind: 'DELAY',
      seconds,
    })
  expect(
    projectJevProviderDiagnostics({ 'retry-after': 'Wed, 11 Nov 2026 02:00:00 GMT' }, null, credential)?.retryAfter,
  ).toEqual({ kind: 'AT', at: '2026-11-11T02:00:00.000Z' })
  for (const value of ['86401', '1000000000', '-1', '1.5', '1e3', '00', '10\n', 'Wed, 31 Feb 2026 02:00:00 GMT'])
    expect(projectJevProviderDiagnostics({ 'retry-after': value }, null, credential)).toBeUndefined()
})

test('rejects empty or malformed durable diagnostic projections', () => {
  for (const value of [
    { schemaVersion: 'bayn.jev-provider-diagnostics.v1' },
    { schemaVersion: 'bayn.jev-provider-diagnostics.v1', requestId: 'x'.repeat(129) },
    { schemaVersion: 'bayn.jev-provider-diagnostics.v1', errorType: 'arbitrary text' },
    { schemaVersion: 'bayn.jev-provider-diagnostics.v1', requestId: 'request\n' },
    { schemaVersion: 'bayn.jev-provider-diagnostics.v1', retryAfter: { kind: 'DELAY', seconds: -1 } },
  ])
    expect(Result.isFailure(Schema.decodeUnknownResult(JevProviderDiagnosticsSchema)(value))).toBe(true)
})
