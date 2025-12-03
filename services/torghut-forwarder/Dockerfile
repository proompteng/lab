FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

ARG FORWARDER_VERSION=dev
ARG FORWARDER_COMMIT=dev

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

WORKDIR /app

COPY services/torghut-forwarder/pyproject.toml services/torghut-forwarder/uv.lock ./
RUN uv sync --frozen --no-dev

COPY services/torghut-forwarder/ /app/

RUN adduser --system --uid 65532 --home /nonexistent --shell /usr/sbin/nologin forwarder
USER 65532:65532

ENV FORWARDER_VERSION=${FORWARDER_VERSION} \
    FORWARDER_COMMIT=${FORWARDER_COMMIT}

EXPOSE 8080

CMD ["uv", "run", "torghut_forwarder/app.py"]
