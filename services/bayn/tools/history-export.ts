import { createHash } from 'node:crypto'
import { createGzip, createGunzip, gzipSync } from 'node:zlib'
import { NodeStream } from '@effect/platform-node'
import { Cause, DateTime, Effect, FileSystem, Pull, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { canonicalHashV1Result, canonicalJsonV1Result, sha256 } from '../src/hash'
import {
  BacktestSourceManifestSchema,
  validateBacktestSourceManifest,
  validateBacktestSourceReceipt,
  type BacktestSourceManifest,
} from '../src/intraday-replay/source'
import {
  GitSourceRevisionSchema,
  IsoDateSchema,
  NonNegativeIntegerSchema,
  Sha256Schema,
  strictParseOptions,
} from '../src/schemas'
import {
  HistoricalMarketArrivalSchema,
  arrivalPosition,
  compareArrivalPositions,
  type HistoricalMarketArrival,
} from '../src/market-data/streaming/historical'
import {
  HistoricalDatasetFailure,
  readHistoricalChunk,
  readHistoricalDataset,
} from '../src/market-data/alpaca-history/dataset'
import { restCaptureArrivals } from '../src/market-data/alpaca-history/arrivals'
import { writeImmutableDatasetFile } from './backfill'

const DelaySchema = NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(60_000))
export const HistoricalExportRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-history-export.v1'),
  datasetId: Sha256Schema,
  sessionDates: Schema.Array(IsoDateSchema).check(Schema.isMinLength(1), Schema.isUnique()),
  universe: BacktestSourceManifestSchema.fields.universe,
  rawDeliveryDelayMs: DelaySchema,
  barFinalizationDelayMs: DelaySchema,
  featureProcessingDelayMs: DelaySchema,
  featureProducerRevision: GitSourceRevisionSchema,
  featureJarSha256: Sha256Schema,
})

const compare = (a: HistoricalMarketArrival, b: HistoricalMarketArrival) =>
  compareArrivalPositions(arrivalPosition(a), arrivalPosition(b))
const decodeArrival = Schema.decodeUnknownEffect(
  Schema.fromJsonString(HistoricalMarketArrivalSchema),
  strictParseOptions,
)

const mergeArrivalBatch = (paths: readonly string[]) =>
  Stream.fromPull(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const sources = yield* Effect.forEach(paths, (path) =>
        Effect.gen(function* () {
          const file = fs.stream(path)
          const bytes = path.endsWith('.gz')
            ? file.pipe(
                NodeStream.pipeThroughDuplex({
                  evaluate: () => createGunzip(),
                  onError: (cause) =>
                    new HistoricalDatasetFailure({ message: 'Historical export decompression failed', cause }),
                }),
              )
            : file
          const pull = yield* Stream.toPull(
            bytes.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.mapEffect((line) => decodeArrival(line)),
              Stream.rechunk(1),
            ),
          )
          const next = pull.pipe(
            Effect.map((chunk) => chunk[0]),
            Pull.catchDone(() => Effect.void),
            Effect.map((event) => event ?? undefined),
          )
          const source: {
            next: typeof next
            head: HistoricalMarketArrival | undefined
            previous: HistoricalMarketArrival | undefined
          } = { next, head: yield* next, previous: undefined }
          return source
        }),
      )
      // @effect-diagnostics-next-line returnEffectInGen:off -- Stream.fromPull requires the acquired pull Effect as a value
      return Effect.gen(function* () {
        let selected: (typeof sources)[number] | undefined
        for (const source of sources) {
          if (source.head !== undefined && (selected?.head === undefined || compare(source.head, selected.head) < 0))
            selected = source
        }
        if (selected === undefined || selected.head === undefined) return yield* Cause.done()
        const event = selected.head
        if (selected.previous !== undefined && compare(selected.previous, event) > 0)
          return yield* new HistoricalDatasetFailure({ message: 'Historical export input reverses arrival order' })
        selected.previous = event
        selected.head = yield* selected.next
        return [event] as const
      })
    }),
  )

/** Stable external merge with at most 32 input streams open, regardless of the dataset's session count. */
export const mergeArrivalFiles = (paths: readonly string[]) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fanIn = 32
      if (paths.length <= fanIn) return mergeArrivalBatch(paths)
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-history-merge-' })
      let inputs = paths,
        round = 0
      while (inputs.length > fanIn) {
        const outputs: string[] = []
        for (let start = 0; start < inputs.length; start += fanIn) {
          const path = `${directory}/${round}-${outputs.length}.ndjson.gz`
          yield* mergeArrivalBatch(inputs.slice(start, start + fanIn)).pipe(
            Stream.map((event) => `${JSON.stringify(event)}\n`),
            Stream.concat(Stream.make('')),
            Stream.grouped(512),
            // Bounded gzip members propagate upstream failures without a separate duplex writer fiber.
            Stream.mapEffect((rows) =>
              Effect.try({
                try: () => gzipSync(rows.join(''), { level: 1 }),
                catch: (cause) =>
                  new HistoricalDatasetFailure({ message: 'Historical merge compression failed', cause }),
              }),
            ),
            Stream.run(fs.sink(path, { flag: 'wx', mode: 0o600 })),
            Effect.scoped,
          )
          outputs.push(path)
          // Original source files remain immutable; completed intermediate rounds are disposable.
          if (round > 0) for (const input of inputs.slice(start, start + fanIn)) yield* fs.remove(input)
        }
        inputs = outputs
        round++
      }
      return mergeArrivalBatch(inputs)
    }),
  )

const writeArrivals = <E, R>(path: string, stream: Stream.Stream<HistoricalMarketArrival, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = yield* fs.open(path, { flag: 'wx', mode: 0o600 })
    const hash = createHash('sha256')
    const offsets = new Map<string, number>()
    let recordCount = 0,
      firstAvailableAtMs: number | undefined,
      lastAvailableAtMs: number | undefined
    const serialized = stream.pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          const next = offsets.get(event.record.topic) ?? 0
          if (event.record.partition !== 0 || event.record.offset !== String(next))
            return yield* new HistoricalDatasetFailure({
              message: 'Export offsets must be consecutive within each virtual topic',
            })
          offsets.set(event.record.topic, next + 1)
          firstAvailableAtMs ??= event.availableAtMs
          lastAvailableAtMs = event.availableAtMs
          recordCount++
          return `${JSON.stringify(event)}\n`
        }),
      ),
      Stream.grouped(512),
      Stream.map((rows) => new TextEncoder().encode(rows.join(''))),
    )
    const bytes = path.endsWith('.gz')
      ? serialized.pipe(
          NodeStream.pipeThroughDuplex({
            evaluate: () => createGzip({ level: 1 }),
            onError: (cause) =>
              new HistoricalDatasetFailure({ message: 'Historical export compression failed', cause }),
          }),
        )
      : serialized
    yield* Stream.runForEach(bytes, (chunk) =>
      file.writeAll(chunk).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            hash.update(chunk)
          }),
        ),
      ),
    )
    yield* file.sync
    return { dataSha256: hash.digest('hex'), recordCount, firstAvailableAtMs, lastAvailableAtMs, offsets }
  })

const FeatureReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal('dorvud.retained-feature-replay-receipt.v2'),
  config: Schema.Record(Schema.String, Schema.Unknown),
  configSha256: Sha256Schema,
  outputSha256: Sha256Schema,
  outputRecordCount: NonNegativeIntegerSchema,
  skippedBars: NonNegativeIntegerSchema,
  rejectedBars: NonNegativeIntegerSchema,
  recordedAtMs: NonNegativeIntegerSchema,
  coordinates: Schema.Literal('isolated-simulation-partition-zero-offset-order'),
  delivery: Schema.Literal(
    'max(previous-output-availability,max(triggering-raw-arrival,window-end)+processing-delay); actual computedAt is retained',
  ),
})

/** Export is preparation only; every resulting dataset runs through bayn-backtest's canonical engine. */
export const exportHistoricalDataset = (
  input: unknown,
  datasetDirectory: string,
  outputDirectory: string,
  featureJar: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknownEffect(HistoricalExportRequestSchema, strictParseOptions)(input)
      const fs = yield* FileSystem.FileSystem
      if (
        request.universe.symbols.join(',') !== [...new Set(request.universe.symbols)].sort().join(',') ||
        request.universe.universeSymbolHash !== sha256(request.universe.symbols.join(',')) ||
        new Set(Object.values(request.universe.topics)).size !== Object.values(request.universe.topics).length
      )
        return yield* new HistoricalDatasetFailure({
          message: 'Historical export requires a canonical universe and distinct source topics',
        })
      const dataset = yield* readHistoricalDataset(datasetDirectory, request.datasetId)
      if (
        request.sessionDates.some((date, index) => index > 0 && date <= (request.sessionDates[index - 1] ?? '')) ||
        request.universe.topics.technicalFeatures === undefined
      )
        return yield* new HistoricalDatasetFailure({
          message: 'Export requires ordered sessions and both rolling and technical feature topics',
        })
      const sessions = dataset.sessions.filter((session) => request.sessionDates.some((date) => date === session.date))
      const first = sessions[0],
        last = sessions.at(-1)
      if (
        first === undefined ||
        last === undefined ||
        sessions.length !== request.sessionDates.length ||
        dataset.sessions.filter((day) => day.date >= first.date && day.date <= last.date).length !== sessions.length
      )
        return yield* new HistoricalDatasetFailure({
          message: 'Export sessions must be consecutive broker calendar sessions in the frozen dataset',
        })
      if (
        dataset.manifest.request.symbols.some((symbol) => !request.universe.symbols.includes(symbol)) ||
        request.sessionDates.some((date) => !dataset.manifest.request.executionSessions.includes(date))
      )
        return yield* new HistoricalDatasetFailure({
          message:
            'Execution export requires retained bars, quotes and trades for its declared dataset symbols and sessions',
        })
      const chunks = dataset.manifest.chunks.filter((chunk) => request.sessionDates.includes(chunk.sessionDate))
      for (const date of request.sessionDates)
        for (const symbol of dataset.manifest.request.symbols)
          for (const kind of ['bars', 'quotes', 'trades']) {
            const covered = dataset.coverage.filter(
              (row) => row.sessionDate === date && row.symbol === symbol && row.kind === kind,
            )
            if (covered.length !== 1)
              return yield* new HistoricalDatasetFailure({
                message: `Missing or duplicate ${kind} coverage for ${symbol} on ${date}`,
              })
          }
      const jarHash = createHash('sha256')
      yield* Stream.runForEach(fs.stream(featureJar), (bytes) =>
        Effect.sync(() => {
          jarHash.update(bytes)
        }),
      )
      if (jarHash.digest('hex') !== request.featureJarSha256)
        return yield* new HistoricalDatasetFailure({ message: 'Dorvud feature jar differs from the pinned hash' })
      yield* fs.makeDirectory(outputDirectory, { mode: 0o700 })
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-history-export-' })
      const parts: string[] = [],
        barParts: string[] = []
      let boundaryRecordsExcluded = 0
      for (const chunk of chunks) {
        const session = sessions.find((day) => day.date === chunk.sessionDate)
        if (session === undefined)
          return yield* new HistoricalDatasetFailure({ message: 'Chunk session is outside the export selection' })
        const capture = yield* readHistoricalChunk(dataset, chunk)
        const arrivals = yield* Effect.fromResult(
          restCaptureArrivals({
            datasetId: request.datasetId,
            capture,
            topics: request.universe.topics,
            sessionOpenAt: session.openAt,
            sessionCloseAt: session.closeAt,
            rawDeliveryDelayMs: request.rawDeliveryDelayMs,
            barFinalizationDelayMs: request.barFinalizationDelayMs,
          }),
        )
        boundaryRecordsExcluded += capture.rows.length - arrivals.count
        const part = `${temp}/${chunk.queryHash}.ndjson.gz`
        yield* Effect.scoped(writeArrivals(part, Stream.fromIterable(arrivals.arrivals)))
        parts.push(part)
        if (chunk.kind === 'bars') barParts.push(part)
      }
      const barsPath = `${temp}/bars.ndjson`
      const rawOffsets = new Map<string, number>()
      const assignOffsets = (event: HistoricalMarketArrival): HistoricalMarketArrival => {
        const offset = rawOffsets.get(event.record.topic) ?? 0
        rawOffsets.set(event.record.topic, offset + 1)
        return { ...event, record: { ...event.record, offset: String(offset) } }
      }
      const bars = yield* Effect.scoped(
        writeArrivals(barsPath, mergeArrivalFiles(barParts).pipe(Stream.map(assignOffsets))),
      )
      rawOffsets.clear()
      if (bars.recordCount === 0)
        return yield* new HistoricalDatasetFailure({ message: 'Historical export has no regular-session bars' })
      const featureConfig = {
        schemaVersion: 'dorvud.retained-feature-replay.v2',
        sourceSha256: bars.dataSha256,
        recordCount: bars.recordCount,
        barsTopic: request.universe.topics.bars,
        rollingFeaturesTopic: request.universe.topics.features,
        technicalFeaturesTopic: request.universe.topics.technicalFeatures,
        feed: dataset.manifest.feed,
        universeId: request.universe.universeId,
        universeSymbolHash: request.universe.universeSymbolHash,
        symbols: request.universe.symbols,
        producerRevision: request.featureProducerRevision,
        processingDelayMs: request.featureProcessingDelayMs,
      }
      const featureConfigText = `${yield* Effect.fromResult(canonicalJsonV1Result(featureConfig))}\n`
      const configPath = `${outputDirectory}/feature-config.json`,
        featuresPath = `${outputDirectory}/features`
      yield* writeImmutableDatasetFile(configPath, featureConfigText)
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const process = yield* spawner.spawn(
        ChildProcess.make(
          'java',
          [
            '-cp',
            featureJar,
            'ai.proompteng.dorvud.ta.flink.RetainedFeatureReplay',
            configPath,
            barsPath,
            featuresPath,
          ],
          { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
        ),
      )
      if (Number(yield* process.exitCode) !== 0)
        return yield* new HistoricalDatasetFailure({ message: 'Dorvud historical feature production failed' })
      const featureText = yield* fs.readFileString(`${featuresPath}/receipt.json`)
      const featureReceipt = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(FeatureReceiptSchema),
        strictParseOptions,
      )(featureText)
      if (
        featureReceipt.configSha256 !== sha256(featureConfigText) ||
        (yield* Effect.fromResult(canonicalHashV1Result(featureReceipt.config))) !==
          (yield* Effect.fromResult(canonicalHashV1Result(featureConfig))) ||
        featureReceipt.skippedBars !== 0 ||
        featureReceipt.rejectedBars !== 0
      )
        return yield* new HistoricalDatasetFailure({
          message: 'Dorvud did not accept every selected regular-session bar under the pinned configuration',
        })
      const featureStats = yield* Effect.scoped(
        writeArrivals(`${temp}/verified-features.ndjson`, mergeArrivalFiles([`${featuresPath}/arrivals.ndjson`])),
      )
      const featureBytesHash = createHash('sha256')
      yield* Stream.runForEach(fs.stream(`${featuresPath}/arrivals.ndjson`), (bytes) =>
        Effect.sync(() => {
          featureBytesHash.update(bytes)
        }),
      )
      if (
        featureBytesHash.digest('hex') !== featureReceipt.outputSha256 ||
        featureStats.recordCount !== featureReceipt.outputRecordCount
      )
        return yield* new HistoricalDatasetFailure({
          message: 'Dorvud feature bytes or record count differ from its receipt',
        })
      const source = yield* Effect.scoped(
        writeArrivals(
          `${outputDirectory}/arrivals.ndjson.gz`,
          mergeArrivalFiles([...parts, `${temp}/verified-features.ndjson`]).pipe(Stream.map(assignOffsets)),
        ),
      )
      if (source.firstAvailableAtMs === undefined || source.lastAvailableAtMs === undefined)
        return yield* new HistoricalDatasetFailure({ message: 'Historical source is empty' })
      const origin = `alpaca-history:${request.datasetId}`
      const manifest: BacktestSourceManifest = {
        schemaVersion: 'bayn.backtest-source.v1',
        encoding: 'ndjson-gzip',
        transport: 'alpaca-rest',
        dataSha256: source.dataSha256,
        recordCount: source.recordCount,
        coverageStartMs: Date.parse(first.openAt),
        coverageEndMs:
          Date.parse(last.closeAt) +
          request.rawDeliveryDelayMs +
          request.barFinalizationDelayMs +
          request.featureProcessingDelayMs,
        firstAvailableAtMs: source.firstAvailableAtMs,
        lastAvailableAtMs: source.lastAvailableAtMs,
        origin,
        positions: Object.values(request.universe.topics)
          .sort()
          .map((topic) => ({
            topic,
            partition: 0,
            startOffset: '0',
            endOffsetExclusive: String(source.offsets.get(topic) ?? 0),
          })),
        universe: request.universe,
        deliveryModel: {
          schemaVersion: 'bayn.supplied-arrival-times.v1',
          description: `REST as of retrieval; modeled raw delay ${request.rawDeliveryDelayMs}ms, minute-bar finalization delay ${request.barFinalizationDelayMs}ms, Dorvud processing delay ${request.featureProcessingDelayMs}ms. Original stream arrivals and revisions were not observed.`,
          tieBreak: 'availability-topic-partition-offset',
        },
        regeneratedFeaturesRecordedAtMs: featureReceipt.recordedAtMs,
      }
      yield* Effect.fromResult(validateBacktestSourceManifest(manifest))
      const recordedAt = DateTime.formatIso(yield* DateTime.now)
      const receipt = {
        schemaVersion: 'bayn.alpaca-rest-replay-receipt.v1',
        recordedAt,
        origin,
        datasetId: request.datasetId,
        rawChunkHashes: chunks.map((chunk) => chunk.sha256),
        featureReceiptHash: sha256(featureText),
        sourceDataSha256: source.dataSha256,
        normalization: 'bayn.alpaca-rest-arrivals.v1',
        coordinates: 'virtual-topic-partition-zero-offset-order',
        originalStreamAvailability: 'NOT_OBSERVED',
        coverageStartMs: manifest.coverageStartMs,
        coverageEndMs: manifest.coverageEndMs,
        universe: manifest.universe,
        positions: manifest.positions,
      }
      const receiptText = `${yield* Effect.fromResult(canonicalJsonV1Result(receipt))}\n`,
        receiptHash = sha256(receiptText)
      yield* Effect.fromResult(validateBacktestSourceReceipt(receiptText, receiptHash))
      for (const [name, value] of [
        ['request.json', request],
        ['source.json', manifest],
        ['calendar.json', dataset.calendar.filter((day) => request.sessionDates.includes(day.date))],
        ['coverage.json', dataset.coverage.filter((row) => request.sessionDates.includes(row.sessionDate))],
        ['export.json', { request, boundaryRecordsExcluded, receiptHash, sourceHash: source.dataSha256 }],
      ] as const)
        yield* writeImmutableDatasetFile(
          `${outputDirectory}/${name}`,
          `${yield* Effect.fromResult(canonicalJsonV1Result(value))}\n`,
        )
      yield* writeImmutableDatasetFile(`${outputDirectory}/source-receipt.json`, receiptText)
      return {
        datasetId: request.datasetId,
        recordCount: source.recordCount,
        sourceReceiptHash: receiptHash,
        boundaryRecordsExcluded,
      }
    }),
  )
