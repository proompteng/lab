type PostgresErrorEmitter = {
  on: (event: 'error', listener: (error: Error) => void) => unknown
}

export const attachPostgresClientErrorLogger = (
  client: PostgresErrorEmitter,
  logWarning: (message: string, error: unknown) => void = console.warn,
) => {
  client.on('error', (error) => {
    logWarning('[jangar] postgres client error', error)
  })
}
