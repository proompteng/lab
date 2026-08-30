#!/usr/bin/env bun

import { applicationRegistry } from './registry'
import { checkImports } from './imports-check'
import { assertApplicationParity, checkApplicationSynthesis, synthesizeApplication } from './synth'

const args = process.argv.slice(2).filter((argument) => argument !== '--')
const command = args.shift()

const option = (name: string): string | undefined => {
  const indexes = args.flatMap((argument, index) => (argument === name ? [index] : []))
  if (indexes.length === 0) return undefined
  if (indexes.length > 1) throw new Error(`${name} may be specified only once`)
  const [index] = indexes
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

const assertNoUnknownArguments = (knownOptions: readonly string[], knownFlags: readonly string[] = []) => {
  const valueOptions = new Set(knownOptions)
  const flags = new Set(knownFlags)
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (valueOptions.has(argument)) {
      index += 1
      continue
    }
    if (flags.has(argument)) continue
    throw new Error(`Unknown argument: ${argument}`)
  }
}

const selectedApplication = () => {
  const name = option('--app')
  if (!name) throw new Error('--app is required')
  return applicationRegistry.get(name)
}

const main = () => {
  switch (command) {
    case 'synth': {
      assertNoUnknownArguments(['--app'], ['--all'])
      if (args.includes('--all')) throw new Error('Writing synthesis does not support --all; select one --app')
      const application = selectedApplication()
      synthesizeApplication(application)
      console.log(`Synthesized ${application.name} into ${application.outputDir}`)
      return
    }
    case 'check': {
      assertNoUnknownArguments(['--app'], ['--all'])
      if (args.filter((argument) => argument === '--all').length > 1) {
        throw new Error('--all may be specified only once')
      }
      const all = args.includes('--all')
      const appName = option('--app')
      if (all === Boolean(appName)) throw new Error('Select exactly one of --all or --app <name>')
      const applications = all ? applicationRegistry.applications : [applicationRegistry.get(appName!)]
      for (const application of applications) checkApplicationSynthesis(application)
      console.log(`Synthesis is current for ${applications.map(({ name }) => name).join(', ')}`)
      return
    }
    case 'imports-check':
      assertNoUnknownArguments([])
      checkImports()
      console.log('Imported API definitions are current')
      return
    case 'list':
      assertNoUnknownArguments([])
      for (const application of applicationRegistry.applications) console.log(application.name)
      return
    case 'parity': {
      assertNoUnknownArguments(['--app', '--baseline'])
      const application = selectedApplication()
      const baseline = option('--baseline')
      if (!baseline) throw new Error('--baseline is required')
      assertApplicationParity(application, baseline)
      console.log(`Semantic parity passed for ${application.name} against ${baseline}`)
      return
    }
    default:
      throw new Error(`Unknown command '${command ?? ''}'. Expected synth, check, imports-check, list, or parity`)
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
