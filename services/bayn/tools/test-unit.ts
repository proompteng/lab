import { isUnitTest } from './test-plan'
import { fileURLToPath } from 'node:url'

const files: unknown = JSON.parse(process.env['BAYN_UNIT_FILES'] ?? '[]')
if (
  !Array.isArray(files) ||
  !files.every((file): file is string => typeof file === 'string' && isUnitTest(`services/bayn/${file}`))
)
  throw Error('BAYN_UNIT_FILES must contain only owned unit test paths')
const [shard, ...extra] = process.argv.slice(2)
if (shard === undefined || !/^[1-4]\/[1-4]$/.test(shard) || extra.length > 0 || Number(shard[0]) > Number(shard[2]))
  throw Error('Usage: bun tools/test-unit.ts <index/count>, with at most four shards')
const result = Bun.spawnSync(
  [
    process.execPath,
    'test',
    ...(files.length > 0 ? files.map((file) => `./${file}`) : ['src', 'tools']),
    '--parallel=2',
    `--shard=${shard}`,
    '--timeout=15000',
    '--timings=tools/ci-unit-timings.json',
    '--update-timings',
    '--reporter=junit',
    '--reporter-outfile=unit-results.xml',
  ],
  { cwd: fileURLToPath(new URL('..', import.meta.url)), stdout: 'inherit', stderr: 'inherit' },
)
process.exit(result.exitCode)
