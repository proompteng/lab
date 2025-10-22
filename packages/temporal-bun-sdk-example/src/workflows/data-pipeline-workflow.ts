// Data pipeline workflow using @proompteng/temporal-bun-sdk
type DataPipelineInput = {
  source: string
  destination: string
  transformations: Transformation[]
  startTime: number
}

type Transformation =
  | { type: 'multiply'; factor: number }
  | { type: 'filter'; threshold: number }
  | { type: 'addField'; field: string; value: unknown }

type ExtractedData = {
  success: true
  data: Array<{ id: number; value: number; timestamp: string; [key: string]: unknown }>
  recordCount: number
}

type TransformedData = {
  success: true
  data: Array<{ id: number; value: number; timestamp: string; [key: string]: unknown }>
  recordCount: number
}

type ValidationResult = {
  success: boolean
  errors?: string[]
  recordCount: number
}

type LoadResult = {
  success: true
  recordCount: number
  destination: string
}

export default async function dataPipelineWorkflow(input: DataPipelineInput) {
  console.log('📊 Data pipeline workflow started')
  console.log('Input:', input)

  const { source, destination, transformations } = input

  // Step 1: Extract data
  console.log('📥 Extracting data from source...')
  await Bun.sleep(100)

  const extractedData = await extractData(source)

  if (!extractedData.success) {
    throw new Error(`Data extraction failed: Unknown error`)
  }

  // Step 2: Transform data
  console.log('🔄 Transforming data...')
  await Bun.sleep(150)

  const transformedData = await transformData(extractedData.data, transformations)

  if (!transformedData.success) {
    throw new Error(`Data transformation failed: Unknown error`)
  }

  // Step 3: Validate data
  console.log('✅ Validating transformed data...')
  await Bun.sleep(75)

  const validationResult = await validateData(transformedData.data)

  if (!validationResult.success) {
    throw new Error(`Data validation failed: ${validationResult.errors?.join(', ') || 'Unknown error'}`)
  }

  // Step 4: Load data
  console.log('📤 Loading data to destination...')
  await Bun.sleep(125)

  const loadResult = await loadData(transformedData.data, destination)

  if (!loadResult.success) {
    throw new Error(`Data loading failed: Unknown error`)
  }

  const result = {
    success: true,
    source,
    destination,
    transformations,
    recordsProcessed: extractedData.recordCount,
    recordsTransformed: transformedData.recordCount,
    recordsLoaded: loadResult.recordCount,
    processingTime: Date.now() - input.startTime,
    processedAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Data pipeline completed')
  return result
}

// Mock activity functions
async function extractData(_source: string): Promise<ExtractedData> {
  await Bun.sleep(100)
  return {
    success: true,
    data: Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      value: Math.random() * 100,
      timestamp: new Date().toISOString(),
    })),
    recordCount: 1000,
  }
}

async function transformData(data: ExtractedData['data'], transformations: Transformation[]): Promise<TransformedData> {
  await Bun.sleep(150)
  const transformed = data
    .map((record) => {
      const transformedRecord = { ...record }

      for (const transformation of transformations) {
        switch (transformation.type) {
          case 'multiply':
            transformedRecord.value *= transformation.factor
            break
          case 'filter':
            if (transformedRecord.value < transformation.threshold) {
              return null
            }
            break
          case 'addField':
            transformedRecord[transformation.field] = transformation.value
            break
        }
      }

      return transformedRecord
    })
    .filter(Boolean)

  return {
    success: true,
    data: transformed,
    recordCount: transformed.length,
  }
}

async function validateData(data: TransformedData['data']): Promise<ValidationResult> {
  await Bun.sleep(75)
  const errors = []

  for (const record of data) {
    if (!record.id || typeof record.id !== 'number') {
      errors.push(`Invalid id in record: ${JSON.stringify(record)}`)
    }
    if (!record.value || typeof record.value !== 'number') {
      errors.push(`Invalid value in record: ${JSON.stringify(record)}`)
    }
  }

  return {
    success: errors.length === 0,
    errors,
    recordCount: data.length,
  }
}

async function loadData(data: TransformedData['data'], destination: string): Promise<LoadResult> {
  await Bun.sleep(125)
  return {
    success: true,
    recordCount: data.length,
    destination,
  }
}
