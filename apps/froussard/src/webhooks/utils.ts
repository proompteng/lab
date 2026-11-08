import { Effect } from 'effect'
import { type KafkaMessage, KafkaProducer } from '@/services/kafka'

export const publishKafkaMessage = (message: KafkaMessage) =>
  Effect.flatMap(KafkaProducer, (kafka) => kafka.publish(message))
