import { mkdirSync, writeFileSync } from 'node:fs'
import fc from 'fast-check'

const integerOption = (name: string, fallback: number, minimum: number, maximum: number): number => {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer in [${minimum}, ${maximum}]`)
  return value
}

/** Fixed CI corpus; opt-in mutation campaigns retain fast-check's minimized input and replay coordinates. */
const options = (defaultRuns: number) => {
  const path = process.env['BAYN_PROPERTY_PATH']
  return {
    seed: integerOption('BAYN_PROPERTY_SEED', 20261003, -2147483648, 2147483647),
    numRuns: integerOption('BAYN_PROPERTY_RUNS', defaultRuns, 1, 100_000),
    ...(path === undefined ? {} : { path }),
    // A time-limited campaign must fail rather than silently accept an incomplete corpus.
    interruptAfterTimeLimit: 120_000,
    markInterruptAsFailure: true,
  }
}

const report = <T>(name: string, details: fc.RunDetails<T>): void => {
  if (!details.failed) return
  const directory = new URL('../../.fuzz-failures/', import.meta.url)
  mkdirSync(directory, { recursive: true })
  const artifact = new URL(`${name}-${details.seed}.json`, directory)
  writeFileSync(
    artifact,
    JSON.stringify(
      {
        property: name,
        seed: details.seed,
        path: details.counterexamplePath,
        runs: details.numRuns,
        shrinks: details.numShrinks,
        counterexample: details.counterexample,
        error: details.error,
      },
      (_key, value: unknown) => (typeof value === 'bigint' ? `${value}n` : value),
      2,
    ),
  )
  throw new Error(`${fc.defaultReportMessage(details)}\nMinimized regression: ${artifact.pathname}`)
}

export const checkProperty = <T>(name: string, property: fc.IProperty<T>, defaultRuns = 100): void =>
  report(name, fc.check(property, options(defaultRuns)))

export const checkAsyncProperty = async <T>(
  name: string,
  property: fc.IAsyncProperty<T>,
  defaultRuns = 100,
): Promise<void> => report(name, await fc.check(property, options(defaultRuns)))
