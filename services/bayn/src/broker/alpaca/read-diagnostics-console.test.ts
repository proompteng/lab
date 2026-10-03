import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { diagnosticLimits, diagnosticLogPrefix } from './read-diagnostics'

test.each(['default', 'json'])(
  'actual Node ManagedRuntime %s console retains bounded diagnostic JSON and explicit truncation',
  async (mode) => {
    const directory = await mkdtemp(join(import.meta.dir, '.node-diagnostics-'))
    try {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, '../../testing/broker-read-diagnostics-node.mjs')],
        target: 'node',
        outdir: directory,
      })
      expect(built.success).toBe(true)
      const process = Bun.spawn(['node', join(directory, 'broker-read-diagnostics-node.js'), mode], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [exit, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ])
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
      expect(stdout).not.toContain('[Object]')
      for (const privateValue of [
        'synthetic-paper-account',
        'synthetic-request',
        'synthetic-fee-',
        'SYNTHETIC_PRIVATE_TEXT',
        '987654321.12',
      ])
        expect(stdout).not.toContain(privateValue)
      const payloads = stdout.split('\n').flatMap((line) => {
        const message: unknown = mode === 'json' && line.startsWith('{') ? JSON.parse(line).message : line
        if (typeof message !== 'string') return []
        const index = message.indexOf(diagnosticLogPrefix)
        return index < 0 ? [] : [message.slice(index + diagnosticLogPrefix.length)]
      })
      expect(payloads.length).toBeGreaterThan(1)
      expect(payloads.length).toBeLessThanOrEqual(20)
      expect(Math.max(...payloads.map((payload) => new TextEncoder().encode(payload).length))).toBeGreaterThan(10_000)
      const events = payloads.map((payload) => {
        expect(new TextEncoder().encode(payload).length).toBeLessThanOrEqual(diagnosticLimits.bytes)
        return JSON.parse(payload)
      })
      expect(events[0]).toMatchObject({
        schemaVersion: 'bayn.broker-read-diagnostic.v1',
        environment: 'sandbox',
        account: {
          fields: {
            accrued_fees: { state: 'reported', type: 'string', value: '0.123456789012345678' },
            pending_reg_taf_fees: { state: 'reported', type: 'string', value: '0.01' },
          },
          evidence: { observedAt: '2025-06-11T08:00:00.000Z' },
        },
        omittedRecords: 1,
        incomplete: true,
        retentionTruncated: true,
      })
      expect(events[0].account.evidence.responseHash).toMatch(/^[0-9a-f]{64}$/)
      expect(events[0].pendingRecords).toBeGreaterThan(0)
      const fees = events.flatMap((event) => {
        expect(event.fees.length).toBeLessThanOrEqual(diagnosticLimits.records)
        expect(event.incomplete).toBe(true)
        expect(event.retentionTruncated).toBe(true)
        return event.fees
      })
      expect(fees).toHaveLength(diagnosticLimits.identities)
      for (const fee of fees) {
        expect(fee).toMatchObject({
          endpoint: '/v2/account/activities/FEE',
          fields: {
            status: { state: 'reported', value: 'executed' },
            entry_sub_type: { state: 'reported', value: 'TAF' },
            settle_date: { state: 'reported', value: '2025-06-11' },
            executed_at: { state: 'reported', value: '2025-06-11T07:00:00.000Z' },
            descriptionCategoryNonAuthoritative: { state: 'reported', value: 'TAF' },
          },
          evidence: { observedAt: '2025-06-11T08:00:00.000Z' },
        })
        expect(fee.evidence.responseHash).toMatch(/^[0-9a-f]{64}$/)
      }
      expect(events.at(-1).pendingRecords).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  10_000,
)
