import { Command } from '@effect/cli'
import * as Effect from 'effect/Effect'
import { getVersion } from '../legacy'
import {
  makeCompletionCommand,
  makeConfigCommand,
  makeDiagnoseCommand,
  makeExamplesCommand,
  makeHelpCommand,
  makeQuickstartCommand,
  makeStatusCommand,
  makeVersionCommand,
} from './commands/core'
import { makeResourceCommands } from './commands/resources'
import { makeRunCommand } from './commands/run'
import { renderShortHelp } from './help'

export const makeApp = () => {
  let root = Command.make('agentctl', {}, () =>
    Effect.sync(() => {
      console.log(renderShortHelp(getVersion()))
    }),
  )
  const getRoot = () => root

  const help = makeHelpCommand(getRoot)
  const examples = makeExamplesCommand()
  const quickstart = makeQuickstartCommand()
  const version = makeVersionCommand()
  const config = makeConfigCommand()
  const completion = makeCompletionCommand(getRoot)
  const status = makeStatusCommand()
  const diagnose = makeDiagnoseCommand()
  const run = makeRunCommand()
  const resources = makeResourceCommands()

  root = Command.withSubcommands(root, [
    help,
    examples,
    quickstart,
    version,
    config,
    completion,
    status,
    diagnose,
    run,
    ...resources,
  ])

  return root
}
