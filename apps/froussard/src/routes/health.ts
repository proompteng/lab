import type { AppRuntime } from '@/effect/runtime'
import { logger } from '@/logger'
import type { KafkaProducerService } from '@/services/kafka'

export interface HealthHandlers {
  liveness: () => Response
  readiness: () => Response
}

interface HealthDependencies {
  runtime: AppRuntime
  kafka: KafkaProducerService
}

export const createHealthHandlers = ({ runtime, kafka }: HealthDependencies): HealthHandlers => {
  return {
    liveness: () => {
      logger.debug('Liveness check request received')
      return new Response('OK', { status: 200 })
    },
    readiness: () => {
      const ready = runtime.runSync(kafka.isReady)
      if (!ready) {
        logger.warn('Readiness check failed: Kafka producer not connected')
        return new Response('Kafka producer not connected', { status: 503 })
      }
      logger.debug('Readiness check request received')
      return new Response('OK', { status: 200 })
    },
  }
}
