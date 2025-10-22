// Email activity using @proompteng/temporal-bun-sdk
type EmailInput = {
  to: string
  subject: string
  body: string
  from?: string
}

export async function sendEmail(input: EmailInput) {
  console.log('📧 Sending email:', input)

  const { to, subject, body, from = 'noreply@example.com' } = input

  // Validate input
  if (!to || !subject || !body) {
    throw new Error('Missing required email fields: to, subject, body')
  }

  // Simulate email sending
  await Bun.sleep(100)

  // Simulate occasional failures
  if (Math.random() < 0.05) {
    // 5% failure rate
    throw new Error('Email service temporarily unavailable')
  }

  const result = {
    success: true,
    messageId: `email_${Date.now()}`,
    to,
    subject,
    from,
    sentAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Email sent successfully:', result.messageId)
  return result
}

type BulkEmailInput = {
  recipients: string[]
  subject: string
  body: string
  from?: string
}

export async function sendBulkEmail(input: BulkEmailInput) {
  console.log('📧 Sending bulk email:', input)

  const { recipients, subject, body } = input

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('Invalid recipients list')
  }

  if (!subject || !body) {
    throw new Error('Missing required email fields: subject, body')
  }

  // Simulate bulk email sending
  await Bun.sleep(200)

  const results = []
  const errors = []

  for (const recipient of recipients) {
    try {
      await Bun.sleep(10) // Simulate per-recipient processing

      // Simulate occasional failures
      if (Math.random() < 0.02) {
        // 2% failure rate
        throw new Error(`Failed to send to ${recipient}`)
      }

      results.push({
        recipient,
        messageId: `email_${Date.now()}_${recipient}`,
        sentAt: new Date().toISOString(),
      })
    } catch (error) {
      errors.push({
        recipient,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const result = {
    success: errors.length === 0,
    totalRecipients: recipients.length,
    successfulSends: results.length,
    failedSends: errors.length,
    results,
    errors,
    processedAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Bulk email completed:', result)
  return result
}
