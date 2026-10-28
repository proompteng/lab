import { Result } from 'effect'
import { prepareFrozenControlReplay } from './frozen-control-replay'
import { SystemAssessmentError } from './economics'

// Only plain values cross this boundary. The original offline engine owns its pinned Effect runtime.
export const validateFrozenRequest = (input: unknown, capture: string, captureHash: string) => {
  const result = prepareFrozenControlReplay(input, capture, captureHash)
  return Result.isSuccess(result)
    ? ({ ok: true, value: result.success } as const)
    : ({
        ok: false,
        message:
          result.failure instanceof SystemAssessmentError
            ? result.failure.message
            : 'Frozen replay request does not match its wire schema',
      } as const)
}
