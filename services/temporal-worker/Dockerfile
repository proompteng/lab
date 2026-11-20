# syntax=docker/dockerfile:1
FROM golang:1.26.10-alpine@sha256:87c65a688975c0b1d4585d204874c45ca78354670e3a5f11368c5a492303d696 AS source
RUN apk add --no-cache curl patch
WORKDIR /temporal
RUN curl --fail --location --retry 3 https://codeload.github.com/temporalio/temporal/tar.gz/6d085822273f4336796e6959c73ab1d14a23eb77 -o /tmp/source.tar.gz \
    && echo 'bc76a2b75a21bd8c37604f5cd3aed0194d8853ecf894d459a163a6e5e3698764  /tmp/source.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/source.tar.gz --strip-components=1 \
    && rm /tmp/source.tar.gz
COPY host-resources.patch /tmp/host-resources.patch
COPY host-resources.go common/sdk/host_resources.go
RUN patch --batch --fuzz=0 -p1 < /tmp/host-resources.patch
COPY routing-propagation.patch /tmp/routing-propagation.patch
COPY routing-reconciliation.go service/worker/workerdeployment/routing_reconciliation.go
RUN patch --batch --fuzz=0 -p1 < /tmp/routing-propagation.patch

FROM source AS test
COPY host-resources_test.go common/sdk/host_resources_test.go
COPY routing-*_test.go service/worker/workerdeployment/
COPY testdata/routing-reconciliation/ service/worker/workerdeployment/testdata/routing-reconciliation/
RUN mkdir /proof
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    set -eu; \
    patch --batch --fuzz=0 --reverse -p1 < /tmp/routing-propagation.patch; \
    if go test -mod=readonly -count=1 -run '^TestWorkerDeploymentSuite$/Test_RoutingSignalAtActivityCompletion$' ./service/worker/workerdeployment > /proof/routing-baseline.log 2>&1; then \
      cat /proof/routing-baseline.log; exit 1; \
    fi; \
    grep -F 'Should be empty, but was map[previous:revision_numbers:98]' /proof/routing-baseline.log; \
    patch --batch --fuzz=0 -p1 < /tmp/routing-propagation.patch; \
    go test -mod=readonly -count=1 ./service/worker/workerdeployment ./service/worker/workerdeployment/replaytester > /proof/routing.log 2>&1 \
      || { cat /proof/routing.log; exit 1; }
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    set -eu; \
    sed '/^--- a\/go.mod/,$d' /tmp/host-resources.patch > /tmp/factory.patch; \
    patch --batch --fuzz=0 --reverse -p1 < /tmp/factory.patch; \
    if go test -mod=readonly -v -count=1 -run TestHostResourcesReachSDKHeartbeat ./common/sdk > /proof/baseline.log 2>&1; then \
      cat /proof/baseline.log; exit 1; \
    fi; \
    grep -F 'missing or invalid memory in real SDK heartbeat: 0.000000' /proof/baseline.log; \
    patch --batch --fuzz=0 -p1 < /tmp/factory.patch; \
    go test -mod=readonly -v -count=1 -run TestHostResources ./common/sdk > /proof/host-resources.log 2>&1 \
      || { cat /proof/host-resources.log; exit 1; }

FROM test AS builder
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -mod=readonly -trimpath -o /tmp/temporal-server ./cmd/server

FROM scratch AS evidence
COPY --from=test /proof/ /

FROM mirror.gcr.io/temporalio/server:1.32.2@sha256:7bf69188a6232fea14869b9cef3d94aa82a1601d99517f7e86c71f22da4e0670 AS runtime
COPY --from=builder /tmp/temporal-server /usr/local/bin/temporal-server
LABEL org.opencontainers.image.base.name="mirror.gcr.io/temporalio/server:1.32.2" \
      ai.proompteng.temporal.upstream-revision="6d085822273f4336796e6959c73ab1d14a23eb77" \
      ai.proompteng.temporal.patch="host-resources-v1,routing-propagation-v1"
