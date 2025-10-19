FROM public.ecr.aws/docker/library/alpine:3.20

RUN apk add --no-cache bash ca-certificates curl \
    && curl -sSfL "https://temporal.download/cli/archive/latest?platform=linux&arch=arm64" -o /tmp/temporal-cli.tar.gz \
    && tar -xzf /tmp/temporal-cli.tar.gz -C /usr/local/bin temporal \
    && chmod +x /usr/local/bin/temporal \
    && rm /tmp/temporal-cli.tar.gz

EXPOSE 7233 8233

ENTRYPOINT ["temporal", "server", "start-dev", "--headless", "--ip", "0.0.0.0", "--port", "7233"]
