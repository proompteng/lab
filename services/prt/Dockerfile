# syntax=docker/dockerfile:1.6

FROM --platform=$BUILDPLATFORM golang:1.24.1-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETOS
ARG TARGETARCH
ENV CGO_ENABLED=0 \
    GOOS=${TARGETOS:-linux} \
    GOARCH=${TARGETARCH:-amd64}
RUN go build -ldflags='-s -w' -o /out/prt ./...

FROM --platform=$TARGETPLATFORM gcr.io/distroless/base-debian12:nonroot
WORKDIR /srv
COPY --from=builder /out/prt ./prt
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/srv/prt"]
