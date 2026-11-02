import { Schema } from 'effect'

export const CashReportingQuantumSchema = Schema.Literals(['1', '10', '100', '1000', '10000'])
export type CashReportingQuantum = typeof CashReportingQuantumSchema.Type

export const cashReportingQuantum = (decimal: string): CashReportingQuantum => {
  const digits = decimal.split('.')[1]?.length ?? 0
  return digits <= 2 ? '10000' : digits === 3 ? '1000' : digits === 4 ? '100' : digits === 5 ? '10' : '1'
}

export const reportedCashMicros = (micros: string, quantum: CashReportingQuantum): string => {
  const amount = BigInt(micros)
  const increment = BigInt(quantum)
  const magnitude = amount < 0n ? -amount : amount
  const rounded = ((magnitude + increment / 2n) / increment) * increment
  return (amount < 0n ? -rounded : rounded).toString()
}
