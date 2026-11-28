# Auto Ontology MCP for Codex AgentRuns

The optional Agents gateway exposes 12 read-only tools over Streamable HTTP. The Codex runner starts
`/usr/local/bin/auto-ontology-mcp-bridge` over stdio. The bridge sends a rotating projected Kubernetes
token; the gateway checks the token's audience, service account, Pod/Job/AgentRun ownership and
active phase, and the Agent's `codex` provider. Non-Codex providers and other namespaces are not
authorized. The runner never receives the Auto Ontology API key.

## API boundary

The gateway sends `x-api-key` to `http://frontend.auto-ontology.svc.cluster.local:3000`; no browser
OAuth is needed. Use the frontend even inside the cluster: in the pinned 1.3.0 release it serves
`/api/acronyms` itself and authenticates requests that it forwards to FastAPI. The private backend
on port 3001 trusts identity from the frontend and is not an API-key authorization boundary. Do not
point the gateway at it. The separate [NVIDIA MCP service](../../argocd/applications/auto-ontology/README.md)
on port 3003 has its own sign-in flow.

The gateway exposes `check_readiness`, `search_terms`, `get_term`, `get_term_columns`,
`get_term_sql_attributes`, `get_sql_attribute`, `describe_table`, `list_acronyms`, `list_rules`,
`list_custom_analyses`, `check_answerable`, and `ask_question`. It has no generic HTTP or SQL tool.
Use `check_readiness` to check compilation and catalog ingestion (not database connectivity) and
`check_answerable` before an expensive question. The chat POST omits all conversation fields, so it
does not persist a conversation or run the chart step. Source database credentials must be read-only:
the upstream service, not this gateway, executes generated SQL. Chat returns at most 100 rows.
Large responses fail explicitly instead of returning partial data.

`check_answerable` and `ask_question` share a 90-second upstream timeout by default. The stdio bridge
defaults to 120 seconds, and the Codex tool timeout is 100 seconds. If you raise
`AUTO_ONTOLOGY_MCP_CHAT_TIMEOUT_MS`, keep `AUTO_ONTOLOGY_MCP_BRIDGE_TIMEOUT_MS` and `tool_timeout_sec`
above the upstream deadline to leave time for authorization and transport.

The Bayn and OpenCode **research** policies permit TCP to the authenticated frontend and NVIDIA MCP
pods on ports 3000 and 3003 only. Kubernetes NetworkPolicy does not enforce HTTP methods; allowing
research pods to reach the private backend on port 3001 would bypass frontend authorization. The
research rules add connectivity, not MCP client configuration or credentials. Do not share the
gateway API key with them. Bayn execution policy and identities are unchanged.

## Activate in GitOps

1. Confirm the [promoted controller and Codex runner images](../release-automation.md) contain the
   gateway entrypoint and bridge binary. Keep `autoOntologyMcpGateway.enabled: false` until the
   credentials and images are ready.
2. Create an Auto Ontology API token from an account with only the necessary catalog reads and chat
   permission. With the [Galactic context verified](../runbooks/galactic-kubernetes-access.md), seal
   the token for the exact name and namespace below. Run without shell tracing; only the encrypted
   YAML belongs in Git.

   ```bash
   set -euo pipefail
   set +x
   read -rsp 'Auto Ontology API token: ' token
   printf '\n'
   printf '%s' "$token" |
     kubectl -n agents create secret generic auto-ontology-mcp-token \
       --from-file=AUTO_ONTOLOGY_API_TOKEN=/dev/stdin --dry-run=client -o yaml |
     kubeseal --controller-name=sealed-secrets --controller-namespace=sealed-secrets --format=yaml \
       > argocd/applications/agents/auto-ontology-mcp-token-sealedsecret.yaml
   unset token
   ```

   Add `auto-ontology-mcp-token-sealedsecret.yaml` to the Agents Kustomization. Review and sync it
   before enabling the gateway, and verify `kubectl -n agents get secret auto-ontology-mcp-token`
   without printing Secret data.

3. Set `autoOntologyMcpGateway.enabled: true` in
   [Agents values](../../argocd/applications/agents/values.yaml). Render with Helm 3 and verify that
   the Deployment reads `AUTO_ONTOLOGY_API_TOKEN` only from the SealedSecret's resulting Secret.
   Once this revision is synced, verify both gateway Pods are Ready. The pod probe checks API access;
   compilation or ingestion status is reported only by the tool.
4. Add `spec.workload` and replace the empty `threadConfig.mcp_servers` in
   [the standard Codex AgentProvider](../../argocd/applications/agents/codex-agentprovider.yaml) as
   shown below. Merge these fields into the existing manifest; keep the existing model, `effort: max`,
   and remaining settings. Keep the separate Kubernetes API token opt-in for [read-only triage](runbooks.md#agentrun-triage-access).
   The AgentRun controller projects the MCP token with its own audience. The MCP server accepts only the configured
   service account.

   ```yaml
   spec:
     workload:
       serviceAccountName: codex-auto-ontology-runner
       automountServiceAccountToken: true
       serviceAccountToken:
         audience: agents.proompteng.ai/auto-ontology-mcp
         expirationSeconds: 600
         mountPath: /var/run/secrets/agents-auto-ontology-mcp
     adapter:
       codex:
         threadConfig:
           mcp_servers:
             auto_ontology:
               command: /usr/local/bin/auto-ontology-mcp-bridge
               required: false
               startup_timeout_sec: 15
               tool_timeout_sec: 100
               env_vars: [AGENTS_MCP_IDENTITY_TOKEN_PATH]
               env:
                 AUTO_ONTOLOGY_MCP_GATEWAY_URL: http://agents-auto-ontology-mcp-gateway.agents.svc.cluster.local:8080/mcp
   ```

## Verify and roll back

Launch a new [canary AgentRun](agentrun-creation-guide.md) using `codex-agent`. Confirm its Job has
the projected token with the expected audience but not the Auto Ontology token. In the run, list
the tools, call `check_readiness` and `search_terms`, and use `check_answerable` then `ask_question`
for one known fixture when the catalog is ready. Confirm the expected answer and no saved
conversation. The HTTP gateway must reject anonymous requests and requests with a different token
audience. Preserve the MCP gateway egress rules when updating the separate AgentRun triage policy.

To roll back, first revert the Codex provider changes so new runs do not start the bridge. Then
disable the Helm gateway. Rotate a compromised API token at the issuer and recreate the SealedSecret;
the gateway reads the Secret at startup, so roll the Deployment through GitOps after rotation.
