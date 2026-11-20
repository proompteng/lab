# Galactic DNS and egress interruption on 2026-11-17

Galactic briefly lost both DNS and external connectivity around 22:18 UTC on November 17 and again around
00:44 UTC on November 18. CoreDNS reported failures on two nodes, and Bayn's broker feed logged session errors.
The exact point of packet loss remains open.

## Evidence

Times are UTC and come from the respective log sources. The kernel and controller logs can timestamp the same
failure differently.

| Time              | Source                          | Observation                                                                                                                                 |
| ----------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 22:17:57–22:18:13 | Talos kernel or controller logs | Turin, Altra and Ryzen reported read timeouts on established TCP connections to the external Talos discovery service, `18.226.100.232:443`. |
| 22:17:59–22:18:44 | Turin kernel log                | `dns-resolve-cache` logged UDP read timeouts to the NUC Pi-hole at `100.100.244.148:53`.                                                    |
| 22:18:17          | Turin controller log            | A time query to the literal IP `162.159.200.1:123` timed out.                                                                               |
| 22:18:22–22:18:45 | CoreDNS logs                    | Two replicas reported `SERVFAIL` for external names after timeouts to the node cache at `169.254.116.108:53`.                               |
| 22:18:32–22:18:47 | Bayn broker-feed log            | The feed logged two `IOException` events, then `HttpRequestTimeoutException`.                                                               |
| 22:18:52          | Altra controller log            | An NTP timeout to one address was followed by a successful NTP reply from another address.                                                  |
| 22:19:04–22:19:36 | Ryzen kernel log                | `dns-resolve-cache` logged UDP read timeouts to the same NUC address.                                                                       |

On November 18 around 00:44 UTC, all three nodes again reported external discovery TCP read timeouts.
Turin and Ryzen logged UDP timeouts to the NUC, CoreDNS returned `SERVFAIL` for Alpaca names, and Bayn logged
two broker feed `IOException` events. The two outages showed the same combination of DNS and transport failures.

The existing TCP connections and literal-IP NTP queries did not require DNS during the failing reads. Investigate
the shared LAN and provider egress path alongside the NUC. A resolver-only change would leave those failures
unaddressed.

On November 18, workload pods on Turin, Altra and Ryzen resolved `github.com`, `registry.ide-newton.ts.net` and
`kubernetes.default.svc.cluster.local` through both their configured resolver and direct UDP queries to Pi-hole.
The Ryzen pod also received HTTP 200 from an unauthenticated request to `https://api.github.com/`, and Bayn's
broker-feed readiness metric returned `1` at the time of the check.

## Follow-up

- Collect the NUC system journal and Pi-hole query history, if enabled, for **November 17 22:17–22:21 UTC** and
  **November 18 00:43–00:47 UTC** from the
  [operator SSH session](../../devices/nuc/README.md#operator-ssh-access). Agent Shell reached the SSH listener
  over Tailscale, but lacked a verified host key and authorized client identity.
- Correlate the NUC logs with provider gateway and switch events. A service stop, OOM or host link event would
  identify a NUC issue. Forwarded Pi-hole queries without upstream replies would give evidence of upstream loss.
  Successful Pi-hole replies during node timeouts would shift attention to the path between the Talos nodes and NUC.
- All three live Talos resolver lists point to `100.100.244.148`. If adding DNS redundancy, first qualify a
  second independent resolver reachable before Tailscale starts. From Galactic, verify public names, the private
  registry and Kubernetes split DNS with the NUC unavailable in a controlled test. Sync the
  [Omni resolver configuration](../../devices/galactic/omni/cluster-template.yaml) only after the alternate path
  is proven.
