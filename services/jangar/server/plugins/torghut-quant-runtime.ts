import { defineNitroPlugin } from 'nitro/runtime'

import { startTorghutQuantRuntime } from '../../src/server/torghut-quant-runtime'

export default defineNitroPlugin(() => {
  startTorghutQuantRuntime()
})
