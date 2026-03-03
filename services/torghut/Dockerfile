# syntax=docker/dockerfile:1
# check=error=true

ARG PYTHON_VERSION=3.11

FROM python:${PYTHON_VERSION}-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:${PATH}" \
    UV_PROJECT_ENVIRONMENT="/opt/venv" \
    PIP_DEFAULT_TIMEOUT=120 \
    PIP_RETRIES=10

WORKDIR /app

RUN apt-get update \
 && apt-get install --no-install-recommends -y build-essential libpq-dev \
 && python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --retries 10 --timeout 120 --upgrade pip uv \
 && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml uv.lock README.md ./
COPY alembic.ini ./
COPY app ./app
COPY migrations ./migrations
RUN /opt/venv/bin/uv sync --frozen --no-dev


FROM python:${PYTHON_VERSION}-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:${PATH}"

WORKDIR /app
ARG KUBECTL_VERSION=v1.30.0
ARG TARGETPLATFORM

RUN apt-get update \
 && apt-get install --no-install-recommends -y \
      ca-certificates \
      curl \
      libpq5 \
 && PLATFORM="${TARGETPLATFORM:-linux/$(dpkg --print-architecture 2>/dev/null || uname -m)}" \
 && case "${PLATFORM}" in \
      linux/amd64|linux/amd64/*|amd64|x86_64) KUBECTL_ARCH="amd64" ;; \
      linux/arm64|linux/arm64/*|linux/aarch64|arm64|aarch64) KUBECTL_ARCH="arm64" ;; \
      *) echo "Unsupported platform: ${PLATFORM}" >&2; exit 1 ;; \
    esac \
 && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${KUBECTL_ARCH}/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv
COPY alembic.ini ./
COPY app ./app
COPY migrations ./migrations
COPY scripts ./scripts
COPY README.md .

RUN groupadd --system torghut && useradd --system --create-home --gid torghut torghut
USER torghut

EXPOSE 8181

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8181"]
