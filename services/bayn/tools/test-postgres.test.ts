import { expect, test } from 'bun:test'
import timings from './ci-postgres-timings.json'
import { postgresFiles, postgresShard } from './test-postgres'

test('four PostgreSQL shards execute every owned file once', () => {
  const shards = [1, 2, 3, 4].map((index) => postgresShard(`${index}/4`, timings.files))
  expect(shards.flat().sort()).toEqual([...postgresFiles].sort())
  expect(shards.every((files) => files.length > 0)).toBe(true)
})

test('adjacent slow files are distributed before packing the remaining work', () => {
  const weights = Object.fromEntries(postgresFiles.map((file, index) => [file, index < 4 ? 1000 : 1]))
  const shards = [1, 2, 3, 4].map((index) => postgresShard(`${index}/4`, weights))
  const loads = shards.map((files) => files.reduce((sum, file) => sum + (weights[file] ?? 0), 0))
  const average = loads.reduce((sum, load) => sum + load, 0) / 4
  expect(Math.max(...loads)).toBe(Math.ceil(average))
})

test('unmeasured new files use the measured median until their first CI duration', () => {
  const weights = Object.fromEntries(postgresFiles.slice(0, 4).map((file) => [file, 1000]))
  const counts = [1, 2, 3, 4].map((index) => postgresShard(`${index}/4`, weights).length)
  expect(Math.max(...counts) - Math.min(...counts)).toBe(1)
})

test('local unsharded PostgreSQL execution retains the complete suite', () => {
  expect(postgresShard('1/1', timings.files).sort()).toEqual([...postgresFiles].sort())
})

test.each(['0/4', '5/4', '1/0', '1/46', '1/a', '3/2', '1/4/'])(
  'invalid PostgreSQL shard %s fails before execution',
  (shard) => expect(() => postgresShard(shard, timings.files)).toThrow(),
)
