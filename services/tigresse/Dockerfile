# syntax=docker/dockerfile:1.6

ARG GO_VERSION=1.25.5

FROM golang:${GO_VERSION} AS builder
WORKDIR /workspace

# Copy go module metadata and download dependencies first for better caching.
COPY services/tigresse/go.mod services/tigresse/go.sum ./
RUN go mod download

# Bring in the rest of the repository so local replace directives continue to work.
COPY . .

WORKDIR /workspace/services/tigresse
RUN CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o /workspace/tigresse .

FROM gcr.io/distroless/base-debian12:nonroot
WORKDIR /app
COPY --from=builder /workspace/tigresse ./tigresse
USER nonroot
EXPOSE 8080 8081
ENTRYPOINT ["/app/tigresse"]
