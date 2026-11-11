import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ProductionFault {
  readonly name: string
  readonly file: string
  readonly before: string
  readonly after: string
  readonly test: string
  readonly testFile: string
}

export const checkProductionFaults = (
  faults: readonly ProductionFault[],
  service: string,
  output: string,
  env: Record<string, string | undefined>,
) => {
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
  for (const fault of faults) {
    const directory = join(output, `production-${fault.name}`)
    mkdirSync(directory)
    const source = join(service, fault.file)
    const originalHash = digest(source)
    const preload = join(directory, 'preload.ts')
    const marker = `BAYN_PRODUCTION_MUTATION_APPLIED:${fault.name}`
    writeFileSync(
      preload,
      `import { plugin } from 'bun'
import { readFileSync } from 'node:fs'
plugin({
  name: ${JSON.stringify(fault.name)},
  setup(build) {
    build.onLoad({ filter: new RegExp(${JSON.stringify(`${fault.file.replaceAll('.', '\\.')}$`)}) }, ({ path }) => {
      if (path !== ${JSON.stringify(source)}) throw Error('Mutation resolved a different production module')
      const before = ${JSON.stringify(fault.before)}
      const original = readFileSync(path, 'utf8')
      if (original.split(before).length !== 2) throw Error('Mutation no longer identifies one production guard')
      console.error(${JSON.stringify(marker)})
      return { contents: original.replace(before, ${JSON.stringify(fault.after)}), loader: 'ts' }
    })
  },
})
`,
    )
    const result = Bun.spawnSync(
      [process.execPath, 'test', '--preload', preload, fault.testFile, '--test-name-pattern', fault.test],
      { cwd: service, env: { ...env, NO_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 },
    )
    const log = result.stdout.toString() + result.stderr.toString()
    writeFileSync(join(directory, 'test.log'), log)
    if (digest(source) !== originalHash) throw Error(`Production source changed during ${fault.name}`)
    const failures = log.split('\n').filter((line) => line.startsWith('(fail) '))
    if (
      result.exitCode !== 1 ||
      log.split(marker).length !== 2 ||
      failures.length !== 1 ||
      !failures.some((line) => line.includes(fault.test)) ||
      !log.includes('error: expect(received).')
    ) {
      console.error(log)
      throw Error(`Production conformance did not detect ${fault.name}; retained ${directory}`)
    }
    writeFileSync(
      join(directory, 'source.json'),
      `${JSON.stringify({ file: fault.file, sha256: originalHash, test: fault.test }, null, 2)}\n`,
    )
    console.log(`${fault.name}: production conformance rejected the injected defect`)
  }
}
