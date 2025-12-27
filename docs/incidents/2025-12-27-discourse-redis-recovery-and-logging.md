# 2025-12-27 Discourse Redis Recovery and Pod Logging

## Summary
Discourse was down due to Redis failing to start with a corrupted AOF manifest. I repaired the AOF, brought Redis back, and then fixed Discourse logging so Rails/Unicorn request logs appear in `kubectl logs`.

## Impact
- Discourse pods repeatedly restarted while Redis was unhealthy.
- Kubernetes logs only showed runit startup lines until Unicorn log redirection was disabled.

## Root Cause
Redis failed to start because `appendonly.aof.manifest` was truncated/corrupt, causing Redis startup to abort.

## Recovery: Redis AOF Repair
1. Scaled down the Redis operator and Redis StatefulSet to stop Redis and prevent reconciliation during repair.
2. Launched a temporary Redis pod with the `discourse-redis` PVC mounted and ran `redis-check-aof --fix` on the manifest.
3. Deleted the fix pod and scaled the operator/StatefulSet back up.

### Commands Run (Redis)
```bash
# Stop operator and Redis
kubectl scale -n discourse deploy/redis-operator --replicas=0
kubectl scale -n discourse statefulset/discourse-redis --replicas=0

# Run AOF repair using a temporary pod (PVC mounted at /data)
kubectl run -n discourse redis-aof-fix \
  --image=redis:7.0.15-alpine \
  --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"redis-aof-fix","image":"redis:7.0.15-alpine","command":["/bin/sh","-c"],"args":["redis-check-aof --fix /data/appendonlydir/appendonly.aof.manifest"],"volumeMounts":[{"name":"data","mountPath":"/data"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"discourse-redis"}}]}}'

# Clean up and scale back
kubectl delete pod -n discourse redis-aof-fix
kubectl scale -n discourse deploy/redis-operator --replicas=1
kubectl scale -n discourse statefulset/discourse-redis --replicas=1
```

## Fix: Make Discourse Logs Appear in `kubectl logs`
Discourse’s `unicorn.conf.rb` redirects stdout/stderr to files, so Kubernetes logs were empty aside from runit output. I made Unicorn skip file redirection when `UNICORN_STDOUT_PATH=stdout` or `UNICORN_STDERR_PATH=stderr`.

### What Changed
- Set env vars in the Discourse configmap:
  - `RAILS_LOG_TO_STDOUT=true`
  - `UNICORN_STDOUT_PATH=stdout`
  - `UNICORN_STDERR_PATH=stderr`
- Patched `/etc/service/unicorn/run` to comment out `stdout_path`/`stderr_path` in `config/unicorn.conf.rb` at boot when the env vars above are present.
- Rebuilt and deployed the Discourse image so the runtime patch is included.

### Commands Run (Logging)
```bash
# Build/push the image and update deployment digest
bun packages/scripts/src/discourse/deploy-service.ts

# Confirm rollout
kubectl rollout status -n discourse deploy/discourse --timeout=180s

# Trigger a request to generate log lines
kubectl exec -n discourse deploy/discourse -- ruby -e 'require "net/http"; puts Net::HTTP.get_response(URI("http://localhost:3000"))'

# Confirm logs show request lines
kubectl logs -n discourse deploy/discourse --since=5m
```

## Verification
After the rollout, `kubectl logs -n discourse deploy/discourse --since=5m` showed Rails request lines (e.g., `Started GET` and `Completed 200 OK`), confirming logs are emitted to stdout/stderr.

## Files Updated
- `apps/discourse/templates/web.template.yml`
- `argocd/applications/discourse/configmap.yaml`
- `argocd/applications/discourse/deployment.yaml`
