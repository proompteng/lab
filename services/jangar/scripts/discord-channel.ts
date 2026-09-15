import process from 'node:process'
import type { ChannelMetadata, DiscordConfig } from '@proompteng/discord'
import { bootstrapChannel, DISCORD_MESSAGE_LIMIT, iterableFromStream, streamChannel } from '@proompteng/discord'

interface ParsedArgs {
  stage?: string
  repository?: string
  issue?: string
  url?: string
  title?: string
  runId?: string
  dryRun: boolean
  timestamp?: string
  summary?: string
}

const usage = () => {
  console.log(`Usage: discord-channel [options]

Streams stdin to a Discord channel created for this Codex run.

Options:
  --stage <name>        Stage identifier (e.g. plan, implementation).
  --repo <owner/name>   GitHub repository slug.
  --issue <number>      GitHub issue number.
  --url <uri>           Direct link to the issue or pull request.
  --title <text>        Optional display title for the run.
  --run-id <id>         Additional identifier appended to the channel name.
  --timestamp <iso>     ISO timestamp used for deterministic naming.
  --summary <text>      Optional summary content included in the intro message.
  --dry-run             Print intended actions without talking to Discord.
  -h, --help            Show this help message.

Environment:
  DISCORD_BOT_TOKEN     Discord bot token with channel management scope.
  DISCORD_GUILD_ID      Discord guild identifier.
  DISCORD_CATEGORY_ID   Optional category to place channel streams under.
`)
}

const parseArgs = (argv: string[]): ParsedArgs => {
  const options: ParsedArgs = { dryRun: false }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const requireValue = (flag: string): string => {
      if (i + 1 >= argv.length) {
        console.error(`Missing value for ${flag}`)
        usage()
        process.exit(1)
      }
      i += 1
      return argv[i] ?? ''
    }
    switch (arg) {
      case '--stage':
        options.stage = requireValue('--stage')
        break
      case '--repo':
        options.repository = requireValue('--repo')
        break
      case '--issue':
        options.issue = requireValue('--issue')
        break
      case '--url':
        options.url = requireValue('--url')
        break
      case '--title':
        options.title = requireValue('--title')
        break
      case '--run-id':
        options.runId = requireValue('--run-id')
        break
      case '--timestamp':
        options.timestamp = requireValue('--timestamp')
        break
      case '--summary':
        options.summary = requireValue('--summary')
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '-h':
      case '--help':
        usage()
        process.exit(0)
        break
      default:
        if (!arg) {
          console.error('Unexpected missing argument')
          usage()
          process.exit(1)
        }
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`)
          usage()
          process.exit(1)
        } else {
          console.error(`Unexpected argument: ${arg}`)
          usage()
          process.exit(1)
        }
    }
  }

  return options
}

const main = async () => {
  const argv = process.argv.slice(2)
  const options = parseArgs(argv)
  const dryRun = options.dryRun

  const botToken = process.env.DISCORD_BOT_TOKEN
  const guildId = process.env.DISCORD_GUILD_ID
  const categoryId = process.env.DISCORD_CATEGORY_ID

  if (!dryRun && (!botToken || !guildId)) {
    console.error('Missing Discord configuration: DISCORD_BOT_TOKEN and DISCORD_GUILD_ID are required')
    process.exit(2)
  }

  const config: DiscordConfig = {
    botToken: botToken ?? 'dry-run-token',
    guildId: guildId ?? 'dry-run-guild',
    categoryId: categoryId ?? undefined,
  }

  const createdAt = options.timestamp ? new Date(options.timestamp) : new Date()
  if (Number.isNaN(createdAt.getTime())) {
    console.error(`Invalid timestamp provided: ${options.timestamp}`)
    process.exit(1)
  }

  const metadata: ChannelMetadata = {
    repository: options.repository,
    issueNumber: options.issue,
    stage: options.stage ?? 'run',
    runId: options.runId,
    title: options.title,
    createdAt,
    summary: options.summary,
    issueUrl: options.url,
  }

  const echo = (line: string) => console.error(line)

  try {
    const channel = await bootstrapChannel(config, metadata, { dryRun, echo })
    echo(`Channel ready: #${channel.channelName} (${channel.url ?? 'no-url'})`)
    echo(`Message chunk limit: ${DISCORD_MESSAGE_LIMIT} characters`)
    await streamChannel(config, channel, iterableFromStream(process.stdin), { dryRun, echo })
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unknown error')
    if (error instanceof Error && 'stack' in error && error.stack) {
      console.error(error.stack)
    }
    process.exit(1)
  }
}

await main()
