import { expect, test } from 'bun:test'

test.each(['mandate', 'contracts', 'risk-policy'])('%s initializes in a fresh process', (entry) => {
  // A shared test process can hide a cycle by initializing contracts before the affected entry point.
  const modules = [entry, 'mandate', 'contracts'].map((name) => new URL(`./${name}.ts`, import.meta.url).href)
  const result = Bun.spawnSync([
    process.execPath,
    '--eval',
    modules.map((module) => `await import(${JSON.stringify(module)})`).join('\n'),
  ])
  expect({ exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) }).toEqual({
    exitCode: 0,
    stderr: '',
  })
})
