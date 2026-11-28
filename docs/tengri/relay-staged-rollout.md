# Relay platform migration

The dormant Tengri-only connector contract is retired by the hard platform migration. Its feature gate,
`CheckConnectorAgent`, namespace/connector grant enums and `ConfigureConnector` command are removed.

Use [the platform architecture and cutover guide](../platform/ofz-relay.md),
[Ofz policy onboarding](../../services/ofz/platform/README.md), and
[Relay's execution contract](../../services/relay/README.md). Existing old gateway branches are historical references;
they are not an alternate deployment path or compatibility implementation.
