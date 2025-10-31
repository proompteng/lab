# syntax=docker/dockerfile:1.7-labs

FROM --platform=$BUILDPLATFORM golang:1.25.3 AS build
ARG TARGETOS
ARG TARGETARCH
ARG SERVICE_PATH=services/facteur
ARG FACTEUR_VERSION=dev
ARG FACTEUR_COMMIT=unknown
WORKDIR /workspace

COPY ${SERVICE_PATH}/go.mod ${SERVICE_PATH}/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
	go mod download

COPY ${SERVICE_PATH}/ ./
RUN --mount=type=cache,target=/go/pkg/mod \
	CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build \
	-ldflags="-s -w -X github.com/proompteng/lab/services/facteur/internal/server.buildVersion=$FACTEUR_VERSION -X github.com/proompteng/lab/services/facteur/internal/server.buildCommit=$FACTEUR_COMMIT" \
	-o /out/facteur .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build --chmod=0555 /out/facteur /usr/local/bin/facteur

ENTRYPOINT ["/usr/local/bin/facteur"]
CMD ["serve"]
