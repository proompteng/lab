import { describe, expect, test } from 'bun:test'
import { loadCandidateDevelopmentRuntimeMarketDataFile, validateCandidateDevelopmentModuleSource } from './test-api'
import {
  Effect,
  Fiber,
  Result,
  access,
  join,
  mkdtemp,
  pathToFileURL,
  readFile,
  rm,
  spawn,
  tmpdir,
  writeFile,
} from './test-runtime'
import {
  execFilePromise,
  execFileResultPromise,
  fixtureRuntimePreflightInput,
  fixtureStrategyProtocol,
  fixtureVerifiedSource,
} from './test-support'

describe('candidate development artifact syntax', () => {
  test('aborts an interrupted runtime market-data file read before artifact evaluation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-runtime-read-abort-'))
    const marketDataPath = join(directory, 'market-data.fifo')
    const writerPath = join(directory, 'writer.mjs')
    const readyPath = join(directory, 'writer-ready')
    const resultPath = join(directory, 'writer-result')
    const stopPath = join(directory, 'writer-stop')
    let writer: ReturnType<typeof spawn> | undefined
    let writerExited: Promise<{ readonly code: number | null; readonly stderr: string }> | undefined
    let artifactEvaluationEntries = 0
    const waitForPath = async (path: string, label: string): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          await access(path)
          return
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 10))
        }
      }
      throw new Error(`${label} was not observed`)
    }
    try {
      await execFilePromise('mkfifo', [marketDataPath], directory)
      await writeFile(
        writerPath,
        `import { access, open, writeFile } from 'node:fs/promises'
         const [marketDataPath, readyPath, resultPath, stopPath] = process.argv.slice(2)
         const handle = await open(marketDataPath, 'w')
         let writes = 0
         try {
           await writeFile(readyPath, 'ready')
           const chunk = Buffer.alloc(4096, 0x20)
           while (true) {
             try {
               await access(stopPath)
               await writeFile(resultPath, \`completed:\${writes}\`)
               break
             } catch {}
             await handle.write(chunk)
             writes += 1
             await new Promise((resolveWait) => setTimeout(resolveWait, 1))
           }
         } catch (cause) {
           const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : 'unknown'
           await writeFile(resultPath, \`aborted:\${code}:\${writes}\`)
         } finally {
           await handle.close().catch(() => undefined)
         }
        `,
      )
      const fiber = Effect.runFork(
        loadCandidateDevelopmentRuntimeMarketDataFile(marketDataPath)(
          fixtureVerifiedSource,
          fixtureStrategyProtocol,
          fixtureRuntimePreflightInput,
        ).pipe(
          Effect.flatMap(() =>
            Effect.sync(() => {
              artifactEvaluationEntries += 1
            }),
          ),
        ),
      )
      writer = spawn(process.execPath, [writerPath, marketDataPath, readyPath, resultPath, stopPath], {
        cwd: import.meta.dir,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      writerExited = new Promise((resolveExit, rejectExit) => {
        let stderr = ''
        writer?.stderr?.setEncoding('utf8')
        writer?.stderr?.on('data', (chunk: string) => {
          stderr += chunk
        })
        writer?.once('error', rejectExit)
        writer?.once('exit', (code) => resolveExit({ code, stderr }))
      })
      await waitForPath(readyPath, 'runtime market-data writer readiness')
      await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.timeout('1 second')))
      await waitForPath(resultPath, 'runtime market-data read cancellation')
      expect(await readFile(resultPath, 'utf8')).toMatch(/^aborted:EPIPE:\d+$/)
      expect(artifactEvaluationEntries).toBe(0)
      expect(await writerExited).toEqual({ code: 0, stderr: '' })
    } finally {
      await writeFile(stopPath, 'stop').catch(() => undefined)
      if (writer !== undefined && writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL')
      await writerExited?.catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  }, 10_000)

  test('rescans regex payloads after closed control-flow headers', async () => {
    const embeddedBars = [
      { sessionDate: '2026-01-02', open: 100, high: 101, low: 99, close: 100.5, volume: 1_000 },
      { sessionDate: '2026-01-05', open: 101, high: 102, low: 100, close: 101.5, volume: 1_001 },
    ]
    const payloadBits = Array.from(Buffer.from(JSON.stringify(embeddedBars), 'utf8'), (byte) =>
      byte.toString(2).padStart(8, '0'),
    ).join('')
    const whitespacePayload = Array.from(payloadBits, (bit) => (bit === '0' ? ' ' : '\t')).join('')
    const exploitSource = `let encoded = ''
      Object.defineProperty(RegExp.prototype, 'capture', {
        get() { encoded = this.source; return true },
      })
      if ((true)) /${whitespacePayload}/.capture
      const bits = Array.from(encoded, (value) =>
        value === ' ' ? '0' : value.charCodeAt(0) === 92 ? '1' : ''
      ).join('')
      let decoded = ''
      for (let index = 0; index < bits.length; index += 8) {
        decoded += String.fromCharCode(Number.parseInt(bits.slice(index, index + 8), 2))
      }
      export const embeddedBars = JSON.parse(decoded)
    `
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-control-flow-regex-'))
    const executablePath = join(directory, 'candidate.mjs')
    try {
      await writeFile(executablePath, exploitSource)
      const executed = (await import(pathToFileURL(executablePath).href)) as { readonly embeddedBars: unknown }
      expect(executed.embeddedBars).toEqual(embeddedBars)
      expect(validateCandidateDevelopmentModuleSource(exploitSource, 'candidate/control-flow-regex.mjs')).toMatchObject(
        {
          failure: {
            _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
            operation: 'verify-module-format',
            cause: {
              literalPayload: {
                regularExpressionLiteralLengths: [payloadBits.length],
              },
            },
          },
        },
      )
      const control = `if ((true)) /SPY|DBC/.test('SPY')
        while (false) /unused/.test('unused')
        const methods = { if() { return 4 } }
        export const ok = methods.if() / 2 === 2
      `
      expect(validateCandidateDevelopmentModuleSource(control, 'candidate/control-flow-regex-control.mjs')).toEqual(
        Result.succeed(undefined),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('derives regex payloads after every parsed statement block without reclassifying division', async () => {
    const embeddedBars = [
      { sessionDate: '2026-01-02', open: 100, high: 101, low: 99, close: 100.5, volume: 1_000 },
      { sessionDate: '2026-01-05', open: 101, high: 102, low: 100, close: 101.5, volume: 1_001 },
    ]
    const payloadBits = Array.from(Buffer.from(JSON.stringify(embeddedBars), 'utf8'), (byte) =>
      byte.toString(2).padStart(8, '0'),
    ).join('')
    const whitespacePayload = Array.from(payloadBits, (bit) => (bit === '0' ? ' ' : '\t')).join('')
    const exploitSource = `let encoded = ''
      Object.defineProperty(RegExp.prototype, 'captureBlock', {
        get() { encoded = this.source; return true },
      })
      if (true) {} /${whitespacePayload}/.captureBlock
      const bits = Array.from(encoded, (value) =>
        value === ' ' ? '0' : value.charCodeAt(0) === 92 ? '1' : ''
      ).join('')
      let decoded = ''
      for (let index = 0; index < bits.length; index += 8) {
        decoded += String.fromCharCode(Number.parseInt(bits.slice(index, index + 8), 2))
      }
      process.stdout.write(JSON.stringify(JSON.parse(decoded)))
    `
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-post-block-regex-'))
    const executablePath = join(directory, 'candidate.mjs')
    try {
      await writeFile(executablePath, exploitSource)
      expect(await execFileResultPromise(process.execPath, [executablePath], directory)).toEqual({
        exitCode: 0,
        stdout: JSON.stringify(embeddedBars),
        stderr: '',
      })
      expect(validateCandidateDevelopmentModuleSource(exploitSource, 'candidate/post-block-regex.mjs')).toMatchObject({
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-module-format',
          cause: {
            literalPayload: {
              regularExpressionLiteralLengths: expect.arrayContaining([payloadBits.length]),
            },
          },
        },
      })
      const control = `
        if (true) {} /SPY|DBC/.test('SPY')
        label: {} /EFA/.test('EFA')
        function declared() {} /IEF/.test('IEF')
        class Declared {} /VNQ/.test('VNQ')
        const objectValue = ({ value: 8 }).value / 2
        const objectLiteralDivision = ({ value: 8 }) / 2
        export const ok = declared !== undefined && Declared !== undefined && objectValue === 4 && Number.isNaN(objectLiteralDivision)
      `
      expect(validateCandidateDevelopmentModuleSource(control, 'candidate/post-block-regex-control.mjs')).toEqual(
        Result.succeed(undefined),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('bounds exempt immutable decimal scalars to a canonical U128 representation', async () => {
    const embeddedBars = [
      { sessionDate: '2026-01-02', open: 100, high: 101, low: 99, close: 100.5, volume: 1_000 },
      { sessionDate: '2026-01-05', open: 101, high: 102, low: 100, close: 101.5, volume: 1_001 },
    ]
    const decimalPayload = BigInt(`0x${Buffer.from(JSON.stringify(embeddedBars), 'utf8').toString('hex')}`).toString()
    const exploitSource = `
      export const candidateDevelopmentArtifact = {
        strategyProtocol: { initialCapitalMicros: '${decimalPayload}' },
        buildEvaluation: () => {
          const hex = BigInt(candidateDevelopmentArtifact.strategyProtocol.initialCapitalMicros).toString(16)
          return JSON.parse(Buffer.from(hex.length % 2 === 0 ? hex : '0' + hex, 'hex').toString('utf8'))
        },
      }
      export const embeddedBars = candidateDevelopmentArtifact.buildEvaluation()
    `
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-immutable-decimal-payload-'))
    const executablePath = join(directory, 'candidate.mjs')
    try {
      await writeFile(executablePath, exploitSource)
      const executed = (await import(pathToFileURL(executablePath).href)) as { readonly embeddedBars: unknown }
      expect(executed.embeddedBars).toEqual(embeddedBars)
      expect(
        validateCandidateDevelopmentModuleSource(exploitSource, 'candidate/immutable-decimal-payload.mjs'),
      ).toMatchObject({
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-module-format',
          cause: {
            literalPayload: {
              outOfRangeImmutableDecimalScalars: [
                {
                  path: 'strategyProtocol.initialCapitalMicros',
                  length: decimalPayload.length,
                  maximumLength: 39,
                  exceedsMaximumValue: true,
                },
              ],
            },
          },
        },
      })
      const boundedControl = `export const candidateDevelopmentArtifact = {
        strategyProtocol: { initialCapitalMicros: '340282366920938463463374607431768211455' },
        buildEvaluation: () => null,
      }\n`
      expect(
        validateCandidateDevelopmentModuleSource(boundedControl, 'candidate/immutable-decimal-control.mjs'),
      ).toEqual(Result.succeed(undefined))
      const overMaximumControl = boundedControl.replace(
        '340282366920938463463374607431768211455',
        '340282366920938463463374607431768211456',
      )
      expect(
        validateCandidateDevelopmentModuleSource(overMaximumControl, 'candidate/immutable-decimal-over-maximum.mjs'),
      ).toMatchObject({
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-module-format',
          cause: {
            literalPayload: {
              outOfRangeImmutableDecimalScalars: [
                {
                  path: 'strategyProtocol.initialCapitalMicros',
                  length: 39,
                  maximumLength: 39,
                  exceedsMaximumValue: true,
                },
              ],
            },
          },
        },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    expect(
      await access(directory).then(
        () => false,
        () => true,
      ),
    ).toBe(true)
  })

  test('rejects punctuation-only call payloads and bounds executable syntax and arguments', async () => {
    const embeddedBars = [
      { sessionDate: '2026-01-02', open: 100, high: 101, low: 99, close: 100.5, volume: 1_000 },
      { sessionDate: '2026-01-05', open: 101, high: 102, low: 100, close: 101.5, volume: 1_001 },
    ]
    const serializedBars = JSON.stringify(embeddedBars)
    const payloadBits = Array.from(Buffer.from(serializedBars, 'utf8'), (byte) =>
      byte.toString(2).padStart(8, '0'),
    ).join('')
    const callArguments = Array.from(payloadBits, (bit) => (bit === '0' ? '[]' : '{}')).join(',')
    const exploitSource = `const decode = (...values) => JSON.parse(values.reduce(
      (text, _, offset) => offset % 8 === 0
        ? text + String.fromCharCode(values.slice(offset, offset + 8).reduce(
            (byte, value) => byte * 2 + (Array.isArray(value) ? 0 : 1),
            0,
          ))
        : text,
      '',
    ))
    export const embeddedBars = decode(${callArguments})
    `
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-call-argument-payload-'))
    const executablePath = join(directory, 'candidate.mjs')
    try {
      await writeFile(executablePath, exploitSource)
      const executed = (await import(pathToFileURL(executablePath).href)) as { readonly embeddedBars: unknown }
      expect(executed.embeddedBars).toEqual(embeddedBars)

      expect(
        validateCandidateDevelopmentModuleSource(exploitSource, 'candidate/call-argument-payload.mjs'),
      ).toMatchObject({
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-module-format',
          cause: {
            literalPayload: {
              executableKeywordOperatorCount: 0,
              largestParenthesizedArgumentList: payloadBits.length,
            },
          },
        },
      })

      const punctuationBudgetSource = `export const payload = ${'('.repeat(257)}{}${')'.repeat(257)}\n`
      expect(
        validateCandidateDevelopmentModuleSource(punctuationBudgetSource, 'candidate/punctuation-budget.mjs'),
      ).toMatchObject({
        failure: {
          cause: {
            literalPayload: {
              executablePunctuationCount: 517,
              parenthesizedArgumentListCount: 0,
            },
          },
        },
      })

      const keywordOperatorExpressions = Array.from({ length: 33 }, (_, index) =>
        index % 2 === 0 ? 'void []' : 'typeof {}',
      ).join('\n')
      const keywordOperatorBudgetSource = `${keywordOperatorExpressions}\nexport const operatorControl = true\n`
      expect(
        validateCandidateDevelopmentModuleSource(keywordOperatorBudgetSource, 'candidate/keyword-operator-budget.mjs'),
      ).toMatchObject({
        failure: {
          cause: {
            literalPayload: {
              executableKeywordOperatorCount: 33,
              executableKeywordOperatorBytes: 164,
            },
          },
        },
      })

      const newArgumentBudgetSource = `export const payload = new Array(${Array.from({ length: 33 }, () => '{}').join(',')})\n`
      expect(
        validateCandidateDevelopmentModuleSource(newArgumentBudgetSource, 'candidate/new-argument-budget.mjs'),
      ).toMatchObject({
        failure: {
          cause: {
            literalPayload: {
              parenthesizedArgumentCount: 33,
              largestParenthesizedArgumentList: 33,
            },
          },
        },
      })

      const conciseControl = `const pair = (left, right) => [left, right]
      const values = pair([], {})
      const wrapped = new Array(values[0], values[1])
      const disposable = { value: 1 }
      const removed = delete disposable.value
      export const control =
        typeof values === 'object' &&
        void 0 === undefined &&
        'length' in values &&
        values instanceof Array &&
        wrapped.length === 2 &&
        removed
      `
      expect(
        validateCandidateDevelopmentModuleSource(conciseControl, 'candidate/executable-syntax-control.mjs'),
      ).toEqual(Result.succeed(undefined))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    expect(
      await access(directory).then(
        () => false,
        () => true,
      ),
    ).toBe(true)
  })
})
