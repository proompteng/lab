# Whitepaper Design: Blocked Analysis (`wp-d3cdc094c8e3184af629999a`)

- Run ID: `wp-d3cdc094c8e3184af629999a`
- Repository: `proompteng/lab`
- Issue: `https://github.com/proompteng/lab/issues/42`
- Primary PDF URL: `https://github.com/user-attachments/files/12345/sample-paper.pdf`
- Ceph Object URI: `s3://torghut-whitepapers/raw/checksum/b5/b5d4c2daa152f53c02621a70601b11dc5b4aecbda1cc3f5962bc5f7f491bad40/source.pdf`
- Analysis mode: `implementation`
- Evaluation timestamp (UTC): `2026-03-12T07:06:22Z`

## Decision

`blocked` at stage `source_acquisition`.

The required source PDF cannot be deterministically retrieved from any authoritative run artifact path currently reachable, so end-to-end paper reading is not possible. No evidence-backed implementation plan can be produced from the paper body.

## Evidence Log

1. Input lineage is inconsistent:
   - `curl -s https://api.github.com/repos/proompteng/lab/issues/42`
   - Result resolves to PR payload (`html_url: https://github.com/proompteng/lab/pull/42`, empty body), not a whitepaper issue payload.
2. Primary PDF URL is unavailable:
   - `curl -L --fail --silent --show-error "https://github.com/user-attachments/files/12345/sample-paper.pdf" -o /tmp/source-primary.pdf`
   - Result: HTTP `404` response.
3. Direct run lookup does not resolve:
   - `GET http://torghut.torghut.svc.cluster.local/whitepapers/runs/wp-d3cdc094c8e3184af629999a` -> `404 {"detail":"whitepaper_run_not_found"}`.
4. Jangar detail endpoint does not resolve:
   - `GET http://jangar.jangar.svc.cluster.local/api/whitepapers/wp-d3cdc094c8e3184af629999a` -> `404 {"ok":false,"message":"whitepaper run not found"}`.
5. Run is not discoverable in the active Jangar index:
   - `GET http://jangar.jangar.svc.cluster.local/api/whitepapers/?limit=20&offset=0`
   - Returned 4 runs, none with this run ID; run list appears to contain only current/recent synthetic IDs.
6. Ceph source cannot be fetched in this runtime:
   - `env | rg -n "(WHITEPAPER_CEPH|WHITEPAPER|MINIO|AWS_|S3)"` shows only `cephUri=` pointing to the target key and no usable endpoint/access key/secret.
   - `kubectl` read against `torghut` namespace configmaps is forbidden for this service account.

## Reproduction Checks

1. Torghut health: `GET /whitepapers/status` confirms workflow service is up and reachable.
2. Jangar health: `GET /` serves UI and `/api/whitepapers/wp-...` returns deterministic JSON failure responses as noted.
3. All subsequent evidence checks were executed from this environment with fixed inputs.

## Impact and Rationale

1. Full text, section, and claim extraction from the paper is not possible.
2. `synthesis.json` and `verdict.json` must remain in evidence-blocked mode.
3. Any implementation guidance that cites paper sections would be non-deterministic and unverifiable.

## Smallest Unblockers

Provide exactly one valid source access path for this run:

1. A working direct PDF URL for `wp-d3cdc094c8e3184af629999a`.
2. A temporary signed HTTPS URL for the exact Ceph object key.
3. A reachable `whitepaper_run` in Torghut/Jangar including a resolvable `/pdf` stream.

Once one unblocker is available, rerun deterministic end-to-end ingestion and produce a non-blocking synthesis.

## Resume Plan Once Unblocked

1. Download and checksum-verify the exact PDF bytes.
2. Read the full paper end-to-end (including appendices/references in scope).
3. Rebuild `synthesis.json` with section/claim citations grounded in the source.
4. Recompute `verdict.json` from evidence-backed feasibility and repository constraints.
5. Update this design doc with concrete implementation decisions.
