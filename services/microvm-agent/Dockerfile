# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.25.5-bookworm@sha256:d9132cce84391efab786495288756d60e1da215b1f94e87860aeefc3d4c45b6d AS build

ARG TARGETARCH
ARG TARGETOS

WORKDIR /src
COPY go.mod ./
COPY main.go main_test.go ./
RUN go test ./... && \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
      go build -trimpath -ldflags='-s -w' -o /out/microvm-agent .

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab

COPY --from=build /out/microvm-agent /usr/local/bin/microvm-agent

USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/microvm-agent"]
