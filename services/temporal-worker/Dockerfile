# syntax=docker/dockerfile:1
FROM golang:1.26.4-alpine@sha256:3ad57304ad93bbec8548a0437ad9e06a455660655d9af011d58b993f6f615648 AS source
RUN apk add --no-cache curl patch
WORKDIR /temporal
RUN curl --fail --location --retry 3 https://codeload.github.com/temporalio/temporal/tar.gz/19a774302c613da9adc4436ab14278ccdca8e0a5 -o /tmp/source.tar.gz \
    && echo 'e034c4ff9ef8ae7d4a326bddb9f6793bee6255285cc19f9b58874d8ee21eb3e8  /tmp/source.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/source.tar.gz --strip-components=1 \
    && rm /tmp/source.tar.gz
COPY host-resources.patch /tmp/host-resources.patch
COPY host-resources.go common/sdk/host_resources.go
RUN patch --batch --fuzz=0 -p1 < /tmp/host-resources.patch

FROM source AS test
COPY host-resources_test.go common/sdk/host_resources_test.go
RUN mkdir /proof
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

FROM mirror.gcr.io/temporalio/server:1.31.2@sha256:b5ecdb8282bededae2a10c36e8d862e27d0bc2d247fc73c5416025997ab4a1da AS runtime
COPY --from=builder /tmp/temporal-server /usr/local/bin/temporal-server
LABEL org.opencontainers.image.base.name="mirror.gcr.io/temporalio/server:1.31.2" \
      ai.proompteng.temporal.upstream-revision="19a774302c613da9adc4436ab14278ccdca8e0a5" \
      ai.proompteng.temporal.patch="host-resources-v1"
