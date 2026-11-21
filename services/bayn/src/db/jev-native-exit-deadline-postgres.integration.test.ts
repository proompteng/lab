import { setDefaultTimeout, test } from 'bun:test'
import { describeNativeJevPostgres } from './jev-native-postgres.test-support'
import { nativeExitPersistence } from './jev-native-exit-postgres.test-support'

setDefaultTimeout(30_000)

describeNativeJevPostgres((postgres) => {
  test.each([
    'expires-during-insert',
    'expires-before-commit',
    'measured-expires-during-insert',
    'measured-expires-before-commit',
    'measured-on-time',
  ])('native exit persistence: %s', (scenario) => nativeExitPersistence(postgres, scenario), 30_000)
})
