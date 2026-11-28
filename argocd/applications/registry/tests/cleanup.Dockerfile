FROM registry:3@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33 AS distribution
FROM haproxy:3.4.4-alpine@sha256:c0afc4864dca9c68694cd1290433f0ee79b5c55be80f6745a165ffe373b9a564
USER root
RUN apk add --no-cache python3
USER 99:99
COPY --from=distribution /bin/registry /bin/registry
COPY packages/scripts/src/registry /cleanup
COPY argocd/applications/registry/haproxy.cfg /proxy.cfg
COPY argocd/applications/registry/registry-configmap.yaml /registry-configmap.yaml
COPY argocd/applications/registry/deployment.yaml /deployment.yaml
COPY argocd/applications/registry/tests/write-gate.py /test.py
COPY argocd/applications/registry/tests/distribution-cache.py /cache-test.py
ENTRYPOINT ["python3", "/test.py"]
