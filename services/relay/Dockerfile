# syntax=mirror.gcr.io/docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM mirror.gcr.io/rust:1.90.0-bookworm AS build
ARG TARGETARCH
RUN apt-get update -o Acquire::Retries=3 && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN test "$(dpkg --print-architecture)" = "$TARGETARCH" && cargo test --locked --all-targets && cargo build --locked --release && cp target/release/relay /out-relay
FROM mirror.gcr.io/debian:bookworm-slim
RUN apt-get update -o Acquire::Retries=3 && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /out-relay /usr/local/bin/relay
USER 65532:65532
EXPOSE 8443 8080
ENTRYPOINT ["/usr/local/bin/relay"]
