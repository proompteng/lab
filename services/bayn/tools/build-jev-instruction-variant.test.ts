import { expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { Cause, Effect, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../src/hash'
import { JevRequestSchema } from '../src/jev/contract'
import { jevInstructions } from '../src/jev/instructions'
import { JevInstructionsSchema } from '../src/jev/instructions-contract'
import { buildJevInstructionVariant, jevInstructionsBuildPlugin } from './jev-instruction-variant'

const root = resolve(import.meta.dir, '../../..')
const instructionModule = join(root, 'services/bayn/src/jev/instructions.ts')
const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))
const ProbeSchema = Schema.Struct({
  instructions: JevInstructionsSchema,
  request: JevRequestSchema,
  selectedSymbols: Schema.Array(Schema.String),
  injected: Schema.Boolean,
})

test('compiled candidate requests and decisions pass native reproduction with only the complete-plan instruction changed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bayn-jev-variant-'))
  try {
    await symlink(join(root, 'services/bayn/node_modules'), join(directory, 'node_modules'))
    const entrypoint = join(directory, 'probe.ts')
    const source = (path: string) => JSON.stringify(join(root, 'services/bayn/src', path))
    await writeFile(
      entrypoint,
      `
      import { Result, Schema } from 'effect';
      import { nativeJevFixture, nativeJevDecisionEvidence } from ${source('jev/native.test-support.ts')};
      import { decideJevEntry, JevEntryTargetSchema } from ${source('jev/decision.ts')};
      import { makeJevTradingSignalRequest } from ${source('jev/trading-signals.ts')};
      import { jevInstructions } from ${source('jev/instructions.ts')};
      const fixture = nativeJevFixture();
      const target = Result.getOrThrow(decideJevEntry(nativeJevDecisionEvidence(fixture)));
      const checked = Schema.decodeUnknownSync(JevEntryTargetSchema)(target);
      const request = Result.getOrThrow(makeJevTradingSignalRequest(fixture.observation.payload, 'AAPL'));
      process.stdout.write(JSON.stringify({ instructions: jevInstructions, request: request.request,
        selectedSymbols: checked.selectedSymbols, injected: Object.hasOwn(globalThis, '__jevInjected') }));
    `,
    )
    const probe = async (instructions: typeof JevInstructionsSchema.Type) => {
      const replacement = jevInstructionsBuildPlugin(instructionModule, instructions)
      const built = await Bun.build({ entrypoints: [entrypoint], target: 'node', plugins: [replacement.plugin] })
      expect(built.success).toBe(true)
      expect(replacement.replacements()).toBe(1)
      const output = built.outputs[0]
      if (output === undefined) throw new Error('Missing compiled probe')
      const path = join(directory, `${hash(instructions)}.mjs`)
      await writeFile(path, new Uint8Array(await output.arrayBuffer()))
      const process = Bun.spawn(['node', path], { stdout: 'pipe', stderr: 'pipe' })
      try {
        const [stdout, stderr, status] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ])
        expect({ status, stderr }).toEqual({ status: 0, stderr: '' })
        return Schema.decodeUnknownSync(Schema.fromJsonString(ProbeSchema))(stdout)
      } finally {
        process.kill()
      }
    }
    const baseline = await probe(jevInstructions)
    const candidate = {
      entry: 'Assess the supplied entry evidence. Literal text: ";globalThis.__jevInjected=true;//',
    }
    const edited = await probe(candidate)
    expect(edited.instructions).toEqual(candidate)
    expect(edited.injected).toBe(false)
    expect(edited.request.state).toEqual(baseline.request.state)
    expect(edited.selectedSymbols).toEqual(baseline.selectedSymbols)
    const question = edited.request.questions['action']
    expect(question?.instructions).toBe(candidate.entry)
    expect({ ...question, instructions: null }).toEqual({
      ...baseline.request.questions['action'],
      instructions: null,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test('the frozen compiler rejects an unverified source revision before creating an executable directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bayn-jev-source-check-'))
  try {
    const result = await Effect.runPromiseExit(
      buildJevInstructionVariant(
        {
          schemaVersion: 'bayn.jev-instruction-variant.v1',
          evaluation: 'portfolio',
          sourceRevision: '0'.repeat(40),
          imageRepository: 'registry.ide-newton.ts.net/lab/bayn',
          baseImageDigest: `sha256:${'a'.repeat(64)}`,
          instructions: jevInstructions,
          dependencyReceiptSha256: 'd'.repeat(64),
        },
        root,
        join(directory, 'never-built'),
        '{}',
      ).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- test entry point owns the source-check process
        Effect.provide(NodeServices.layer),
      ),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(Cause.pretty(result.cause)).toContain('revision differs')
    expect(await Bun.file(join(directory, 'never-built/backtest.js')).exists()).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
