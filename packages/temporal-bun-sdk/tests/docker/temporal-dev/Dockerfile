FROM public.ecr.aws/docker/library/alpine:3.20

ARG TARGETARCH

RUN set -eux; \
    apk add --no-cache bash ca-certificates curl; \
    arch="${TARGETARCH:-$(uname -m)}"; \
    case "$arch" in \
        amd64|x86_64) cli_arch=amd64 ;; \
        arm64|aarch64) cli_arch=arm64 ;; \
        *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -sSfL "https://temporal.download/cli/archive/latest?platform=linux&arch=${cli_arch}" -o /tmp/temporal-cli.tar.gz; \
    tar -xzf /tmp/temporal-cli.tar.gz -C /usr/local/bin temporal; \
    chmod +x /usr/local/bin/temporal; \
    rm /tmp/temporal-cli.tar.gz

EXPOSE 7233 8233

ENTRYPOINT ["temporal", "server", "start-dev", "--headless", "--ip", "0.0.0.0", "--port", "7233"]
