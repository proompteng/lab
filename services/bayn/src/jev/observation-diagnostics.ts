/** Bounded explanations only. These values neither relax validation nor become part of observation identity. */
export enum JevObservationCheck {
  Schema = 'SCHEMA',
  Snapshot = 'SNAPSHOT',
  ObservationTime = 'OBSERVATION_TIME',
  Candidates = 'CANDIDATE_UNIVERSE',
  Universe = 'PROTOCOL_UNIVERSE',
  Feed = 'PROTOCOL_FEED',
  Topics = 'SOURCE_TOPICS',
  Window = 'SIGNAL_WINDOW',
  DecisionLag = 'DECISION_LAG',
  Session = 'SESSION_BOUNDARY',
  PortfolioPremature = 'PORTFOLIO_PREMATURE',
  PortfolioStale = 'PORTFOLIO_STALE',
  Features = 'FEATURE_DEFINITION',
  Identity = 'CONTENT_IDENTITY',
}

export enum JevObservationField {
  Account = 'account',
  Positions = 'positions',
  Orders = 'orders',
  Reconciliation = 'reconciliation',
}
