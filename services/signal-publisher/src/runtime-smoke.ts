import { spawnSync } from 'node:child_process'
import process from 'node:process'

const [entrypoint, sourceRevision, imageRepository] = process.argv.slice(2)

if (!entrypoint || !sourceRevision || !imageRepository) {
  throw new Error('usage: runtime-smoke ENTRYPOINT SOURCE_REVISION IMAGE_REPOSITORY')
}

const result = spawnSync('node', [entrypoint, 'daily'], {
  encoding: 'utf8',
  timeout: 10_000,
  env: {
    ...process.env,
    SIGNAL_CLICKHOUSE_URL: 'http://127.0.0.1:1',
    SIGNAL_CLICKHOUSE_USERNAME: 'runtime-smoke',
    SIGNAL_CLICKHOUSE_PASSWORD: 'runtime-smoke',
    SIGNAL_ALPACA_DATA_URL: 'http://127.0.0.1:1',
    SIGNAL_ALPACA_TRADING_URL: 'http://127.0.0.1:1',
    APCA_API_KEY_ID: 'runtime-smoke',
    APCA_API_SECRET_KEY: 'runtime-smoke',
    SIGNAL_SYMBOLS: 'SPY',
    SIGNAL_START_DATE: '2026-07-17',
    SIGNAL_CODE_REVISION: sourceRevision,
    SIGNAL_IMAGE_REPOSITORY: imageRepository,
    SIGNAL_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
    SIGNAL_OPERATION_TIMEOUT_MS: '1000',
  },
})

if (result.error) throw result.error

const output = `${result.stdout}${result.stderr}`
if (
  result.status !== 1 ||
  !output.includes('ECONNREFUSED') ||
  !output.includes('"event":"publication_failed"') ||
  !output.includes('"phase":"storage"')
) {
  throw new Error(`bundled publisher did not reach the expected closed local endpoint:\n${output}`)
}
if (output.includes('exports_Undici is not defined')) {
  throw new Error(`bundled publisher loaded a broken Undici runtime:\n${output}`)
}
