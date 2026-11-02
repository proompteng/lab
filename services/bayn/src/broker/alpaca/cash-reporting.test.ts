import { expect, test } from 'bun:test'
import { cashReportingQuantum, reportedCashMicros } from './cash-reporting'

test('cash reporting preserves cent precision when Alpaca trims trailing zeroes', () => {
  expect(cashReportingQuantum('99876.1')).toBe('10000')
  expect(cashReportingQuantum('100000')).toBe('10000')
  expect(cashReportingQuantum('99795.94')).toBe('10000')
  expect(reportedCashMicros('99795943504', '10000')).toBe('99795940000')
})
test('additional reported precision remains binding for either cash sign', () => {
  expect(cashReportingQuantum('1.123456')).toBe('1')
  expect(reportedCashMicros('1123456', '1')).toBe('1123456')
  expect(reportedCashMicros('-1123456', '10000')).toBe('-1120000')
  expect(reportedCashMicros('1125000', '10000')).toBe('1130000')
  expect(reportedCashMicros('-1125000', '10000')).toBe('-1130000')
})
