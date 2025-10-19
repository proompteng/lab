import { ensureNativeBridgeStub } from './helpers/native-bridge-stub'

if (!process.env.TEMPORAL_BUN_SDK_NATIVE_PATH) {
  process.env.TEMPORAL_BUN_SDK_NATIVE_PATH = ensureNativeBridgeStub()
}
