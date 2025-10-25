# syntax=docker/dockerfile:1.7

ARG MINIO_CONSOLE_VERSION=v2.0.4
ARG TARGETOS=linux
ARG TARGETARCH=amd64

FROM --platform=linux/amd64 golang:1.22-bookworm AS build
ARG MINIO_CONSOLE_VERSION
ARG TARGETOS
ARG TARGETARCH
ENV CGO_ENABLED=0 \
    GOOS=${TARGETOS} \
    GOARCH=${TARGETARCH} \
    GOTOOLCHAIN=go1.24.4+auto
WORKDIR /src
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go install github.com/minio/console@${MINIO_CONSOLE_VERSION}

FROM gcr.io/distroless/base-debian12:nonroot
ARG MINIO_CONSOLE_VERSION
COPY --from=build /go/bin/console /usr/local/bin/console
USER nonroot
EXPOSE 9090
ENV CONSOLE_MINIO_SERVER=http://localhost:9000
ENTRYPOINT ["/usr/local/bin/console"]
CMD ["server"]
LABEL org.opencontainers.image.source="https://github.com/proompteng/lab" \
      org.opencontainers.image.description="MinIO Console ${MINIO_CONSOLE_VERSION} packaged for the lab cluster" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.title="MinIO Console"
