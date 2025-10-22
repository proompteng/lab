// Payment activity using @proompteng/temporal-bun-sdk
type PaymentInput = {
  amount: number
  currency?: string
  paymentMethod: string
  customerId: string
}

type RefundInput = {
  transactionId: string
  amount: number
  reason?: string
}

type ValidatePaymentInput = {
  paymentMethod: string
  customerId: string
}

export async function processPayment(input: PaymentInput) {
  console.log('💳 Processing payment:', input)

  const { amount, currency = 'USD', paymentMethod, customerId } = input

  // Validate input
  if (!amount || amount <= 0) {
    throw new Error('Invalid payment amount')
  }

  if (!paymentMethod) {
    throw new Error('Payment method is required')
  }

  if (!customerId) {
    throw new Error('Customer ID is required')
  }

  // Simulate payment processing
  await Bun.sleep(150)

  // Simulate occasional failures
  if (Math.random() < 0.03) {
    // 3% failure rate
    throw new Error('Payment gateway temporarily unavailable')
  }

  // Simulate insufficient funds
  if (amount > 10000) {
    throw new Error('Insufficient funds')
  }

  const result = {
    success: true,
    transactionId: `txn_${Date.now()}`,
    amount,
    currency,
    paymentMethod,
    customerId,
    processedAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Payment processed successfully:', result.transactionId)
  return result
}

export async function refundPayment(input: RefundInput) {
  console.log('🔄 Processing refund:', input)

  const { transactionId, amount, reason } = input

  if (!transactionId) {
    throw new Error('Transaction ID is required for refund')
  }

  if (!amount || amount <= 0) {
    throw new Error('Invalid refund amount')
  }

  // Simulate refund processing
  await Bun.sleep(200)

  // Simulate occasional failures
  if (Math.random() < 0.02) {
    // 2% failure rate
    throw new Error('Refund service temporarily unavailable')
  }

  const result = {
    success: true,
    refundId: `refund_${Date.now()}`,
    originalTransactionId: transactionId,
    amount,
    reason,
    processedAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Refund processed successfully:', result.refundId)
  return result
}

export async function validatePaymentMethod(input: ValidatePaymentInput) {
  console.log('🔍 Validating payment method:', input)

  const { paymentMethod, customerId } = input

  if (!paymentMethod) {
    throw new Error('Payment method is required')
  }

  if (!customerId) {
    throw new Error('Customer ID is required')
  }

  // Simulate validation
  await Bun.sleep(75)

  // Simulate occasional failures
  if (Math.random() < 0.01) {
    // 1% failure rate
    throw new Error('Payment method validation service unavailable')
  }

  const isValid = Math.random() > 0.05 // 95% success rate

  const result = {
    success: true,
    isValid,
    paymentMethod,
    customerId,
    validatedAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Payment method validation completed:', result)
  return result
}
