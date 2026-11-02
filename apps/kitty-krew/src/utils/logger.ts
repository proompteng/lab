import winston from 'winston'

const { combine, timestamp, printf, colorize } = winston.format

const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`
})

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    process.env.NODE_ENV === 'development' ? colorize() : winston.format.uncolorize(),
    logFormat,
  ),
  exitOnError: false,
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
      consoleWarnLevels: ['warn'],
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      handleExceptions: true,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 10485760, // 10MB
      maxFiles: 3,
    }),
  ],
})

let isShuttingDown = false

async function flushAndExit(signal: NodeJS.Signals) {
  if (isShuttingDown) {
    return
  }

  isShuttingDown = true

  logger.info(`Received ${signal}, shutting down gracefully`)

  await new Promise<void>((resolve) => {
    logger.once('finish', resolve)
    logger.end()
  })

  for (const transport of logger.transports) {
    const maybeClosable = transport as { close?: () => void }
    if (typeof maybeClosable.close === 'function') {
      maybeClosable.close()
    }
  }

  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
  process.once(signal, () => {
    flushAndExit(signal).catch((error) => {
      console.error('Failed to shutdown logger', error)
      process.exit(1)
    })
  })
}
