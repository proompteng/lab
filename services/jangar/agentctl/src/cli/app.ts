import { Command } from '@effect/cli'
import * as Effect from 'effect/Effect'
import { getVersion } from '../legacy'
import { makeAuthCommand } from './commands/auth'
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
import { makeCreateCommand } from './commands/create'
import { makeInitCommand } from './commands/init'
import { makeRunCommand } from './commands/run'
import {
  makeApplyCommand,
  makeDeleteCommand,
  makeDescribeCommand,
  makeExplainCommand,
  makeGetCommand,
  makeListCommand,
  makeWatchCommand,
} from './commands/verbs'
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
  const auth = makeAuthCommand()
  const create = makeCreateCommand()
  const init = makeInitCommand()
  const status = makeStatusCommand()
  const diagnose = makeDiagnoseCommand()
  const get = makeGetCommand()
  const describe = makeDescribeCommand()
  const list = makeListCommand()
  const watch = makeWatchCommand()
  const apply = makeApplyCommand()
  const del = makeDeleteCommand()
  const explain = makeExplainCommand()
  const run = makeRunCommand()

  root = Command.withSubcommands(root, [
    help,
    examples,
    quickstart,
    version,
    auth,
    config,
    completion,
    status,
    diagnose,
    get,
    describe,
    list,
    watch,
    apply,
    del,
    explain,
    create,
    init,
    run,
  ])

  return root
}
