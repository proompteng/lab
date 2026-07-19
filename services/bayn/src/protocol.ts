import type { TsmomProtocol } from './types'

import protocol from '../protocols/tsmom-v1.json' with { type: 'json' }

export const defaultProtocol = protocol as TsmomProtocol
