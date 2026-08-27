# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.25.5-bookworm@sha256:d9132cce84391efab786495288756d60e1da215b1f94e87860aeefc3d4c45b6d AS build

ARG TARGETARCH
ARG TARGETOS

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN go test ./... && \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
      go build -trimpath -ldflags='-s -w' -o /out/nanoagent .

FROM docker.io/library/busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662

COPY --from=build /out/nanoagent /usr/local/bin/nanoagent
RUN test -x /bin/sh && \
    mkdir -p /workspace && \
    chown 65532:65532 /workspace

USER 65532:65532
WORKDIR /workspace
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/nanoagent"]
