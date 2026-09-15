export type ResourceAttributes = Record<string, string | number | boolean>

export class Resource {
  readonly attributes: ResourceAttributes

  constructor(attributes: ResourceAttributes = {}) {
    this.attributes = { ...attributes }
  }

  static default(): Resource {
    return new Resource({})
  }

  merge(other: Resource): Resource {
    return new Resource({ ...this.attributes, ...other.attributes })
  }
}
