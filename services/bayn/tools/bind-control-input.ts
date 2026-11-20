import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Logger, Path, Schema, Stdio, Stream } from 'effect'

import { sha256 } from '../src/hash'
import { bindControlStudyInput } from '../src/intraday-replay/control-binding'
import { ControlStudyFailure } from '../src/intraday-replay/control-portfolio'
import { validateBacktestSourceReceipt } from '../src/intraday-replay/source'

const usage =
  'Usage: bun run control:bind --plan <json> --plan-sha256 <sha256> --opening <json> --opening-sha256 <sha256> --export <native-export-directory> --source-receipt-sha256 <sha256> --output <new-private-directory> | --help'
const allowed = new Set([
  '--plan',
  '--plan-sha256',
  '--opening',
  '--opening-sha256',
  '--export',
  '--source-receipt-sha256',
  '--output',
])

const runBindControlInputCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const print = (text: string) => Stream.run(Stream.make(`${text}\n`), stdio.stdout())
    if (args.length === 1 && args[0] === '--help') return yield* print(usage)
    const flags = new Map<string, string>()
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]
      const value = args[i + 1]
      if (
        key === undefined ||
        value === undefined ||
        !allowed.has(key) ||
        flags.has(key) ||
        value.trim() === '' ||
        value.startsWith('--')
      )
        return yield* new ControlStudyFailure({ message: usage })
      flags.set(key, value)
    }
    const planPath = flags.get('--plan')
    const planHash = flags.get('--plan-sha256')
    const openingPath = flags.get('--opening')
    const openingHash = flags.get('--opening-sha256')
    const exportPath = flags.get('--export')
    const receiptHash = flags.get('--source-receipt-sha256')
    const outputPath = flags.get('--output')
    if (
      planPath === undefined ||
      planHash === undefined ||
      openingPath === undefined ||
      openingHash === undefined ||
      exportPath === undefined ||
      receiptHash === undefined ||
      outputPath === undefined ||
      ![planHash, openingHash, receiptHash].every((hash) => /^[a-f0-9]{64}$/.test(hash))
    )
      return yield* new ControlStudyFailure({ message: usage })
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (yield* fs.exists(outputPath))
      return yield* new ControlStudyFailure({ message: 'Binding output already exists' })
    const readPinned = (file: string, expected: string) =>
      Effect.gen(function* () {
        const text = yield* fs.readFileString(file)
        if (sha256(text) !== expected) return yield* new ControlStudyFailure({ message: `Input hash differs: ${file}` })
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text)
      })
    const plan = yield* readPinned(planPath, planHash)
    const opening = yield* readPinned(openingPath, openingHash)
    const decodeFile = (name: string) =>
      fs
        .readFileString(path.join(exportPath, name))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))))
    const exported = yield* decodeFile('export-manifest.json')
    const source = yield* decodeFile('source.json')
    const receipt = yield* Effect.fromResult(
      validateBacktestSourceReceipt(
        yield* fs.readFileString(path.join(exportPath, 'source-receipt.json')),
        receiptHash,
      ),
    )
    const input = yield* Effect.fromResult(bindControlStudyInput(plan, opening, exported, source, receipt))
    const inputText = `${JSON.stringify(input, null, 2)}\n`
    const inputSha256 = sha256(inputText)
    yield* fs.makeDirectory(outputPath, { mode: 0o700 })
    yield* fs.writeFileString(path.join(outputPath, 'input.json'), inputText, { flag: 'wx', mode: 0o600 })
    const binding = {
      schemaVersion: 'bayn.control-study-binding.v1',
      planSha256: planHash,
      openingSha256: openingHash,
      sourceReceiptSha256: receiptHash,
      inputSha256,
      claims:
        'Input identity and capital binding only; no timestamp authentication, replay coverage or economic qualification',
    }
    const temporaryReceipt = path.join(outputPath, 'binding.json.tmp')
    yield* fs.writeFileString(temporaryReceipt, `${JSON.stringify(binding, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    yield* fs.rename(temporaryReceipt, path.join(outputPath, 'binding.json'))
    yield* print(JSON.stringify({ outputPath, inputSha256 }))
  })

if (import.meta.main)
  NodeRuntime.runMain(
    runBindControlInputCommand(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => Effect.logError(cause)),
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline binding command owns file and output services
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
