export const parseBrokerList = (raw: string): string[] => {
  return raw
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0)
}
