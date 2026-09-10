export type ThreadItem = {
  type: string
  text?: string
  [key: string]: unknown
}

export type ThreadError = {
  message: string
  code?: string
  [key: string]: unknown
}

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  [key: string]: unknown
}

export type ThreadEvent = {
  type: string
  thread_id?: string
  item?: ThreadItem
  usage?: Usage
  error?: ThreadError
  [key: string]: unknown
}
