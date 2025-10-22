// Inventory activity using @proompteng/temporal-bun-sdk
type InventoryCheckInput = {
  productId: string
  quantity?: number
}

type InventoryUpdateInput = {
  productId: string
  quantityChange: number
  operation?: 'add' | 'subtract' | 'set'
}

type InventoryReservationInput = {
  productId: string
  quantity: number
  reservationId: string
}

type InventoryReleaseInput = {
  reservationId: string
}

export async function checkInventory(input: InventoryCheckInput) {
  console.log('📦 Checking inventory:', input)

  const { productId, quantity = 1 } = input

  if (!productId) {
    throw new Error('Product ID is required')
  }

  if (quantity <= 0) {
    throw new Error('Quantity must be positive')
  }

  // Simulate inventory check
  await Bun.sleep(50)

  // Simulate occasional failures
  if (Math.random() < 0.02) {
    // 2% failure rate
    throw new Error('Inventory service temporarily unavailable')
  }

  // Simulate inventory levels
  const availableStock = Math.floor(Math.random() * 100) + 1
  const isAvailable = availableStock >= quantity

  const result = {
    success: true,
    productId,
    requestedQuantity: quantity,
    availableStock,
    isAvailable,
    checkedAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Inventory check completed:', result)
  return result
}

export async function updateInventory(input: InventoryUpdateInput) {
  console.log('📦 Updating inventory:', input)

  const { productId, quantityChange, operation = 'subtract' } = input

  if (!productId) {
    throw new Error('Product ID is required')
  }

  if (!quantityChange || quantityChange <= 0) {
    throw new Error('Quantity change must be positive')
  }

  if (!['add', 'subtract', 'set'].includes(operation)) {
    throw new Error('Invalid operation. Must be add, subtract, or set')
  }

  // Simulate inventory update
  await Bun.sleep(75)

  // Simulate occasional failures
  if (Math.random() < 0.03) {
    // 3% failure rate
    throw new Error('Inventory update service temporarily unavailable')
  }

  // Simulate current stock
  const currentStock = Math.floor(Math.random() * 100) + 1

  let newStock: number
  switch (operation) {
    case 'add':
      newStock = currentStock + quantityChange
      break
    case 'subtract':
      newStock = Math.max(0, currentStock - quantityChange)
      break
    case 'set':
      newStock = quantityChange
      break
    default:
      throw new Error('Unsupported inventory operation')
  }

  const result = {
    success: true,
    productId,
    operation,
    quantityChange,
    previousStock: currentStock,
    newStock,
    updatedAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Inventory updated successfully:', result)
  return result
}

export async function reserveInventory(input: InventoryReservationInput) {
  console.log('🔒 Reserving inventory:', input)

  const { productId, quantity, reservationId } = input

  if (!productId) {
    throw new Error('Product ID is required')
  }

  if (!quantity || quantity <= 0) {
    throw new Error('Quantity must be positive')
  }

  if (!reservationId) {
    throw new Error('Reservation ID is required')
  }

  // Simulate inventory reservation
  await Bun.sleep(100)

  // Simulate occasional failures
  if (Math.random() < 0.02) {
    // 2% failure rate
    throw new Error('Inventory reservation service temporarily unavailable')
  }

  // Simulate current stock
  const availableStock = Math.floor(Math.random() * 100) + 1
  const canReserve = availableStock >= quantity

  if (!canReserve) {
    throw new Error(`Insufficient stock. Available: ${availableStock}, Requested: ${quantity}`)
  }

  const result = {
    success: true,
    productId,
    quantity,
    reservationId,
    availableStock,
    reservedAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Inventory reserved successfully:', result)
  return result
}

export async function releaseInventory(input: InventoryReleaseInput) {
  console.log('🔓 Releasing inventory:', input)

  const { reservationId } = input

  if (!reservationId) {
    throw new Error('Reservation ID is required')
  }

  // Simulate inventory release
  await Bun.sleep(50)

  // Simulate occasional failures
  if (Math.random() < 0.01) {
    // 1% failure rate
    throw new Error('Inventory release service temporarily unavailable')
  }

  const result = {
    success: true,
    reservationId,
    releasedAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Inventory released successfully:', result)
  return result
}
