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
COPY app ./app
RUN /opt/venv/bin/uv sync --frozen --no-dev


FROM python:${PYTHON_VERSION}-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:${PATH}"

WORKDIR /app

RUN apt-get update \
 && apt-get install --no-install-recommends -y libpq5 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv
COPY app ./app
COPY README.md .

RUN groupadd --system torghut && useradd --system --create-home --gid torghut torghut
USER torghut

EXPOSE 8181

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8181"]
