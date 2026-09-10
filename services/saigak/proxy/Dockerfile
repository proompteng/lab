FROM golang:1.24-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/ollama-proxy

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/ollama-proxy /usr/local/bin/ollama-proxy
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/ollama-proxy"]
