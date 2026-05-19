export const buildDeliveryIdLabels = (deliveryId: string): Record<string, string> => ({
  'agents.proompteng.ai/delivery-id': deliveryId,
  'jangar.proompteng.ai/delivery-id': deliveryId,
})
