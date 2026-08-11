export const uniqueRows = <Row>(rows: readonly Row[], key: (row: Row) => string): ReadonlyMap<string, Row | null> => {
  const byKey = new Map<string, Row | null>()
  for (const row of rows) {
    const identity = key(row)
    byKey.set(identity, byKey.has(identity) ? null : row)
  }
  return byKey
}

export interface IntentExecutionKeyInput {
  readonly cycleId: string
  readonly decisionHash: string
  readonly accountId: string
  readonly symbol: string
  readonly side: 'BUY' | 'SELL'
  readonly quantityMicros: string
  readonly replanGenerationHash?: string
  readonly createdAt: string
}

export const intentExecutionKey = (input: IntentExecutionKeyInput): string =>
  JSON.stringify([
    input.cycleId,
    input.decisionHash,
    input.accountId,
    input.symbol,
    input.side,
    input.quantityMicros,
    input.replanGenerationHash ?? null,
    input.createdAt,
  ])
