#!/usr/bin/env bun

const { flags } = parseArgs(process.argv.slice(2))
const tag = (flags.tag as string) ?? 'temporal-worker:latest'
const dockerfile = (flags.file as string) ?? 'Dockerfile'
const context = (flags.context as string) ?? '.'

const buildArgs = ['build', '-t', tag, '-f', dockerfile, context]
console.log(`docker ${buildArgs.join(' ')}`)

const proc = Bun.spawn(['docker', ...buildArgs], {
  stdout: 'inherit',
  stderr: 'inherit',
})

const exitCode = await proc.exited
if (exitCode !== 0) {
  throw new Error(`docker build exited with code ${exitCode}`)
}

function parseArgs(argv: string[]) {
  const args: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (!value.startsWith('-')) {
      args.push(value)
      continue
    }
    const flag = value.replace(/^-+/, '')
    const next = argv[i + 1]
    if (next && !next.startsWith('-')) {
      flags[flag] = next
      i++
    } else {
      flags[flag] = true
    }
  }
  return { args, flags }
}
