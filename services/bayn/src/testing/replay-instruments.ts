import { equityMarketProfile } from '../jev/markets'

export const replayTestInstruments = {
  ...Object.fromEntries(
    equityMarketProfile.universe.map((symbol) => [
      symbol,
      {
        minimumQuantityAtoms: '1000000000',
        quantityIncrementAtoms: '1000000000',
        priceIncrementAtoms: '100000',
      },
    ]),
  ),
  ...Object.fromEntries(
    ['BTC/USD', 'ETH/USD', 'SOL/USD'].map((symbol) => [
      symbol,
      { minimumQuantityAtoms: '10000', quantityIncrementAtoms: '1', priceIncrementAtoms: '10000000' },
    ]),
  ),
}
