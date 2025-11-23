export const sayHello = async (name: string): Promise<string> => `Hello, ${name}!`

export const recordNote = async (note: string): Promise<string> => {
  const timestamp = new Date().toISOString()
  return `${timestamp} :: ${note}`
}
