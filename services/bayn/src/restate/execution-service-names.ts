import { Config, Schema } from 'effect'

// Transport only: never include the namespace in the application plan or behavior hash.
export const restateServicePrefixConfig = Config.schema(
  Schema.String.check(Schema.isPattern(/^(?:[a-z][a-z0-9-]{0,31})?$/)),
  'BAYN_RESTATE_SERVICE_PREFIX',
).pipe(Config.withDefault(''))

const executionServices = {
  controller: 'BaynExecutionController',
  observations: 'BaynBrokerObservations',
  projector: 'BaynBrokerSourceProjector',
  activities: 'BaynBrokerActivities',
  inference: 'BaynEntryInference',
} as const

export const executionServiceName = (service: keyof typeof executionServices, prefix = '') =>
  prefix === '' ? executionServices[service] : `${prefix}-${executionServices[service]}`
