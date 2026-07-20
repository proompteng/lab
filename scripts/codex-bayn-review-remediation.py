from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'missing expected text in {path}: {old[:80]!r}')
    file.write_text(text.replace(old, new, 1))


replace(
    'services/bayn/src/ledger.ts',
    """      const address = configuredAddress.trim()
      if (/^\\d+$/.test(address)) {
        parsePort(address, address)
        return [address]
      }

      const separator = address.lastIndexOf(':')
""",
    """      const address = configuredAddress.trim()
      const addressFamily = isIP(address)
      if (addressFamily === 4) return [address]
      if (addressFamily === 6) throw new Error(`IPv6 TigerBeetle replica addresses are not supported: ${address}`)
      if (/^\\d+$/.test(address)) {
        parsePort(address, address)
        return [address]
      }

      const separator = address.lastIndexOf(':')
""",
)
replace(
    'services/bayn/src/ledger.ts',
    """      const addressFamily = isIP(hostname)
      if (addressFamily === 4) return [`${hostname}:${port}`]
      if (addressFamily === 6) throw new Error(`IPv6 TigerBeetle replica addresses are not supported: ${address}`)
""",
    """      const hostnameFamily = isIP(hostname)
      if (hostnameFamily === 4) return [`${hostname}:${port}`]
      if (hostnameFamily === 6) throw new Error(`IPv6 TigerBeetle replica addresses are not supported: ${address}`)
""",
)
replace(
    'services/bayn/src/ledger.test.ts',
    """      ['torghut-tigerbeetle.torghut.svc.cluster.local:3000', '10.244.5.234:3000', '3001'],
""",
    """      ['torghut-tigerbeetle.torghut.svc.cluster.local:3000', '10.244.5.234:3000', '127.0.0.1', '3001'],
""",
)
replace(
    'services/bayn/src/ledger.test.ts',
    """    expect(addresses).toEqual(['10.244.5.234:3000', '10.244.5.235:3000', '3001'])
""",
    """    expect(addresses).toEqual(['10.244.5.234:3000', '10.244.5.235:3000', '127.0.0.1', '3001'])
""",
)
replace(
    'services/bayn/src/ledger.test.ts',
    """    expect(resolveReplicaAddresses(['replica:3000'], async () => ['::1'])).rejects.toThrow('has no IPv4 address')
""",
    """    expect(resolveReplicaAddresses(['replica:3000'], async () => ['::1'])).rejects.toThrow('has no IPv4 address')
    expect(resolveReplicaAddresses(['::1'])).rejects.toThrow('IPv6 TigerBeetle replica addresses are not supported')
""",
)
replace('services/bayn/src/strategy.ts', 'const metrics = (\n', 'export const calculatePerformanceMetrics = (\n')
replace(
    'services/bayn/src/strategy.ts',
    """  const returns = equity.slice(1).map((value, index) => value / equity[index] - 1)
""",
    """  const returns = [equity[0] / initialCapital - 1, ...equity.slice(1).map((value, index) => value / equity[index] - 1)]
""",
)
replace(
    'services/bayn/src/strategy.ts',
    '  return { metrics: metrics(equity, turnover, totalFees, initialCapital), events }\n',
    '  return { metrics: calculatePerformanceMetrics(equity, turnover, totalFees, initialCapital), events }\n',
)
replace(
    'services/bayn/src/strategy.test.ts',
    "import { evaluateTsmom } from './strategy'\n",
    "import { calculatePerformanceMetrics, evaluateTsmom } from './strategy'\n",
)
replace(
    'services/bayn/src/strategy.test.ts',
    """describe('TSMOM economic evaluator', () => {
""",
    """describe('TSMOM economic evaluator', () => {
  test('includes the initial trading session in return statistics', () => {
    const result = calculatePerformanceMetrics([90, 99], 0, 0, 100)
    expect(result.totalReturn).toBeCloseTo(-0.01)
    expect(result.annualizedVolatility).toBeCloseTo(Math.sqrt(0.02) * Math.sqrt(252))
    expect(result.sharpe).toBeCloseTo(0)
  })

""",
)

Path('.github/workflows/codex-bayn-review-remediation.yml').unlink()
Path('scripts/codex-bayn-review-remediation.py').unlink()
