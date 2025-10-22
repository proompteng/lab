# Temporal Bun SDK Example

This is an example project demonstrating how to use the `@proompteng/temporal-bun-sdk` library to build workflows and activities with Bun runtime.

## Features

- **Workflows**: Example workflows for order processing, data pipelines, and notifications
- **Activities**: Reusable activities for email, payment, inventory, and notifications
- **Bun Runtime**: Optimized for Bun's performance characteristics
- **Type Safety**: Full TypeScript support with proper type definitions

## Installation

```bash
# Install dependencies
bun install

# Build the project
bun run build

# Run the example
bun run start
```

## Project Structure

```
src/
├── index.ts                    # Main entry point
├── workflows/                  # Workflow definitions
│   ├── example-workflow.ts
│   ├── order-processing-workflow.ts
│   ├── data-pipeline-workflow.ts
│   └── notification-workflow.ts
└── activities/                 # Activity definitions
    ├── index.ts
    ├── email-activity.ts
    ├── payment-activity.ts
    ├── inventory-activity.ts
    └── notification-activity.ts
```

## Example Workflows

### 1. Order Processing Workflow

Processes e-commerce orders with payment, inventory, and confirmation steps.

```typescript
const result = await manager.executeWorkflow('order-processing-workflow.ts', {
  orderId: 'order_123',
  customerId: 'customer_456',
  items: [
    { productId: 'prod_1', quantity: 2, price: 29.99 },
    { productId: 'prod_2', quantity: 1, price: 49.99 }
  ],
  totalAmount: 109.97
})
```

### 2. Data Pipeline Workflow

Transforms and loads data from source to destination.

```typescript
const result = await manager.executeWorkflow('data-pipeline-workflow.ts', {
  source: { type: 'database', connection: 'postgresql://...' },
  destination: { type: 'warehouse', connection: 'bigquery://...' },
  transformations: [
    { type: 'multiply', factor: 1.1 },
    { type: 'filter', threshold: 10 },
    { type: 'addField', field: 'processed', value: true }
  ]
})
```

### 3. Notification Workflow

Sends notifications across multiple channels.

```typescript
const result = await manager.executeWorkflow('notification-workflow.ts', {
  userId: 'user_123',
  message: 'Your order has been processed!',
  channels: [
    { type: 'email', address: 'user@example.com' },
    { type: 'sms', phoneNumber: '+1234567890' },
    { type: 'push', deviceId: 'device_456' }
  ],
  priority: 'high'
})
```

## Example Activities

### Email Activities

```typescript
import { sendEmail, sendBulkEmail } from './activities/email-activity'

// Send single email
const result = await sendEmail({
  to: 'user@example.com',
  subject: 'Welcome!',
  body: 'Welcome to our service!'
})

// Send bulk emails
const result = await sendBulkEmail({
  recipients: ['user1@example.com', 'user2@example.com'],
  subject: 'Newsletter',
  body: 'Monthly newsletter content'
})
```

### Payment Activities

```typescript
import { processPayment, refundPayment } from './activities/payment-activity'

// Process payment
const result = await processPayment({
  amount: 99.99,
  currency: 'USD',
  paymentMethod: 'credit_card',
  customerId: 'customer_123'
})

// Refund payment
const result = await refundPayment({
  transactionId: 'txn_123',
  amount: 99.99,
  reason: 'Customer request'
})
```

### Inventory Activities

```typescript
import { checkInventory, updateInventory } from './activities/inventory-activity'

// Check inventory
const result = await checkInventory({
  productId: 'prod_123',
  quantity: 5
})

// Update inventory
const result = await updateInventory({
  productId: 'prod_123',
  quantityChange: 10,
  operation: 'add'
})
```

## Running the Example

1. **Start Temporal Server** (if not already running):
   ```bash
   docker compose up -d
   ```

2. **Run the example**:
   ```bash
   bun run start
   ```

3. **Expected output**:
   ```
   🚀 Temporal Bun SDK Example
   ============================
   📡 Creating Temporal client...
   ✅ Client created successfully
   🔍 Testing client connection...
   ✅ Namespace: default
   ⚡ Running example workflow...
   🎯 Example workflow started
   Input: { message: 'Hello from @proompteng/temporal-bun-sdk!', timestamp: '...' }
   ✅ Example workflow completed
   ✅ Workflow result: { success: true, message: 'Processed: Hello from @proompteng/temporal-bun-sdk!', ... }
   ```

## Development

### Adding New Workflows

1. Create a new workflow file in `src/workflows/`
2. Export a default async function
3. Use Bun-specific APIs like `Bun.sleep()`
4. Return structured results

### Adding New Activities

1. Create a new activity file in `src/activities/`
2. Export async functions
3. Include proper error handling
4. Use Bun's performance optimizations

### Testing

```bash
# Run tests
bun test

# Run with coverage
bun test --coverage
```

## Bun Runtime Features

This example leverages Bun's runtime features:

- **Bun.sleep()**: Efficient async delays
- **Bun.version**: Runtime version detection
- **Performance**: Optimized for Bun's JavaScript engine
- **Memory Management**: Efficient garbage collection
- **Module Loading**: Fast dynamic imports

## Error Handling

All workflows and activities include comprehensive error handling:

- Input validation
- Service availability checks
- Retry logic simulation
- Proper error propagation

## Performance

The example demonstrates Bun's performance characteristics:

- Fast workflow execution
- Efficient memory usage
- Concurrent activity processing
- Optimized serialization

## License

MIT License - see LICENSE file for details.