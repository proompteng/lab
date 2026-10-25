import { expect, test } from 'bun:test'
import { Redacted, Result } from 'effect'

import { parseEvidenceExportArgs } from './evidence-export-command'
import { evidenceReaderUrl } from './db/evidence-reader'

test('export requires an explicit source selector and bounded page budget', () => {
  for (const selector of [
    ['--capture', 'a'.repeat(64)],
    ['--arrivals-since', '2026-10-24'],
  ]) {
    const command = Result.getOrThrow(parseEvidenceExportArgs([...selector, '--maximum-pages', '256']))
    expect(command._tag).toBe('Export')
  }
  expect(Result.getOrThrow(parseEvidenceExportArgs(['--help']))._tag).toBe('Help')
  for (const args of [
    [],
    ['--help', 'extra'],
    ['--capture', 'a'.repeat(63), '--maximum-pages', '1'],
    ['--arrivals-since', '2026-02-30', '--maximum-pages', '1'],
    ['--capture', 'a'.repeat(64), '--maximum-pages', '0'],
    ['--capture', 'a'.repeat(64), '--maximum-pages', '257'],
    ['--capture', 'a'.repeat(64), '--maximum-pages', '1.0'],
    ['--capture', 'a'.repeat(64), '--maximum-pages', '1', '--capture', 'b'.repeat(64)],
  ]) {
    expect(Result.isFailure(parseEvidenceExportArgs(args))).toBeTrue()
  }
})

test('only the dedicated reader is admitted and read-only settings persist across reconnections', () => {
  const input = Redacted.make(
    'postgresql://bayn_evidence:fixture-password@database/bayn?options=-c%20default_transaction_read_only%3Doff',
  )
  const result = Result.getOrThrow(evidenceReaderUrl(input))
  const url = new URL(Redacted.value(result))
  expect(url.searchParams.get('options')).toEndWith('-c default_transaction_read_only=on -c timezone=UTC')
  expect(Redacted.value(input)).toContain('default_transaction_read_only%3Doff')
  for (const value of [
    'not-a-url',
    'postgresql://bayn_app:fixture-password@database/bayn',
    'postgresql://bayn_evidence:fixture-password@database/bayn?user=postgres',
  ]) {
    const rejected = evidenceReaderUrl(Redacted.make(value))
    expect(Result.isFailure(rejected)).toBeTrue()
    if (Result.isFailure(rejected)) expect(rejected.failure.message).not.toContain('fixture-password')
  }
})
