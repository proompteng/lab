const requireEnv = (name: string): string => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

interface CommandOption {
  name: string
  description: string
  type: number
  required?: boolean
}

interface SlashCommand {
  name: string
  description: string
  options?: CommandOption[]
}

const commands: SlashCommand[] = [
  {
    name: 'plan',
    description: 'Collect context for a Facteur planning run via modal input.',
  },
]

const discordApiBase = 'https://discord.com/api/v10'

const main = async () => {
  const applicationId = requireEnv('DISCORD_APPLICATION_ID')
  const guildId = requireEnv('DISCORD_GUILD_ID')
  const botToken = requireEnv('DISCORD_BOT_TOKEN')

  const url = `${discordApiBase}/applications/${applicationId}/guilds/${guildId}/commands`
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${botToken}`,
    },
    body: JSON.stringify(commands),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to register commands (${response.status}): ${text}`)
  }

  const registered = (await response.json()) as SlashCommand[]
  console.log(`Registered ${registered.length} commands: ${registered.map((cmd) => cmd.name).join(', ')}`)
}

main().catch((error) => {
  console.error('Command registration failed:', error)
  process.exitCode = 1
})
