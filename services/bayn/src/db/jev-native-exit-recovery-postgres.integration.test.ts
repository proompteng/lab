import { setDefaultTimeout, test } from 'bun:test'
import { describeNativeJevPostgres } from './jev-native-postgres.test-support'
import { nativeExitPersistence } from './jev-native-exit-postgres.test-support'

setDefaultTimeout(30_000)

describeNativeJevPostgres((postgres) => {
  test.each([
    'fee-source',
    'recovery',
    'protection-committed-ack-loss',
    'protection-receipt-missing',
    'protection-native-tp-keeps-coverage',
  ])('native exit persistence: %s', (scenario) => nativeExitPersistence(postgres, scenario), 30_000)
})
