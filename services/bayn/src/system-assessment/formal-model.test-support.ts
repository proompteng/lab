import { expect } from 'bun:test'
import { Schema } from 'effect'

export const formalModelExecutable = process.env['BAYN_FORMAL_EXECUTABLE']
export const runFormalModel = (inputs: readonly unknown[]): unknown[] => {
  if (formalModelExecutable === undefined)
    throw new Error('BAYN_FORMAL_EXECUTABLE must name the pinned built Lean model')
  const result = Bun.spawnSync([formalModelExecutable], {
    stdin: Buffer.from(inputs.map((input) => JSON.stringify(input)).join('\n') + '\n'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(`Lean model failed: ${result.stderr.toString()}`)
  const outputs = result.stdout
    .toString()
    .trim()
    .split('\n')
    .map(
      (line) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ result: Schema.Unknown })))(line).result,
    )
  expect(outputs).toHaveLength(inputs.length)
  return outputs
}
