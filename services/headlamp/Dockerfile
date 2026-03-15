# syntax=docker/dockerfile:1

ARG IMAGE_BASE=alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412
ARG HEADLAMP_REF=v0.40.1
ARG HEADLAMP_SHA=434a12263a6bd9d25f86f8bfa00d9992ac2672e3
ARG LAB_GIT_SHA=dirty

FROM ${IMAGE_BASE} AS source

ARG HEADLAMP_REF
ARG HEADLAMP_SHA

WORKDIR /src

RUN apk add --no-cache ca-certificates git \
    && git init . \
    && git remote add origin https://github.com/kubernetes-sigs/headlamp.git \
    && git fetch --depth 1 origin "${HEADLAMP_REF}" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${HEADLAMP_SHA}"

FROM ${IMAGE_BASE} AS image-base

FROM --platform=${BUILDPLATFORM} golang:1.24.13@sha256:d2d2bc1c84f7e60d7d2438a3836ae7d0c847f4888464e7ec9ba3a1339a1ee804 AS backend-build

WORKDIR /headlamp

ARG TARGETOS
ARG TARGETARCH
ENV GOPATH=/go \
    GOPROXY=https://proxy.golang.org \
    GO111MODULE=on \
    CGO_ENABLED=0 \
    GOOS=${TARGETOS} \
    GOARCH=${TARGETARCH}

COPY --from=source /src/backend/go.* /headlamp/backend/
COPY scripts /tools
COPY patches /patches

RUN --mount=type=cache,target=/go/pkg/mod \
    cd ./backend && go mod download

COPY --from=source /src/backend /headlamp/backend

RUN sh /tools/apply-upstream-patches.sh /headlamp

RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    cd ./backend && go build -o ./headlamp-server ./cmd/

FROM --platform=${BUILDPLATFORM} node:22@sha256:4ad2c2b350ab49fb637ab40a269ffe207c61818bb7eb3a4ea122001a0c605e1f AS frontend-build

WORKDIR /headlamp

COPY --from=source /src/.git /headlamp/.git
COPY --from=source /src/app/package.json /headlamp/app/package.json
COPY --from=source /src/frontend/package*.json /headlamp/frontend/

RUN cd ./frontend && npm ci --only=prod

FROM frontend-build AS frontend

ENV REACT_APP_ENABLE_WEBSOCKET_MULTIPLEXER=true

COPY --from=source /src/frontend /headlamp/frontend

RUN cd ./frontend && npm run build

RUN echo "*** Built Headlamp with version: ***"
RUN cat ./frontend/.env

RUN if [ -d /headlamp/plugins ]; then \
      mv /headlamp/plugins /headlamp/plugins-old; \
    else \
      mkdir -p /headlamp/plugins-old; \
    fi

RUN mkdir -p /headlamp/plugins

RUN set -eu; \
    for filename in main.js package.json; do \
      find /headlamp/plugins-old -mindepth 2 -maxdepth 2 -name "$filename" -print | while read -r plugin_file; do \
        plugin_name=$(echo "$plugin_file" | cut -d'/' -f4); \
        mkdir -p "/headlamp/plugins/$plugin_name"; \
        cp "$plugin_file" "/headlamp/plugins/$plugin_name"; \
      done; \
    done

FROM --platform=${BUILDPLATFORM} frontend-build AS static-plugins

RUN apt-get update && apt-get install -y jq

COPY --from=source /src/container/build-manifest.json /src/container/fetch-plugins.sh /tools/

WORKDIR /tools

RUN mkdir -p /plugins
RUN ./fetch-plugins.sh /plugins/

FROM image-base AS final

ARG LAB_GIT_SHA
ARG HEADLAMP_REF
ARG HEADLAMP_SHA

LABEL org.opencontainers.image.source="https://github.com/proompteng/lab" \
      org.opencontainers.image.revision="${LAB_GIT_SHA}" \
      org.opencontainers.image.version="${HEADLAMP_REF}" \
      headlamp.proompteng.ai/upstream-sha="${HEADLAMP_SHA}"

RUN if command -v apt-get > /dev/null; then \
        apt-get update && apt-get install -y --no-install-recommends ca-certificates \
        && addgroup --system headlamp \
        && adduser --system --ingroup headlamp headlamp \
        && rm -rf /var/lib/apt/lists/*; \
    else \
        apk add --no-cache ca-certificates \
        && addgroup -S headlamp \
        && adduser -S headlamp -G headlamp; \
    fi

COPY --from=backend-build --link /headlamp/backend/headlamp-server /headlamp/headlamp-server
COPY --from=frontend --link /headlamp/frontend/build /headlamp/frontend
COPY --from=frontend --link /headlamp/plugins /headlamp/plugins
COPY --from=static-plugins --link /plugins /headlamp/static-plugins

RUN chown -R headlamp:headlamp /headlamp

USER headlamp

EXPOSE 4466

ENV HEADLAMP_STATIC_PLUGINS_DIR=/headlamp/static-plugins

ENTRYPOINT ["/headlamp/headlamp-server", "-html-static-dir", "/headlamp/frontend", "-plugins-dir", "/headlamp/plugins"]
