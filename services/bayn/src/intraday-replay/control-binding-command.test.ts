import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sha256 } from '../hash'
import { controlBindingFixture } from './control-binding.test-support'

const command = `${import.meta.dir}/../../tools/bind-control-input.ts`
const invoke = async (args: readonly string[]) => {
  const child = Bun.spawn([process.execPath, command, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

const writeFixture = (root: string) => {
  const fixture = controlBindingFixture()
  const plan = `${JSON.stringify(fixture.plan)}\n`
  const opening = `${JSON.stringify(fixture.opening)}\n`
  writeFileSync(join(root, 'plan.json'), plan, { mode: 0o600 })
  writeFileSync(join(root, 'opening.json'), opening, { mode: 0o600 })
  writeFileSync(join(root, 'export-manifest.json'), JSON.stringify(fixture.exported), { mode: 0o600 })
  writeFileSync(join(root, 'source.json'), JSON.stringify(fixture.source), { mode: 0o600 })
  writeFileSync(join(root, 'source-receipt.json'), fixture.receiptText, { mode: 0o600 })
  const output = join(root, 'bound')
  const args = [
    '--plan',
    join(root, 'plan.json'),
    '--plan-sha256',
    sha256(plan),
    '--opening',
    join(root, 'opening.json'),
    '--opening-sha256',
    sha256(opening),
    '--export',
    root,
    '--source-receipt-sha256',
    sha256(fixture.receiptText),
    '--output',
    output,
  ]
  return { fixture, args, output }
}

test('the binding CLI needs no credentials for help', async () => {
  const result = await invoke(['--help'])
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('--plan-sha256')
  expect(result.stderr).toBe('')
})

test('the CLI retains private, pinned inputs and rejects an overwrite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bayn-control-binding-'))
  try {
    const { fixture, args, output } = writeFixture(root)
    const result = await invoke(args)
    expect(result.exitCode).toBe(0)
    const inputText = readFileSync(join(output, 'input.json'), 'utf8')
    const input = JSON.parse(inputText)
    const binding = JSON.parse(readFileSync(join(output, 'binding.json'), 'utf8'))
    expect(input.openingPeakEquityMicros).toBe(fixture.opening.inputs.peakEquityMicros)
    expect(input.backtest.openingCashMicros).toBe(fixture.opening.inputs.portfolio.brokerState.account.cashMicros)
    expect(input.backtest.allocatedDataCostPerSessionMicros).toBeNull()
    expect(binding.inputSha256).toBe(sha256(inputText))
    expect(binding.planSha256).toBe(sha256(readFileSync(join(root, 'plan.json'))))
    expect(binding.openingSha256).toBe(sha256(readFileSync(join(root, 'opening.json'))))
    expect(JSON.parse(result.stdout).inputSha256).toBe(binding.inputSha256)
    expect(statSync(output).mode & 0o777).toBe(0o700)
    for (const name of ['input.json', 'binding.json']) expect(statSync(join(output, name)).mode & 0o777).toBe(0o600)
    const repeated = await invoke(args)
    expect(repeated.exitCode).not.toBe(0)
    expect(repeated.stderr).toContain('Binding output already exists')
    expect(readFileSync(join(output, 'input.json'), 'utf8')).toBe(inputText)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)

test.each(['plan', 'opening', 'source-receipt'] as const)(
  'a changed %s cannot publish binding output',
  async (name) => {
    const root = mkdtempSync(join(tmpdir(), 'bayn-control-binding-'))
    try {
      const { args, output } = writeFixture(root)
      writeFileSync(join(root, `${name}.json`), '{}\n')
      const result = await invoke(args)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain(
        name === 'source-receipt' ? 'independently pinned capture hash' : 'Input hash differs',
      )
      expect(() => statSync(output)).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  15000,
)
