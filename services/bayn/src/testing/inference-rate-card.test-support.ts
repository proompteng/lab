import { Result, Schema } from 'effect'

import { InferenceRateCardSchema, type InferenceRateSchema, prepareInferenceRateCard } from '../inference-costs'
import { jevModel } from '../jev/contract'
import { decisionsModel } from '../jev/decisions'

type Rate = typeof InferenceRateSchema.Type
type Prices = Pick<Rate, 'inputMicrosPerMillionTokens' | 'outputMicrosPerMillionTokens'>
type ChartPrices = Pick<
  Extract<Rate, { provider: 'openai' }>,
  | 'inputMicrosPerMillionTokens'
  | 'outputMicrosPerMillionTokens'
  | 'cachedInputMicrosPerMillionTokens'
  | 'cacheWriteInputMicrosPerMillionTokens'
>

export const replayRateCardFixture = (tariff: { readonly jev: Prices | null; readonly chart: ChartPrices | null }) => {
  const card = Schema.decodeUnknownSync(InferenceRateCardSchema)({
    schemaVersion: 'bayn.inference-rate-card.v1',
    rates: [
      ...(tariff.jev === null ? [] : [{ provider: 'typesafe', model: jevModel, ...tariff.jev }]),
      ...(tariff.chart === null ? [] : [{ provider: 'openai', model: decisionsModel, ...tariff.chart }]),
    ].map((rate) => ({
      ...rate,
      currency: 'USD',
      source: 'Synthetic registered tariff',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      effectiveUntil: '2027-01-01T00:00:00.000Z',
    })),
  })
  const { rates } = Result.getOrThrow(prepareInferenceRateCard(card))
  return { ...card, rates: rates.toSorted((a, b) => a.rateHash.localeCompare(b.rateHash)).map(({ rate }) => rate) }
}
