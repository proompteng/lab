// Order processing workflow using @proompteng/temporal-bun-sdk
type OrderItem = {
  productId: string
  quantity: number
  price: number
}

type OrderProcessingInput = {
  orderId: string
  customerId: string
  items: OrderItem[]
  totalAmount: number
}

type PaymentResult = {
  success: boolean
  transactionId: string
  amount: number
}

type InventoryUpdateResult = {
  success: boolean
  itemsUpdated: number
}

type ConfirmationResult = {
  success: boolean
}

export default async function orderProcessingWorkflow(input: OrderProcessingInput) {
  console.log('🛒 Order processing workflow started')
  console.log('Order:', input)

  const { orderId, customerId, items, totalAmount } = input

  // Step 1: Validate order
  console.log('📋 Validating order...')
  await Bun.sleep(50)

  if (!orderId || !customerId || !items || !totalAmount) {
    throw new Error('Invalid order: missing required fields')
  }

  // Step 2: Process payment
  console.log('💳 Processing payment...')
  await Bun.sleep(100)

  const paymentResult = await processPayment({
    orderId,
    amount: totalAmount,
    customerId,
  })

  if (!paymentResult.success) {
    throw new Error(`Payment failed: Unknown error`)
  }

  // Step 3: Update inventory
  console.log('📦 Updating inventory...')
  await Bun.sleep(75)

  const inventoryResult = await updateInventory(items)

  if (!inventoryResult.success) {
    // Compensate payment
    await compensatePayment(paymentResult.transactionId)
    throw new Error(`Inventory update failed: Unknown error`)
  }

  // Step 4: Send confirmation
  console.log('📧 Sending confirmation...')
  await Bun.sleep(50)

  const confirmationResult = await sendConfirmation({
    orderId,
    customerId,
    items,
    totalAmount,
    paymentTransactionId: paymentResult.transactionId,
  })

  const result = {
    success: true,
    orderId,
    customerId,
    items,
    totalAmount,
    paymentTransactionId: paymentResult.transactionId,
    inventoryUpdated: inventoryResult.success,
    confirmationSent: confirmationResult.success,
    processedAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Order processing completed')
  return result
}

// Mock activity functions
async function processPayment(payment: {
  orderId: string
  amount: number
  customerId: string
}): Promise<PaymentResult> {
  await Bun.sleep(50)
  return {
    success: true,
    transactionId: `txn_${Date.now()}`,
    amount: payment.amount,
  }
}

async function updateInventory(items: OrderItem[]): Promise<InventoryUpdateResult> {
  await Bun.sleep(75)
  return {
    success: true,
    itemsUpdated: items.length,
  }
}

async function compensatePayment(transactionId: string) {
  await Bun.sleep(25)
  console.log(`🔄 Compensating payment: ${transactionId}`)
  return { success: true }
}

async function sendConfirmation(confirmation: {
  orderId: string
  customerId: string
  items: OrderItem[]
  totalAmount: number
  paymentTransactionId: string
}): Promise<ConfirmationResult> {
  await Bun.sleep(50)
  console.log(`📧 Confirmation sent for order: ${confirmation.orderId}`)
  return { success: true }
}
