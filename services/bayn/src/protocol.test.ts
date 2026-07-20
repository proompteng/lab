import { describe, expect, test } from 'bun:test'

import { Effect, Exit } from 'effect'

import { defaultProtocolDocument, hashTsmomParameters, loadDefaultProtocol, loadTsmomProtocol } from './protocol'

describe('TSMOM parameter contract', () => {
  test('runtime-decodes the committed immutable parameters', async () => {
    const protocol = await Effect.runPromise(loadDefaultProtocol)

    expect(protocol.schemaVersion).toBe('bayn.tsmom.protocol.v1')
    expect(protocol.universe).toEqual(['DBC', 'EEM', 'EFA', 'GLD', 'IEF', 'SPY', 'TLT', 'VNQ'])
    expect(hashTsmomParameters(protocol)).toMatch(/^[a-f0-9]{64}$/)
  })

  test('fails with a typed reason for malformed or non-canonical parameters', async () => {
    const invalidDocuments: readonly unknown[] = [
      { ...defaultProtocolDocument, universe: [...defaultProtocolDocument.universe, 'SPY'] },
      { ...defaultProtocolDocument, universe: [...defaultProtocolDocument.universe].reverse() },
      { ...defaultProtocolDocument, lookbacks: [] },
      { ...defaultProtocolDocument, lookbacks: [63, 21] },
      {
        ...defaultProtocolDocument,
        thresholds: { ...defaultProtocolDocument.thresholds, minimumObservations: 0 },
      },
      { ...defaultProtocolDocument, futureField: true },
    ]

    for (const document of invalidDocuments) {
      const exit = await Effect.runPromiseExit(loadTsmomProtocol(document))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain('invalid TSMOM parameters')
      }
    }
  })
})
