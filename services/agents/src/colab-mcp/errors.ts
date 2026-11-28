export class ColabError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly creationRejected = false,
  ) {
    super(message)
  }
}
