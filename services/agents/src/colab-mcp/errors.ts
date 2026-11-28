export class ColabError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly creationRejected = false,
    readonly alreadyExists = false,
  ) {
    super(message)
  }
}
