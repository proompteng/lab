# syntax=docker/dockerfile:1.6

ARG GO_VERSION=1.25.5

FROM golang:${GO_VERSION} AS builder
WORKDIR /workspace

# Copy go module files and download dependencies first (better cache reuse)
COPY services/miel/go.mod services/miel/go.sum ./
RUN go mod download

# Copy the rest of the repository (for local module replaces)
COPY . .

WORKDIR /workspace/services/miel
RUN CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o /workspace/miel ./...

FROM gcr.io/distroless/base-debian12:nonroot
WORKDIR /app
COPY --from=builder /workspace/miel ./miel
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/app/miel"]
