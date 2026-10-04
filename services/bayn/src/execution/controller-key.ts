import { Schema } from 'effect'

export const ExecutionControllerKeySchema = Schema.Trim.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/))
