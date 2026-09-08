import { SelectValue } from '@proompteng/design/ui'

type StrategyOption = {
  id: string
  name: string
}

type TorghutStrategySelectValueProps = {
  placeholder: string
  strategyId: string
  strategies: readonly StrategyOption[]
}

export const getTorghutStrategySelectLabel = (
  strategyId: string,
  strategies: readonly StrategyOption[],
): string | undefined => strategies.find((strategy) => strategy.id === strategyId)?.name

export function TorghutStrategySelectValue({ placeholder, strategyId, strategies }: TorghutStrategySelectValueProps) {
  return <SelectValue placeholder={placeholder}>{getTorghutStrategySelectLabel(strategyId, strategies)}</SelectValue>
}
