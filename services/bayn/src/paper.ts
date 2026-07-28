/**
 * Compatibility facade for the durable bayn.paper-* wire contracts.
 *
 * New execution code must import neutral domain contracts from
 * `./execution/contracts` and use the explicit codecs exported here only at
 * persistence or external-wire boundaries.
 */
export * from './execution/legacy-paper-codecs'
