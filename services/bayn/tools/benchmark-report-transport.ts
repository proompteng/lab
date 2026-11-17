import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { gunzipSync } from 'node:zlib'

// Run the bundled tool with Node from the repository root. Fixture loading and worker startup are not timed.
// This isolates PostgreSQL JSON parsing plus structured cloning; complete verification is covered by parity tests.
assert.equal(process.versions.bun, undefined, 'Run this benchmark with native Node')
const text = gunzipSync(readFileSync('services/bayn/src/jev/fixtures/retained-v38/entry-equity.json.gz')).toString(
  'utf8',
)
const digest = createHash('sha256')
  .update(JSON.stringify(JSON.parse(text)))
  .digest('hex')
const count = 196
const concurrency = process.arch === 'arm64' ? 16 : 8
const metadata = { cycle_id: 'a'.repeat(64), decision_hash: 'b'.repeat(64), created_at: new Date(0) }
const workerCode = `
  const { parentPort } = require('node:worker_threads')
  const { createHash } = require('node:crypto')
  parentPort.on('message', row => {
    const document = row.document_json === undefined ? row.document : JSON.parse(row.document_json)
    parentPort.postMessage(createHash('sha256').update(JSON.stringify(document)).digest('hex'))
  })
`
type Transport = 'object' | 'json'
const run = async (transport: Transport) => {
  const workers = Array.from({ length: concurrency }, () => new Worker(workerCode, { eval: true }))
  try {
    await Promise.all(workers.map((worker) => once(worker, 'online')))
    let submitted = 0
    let managerParseMs = 0
    let managerPostMs = 0
    const started = performance.now()
    const cpuStarted = process.cpuUsage()
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            worker.once('error', reject)
            const submit = () => {
              if (submitted++ >= count) return resolve()
              const parsing = performance.now()
              const row =
                transport === 'object'
                  ? { ...metadata, document: JSON.parse(text) }
                  : { ...metadata, document_json: text }
              managerParseMs += performance.now() - parsing
              const posting = performance.now()
              worker.postMessage(row)
              managerPostMs += performance.now() - posting
            }
            worker.on('message', (actual: unknown) => {
              if (actual !== digest) return reject(new Error('Transport changed the parsed document'))
              submit()
            })
            submit()
          }),
      ),
    )
    const used = process.cpuUsage(cpuStarted)
    return {
      elapsedMs: performance.now() - started,
      processCpuMs: (used.user + used.system) / 1_000,
      managerParseMs,
      managerPostMs,
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()))
  }
}
const samples: Record<Transport, Awaited<ReturnType<typeof run>>[]> = { object: [], json: [] }
for (let round = 0; round < 4; round++) {
  for (const transport of round % 2 === 0 ? (['object', 'json'] as const) : (['json', 'object'] as const)) {
    const result = await run(transport)
    if (round > 0) samples[transport].push(result)
  }
}
const median = (values: readonly number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
console.log(
  JSON.stringify({
    node: process.version,
    arch: process.arch,
    count,
    concurrency,
    documentBytes: Buffer.byteLength(text),
    samples,
    medianElapsedMs: Object.fromEntries(
      Object.entries(samples).map(([key, rows]) => [key, median(rows.map((row) => row.elapsedMs))]),
    ),
    exactParsedDocumentEquality: true,
    limitation: 'Repeated retained fixture transport only; this does not establish the complete report deadline',
  }),
)
