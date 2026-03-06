"""Shared logging configuration for the torghut service."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import logging
from logging.config import dictConfig
import os
from typing import Any, Literal

_TEXT_FORMAT = '%(asctime)s %(levelname)s %(name)s %(message)s'
_TEXT_DATE_FORMAT = '%Y-%m-%dT%H:%M:%S%z'
_STANDARD_RECORD_FIELDS = {
    'args',
    'asctime',
    'created',
    'exc_info',
    'exc_text',
    'filename',
    'funcName',
    'levelname',
    'levelno',
    'lineno',
    'module',
    'msecs',
    'message',
    'msg',
    'name',
    'pathname',
    'process',
    'processName',
    'relativeCreated',
    'stack_info',
    'thread',
    'threadName',
    'taskName',
}
_config_signature: tuple[str, str, bool, str, str] | None = None


def _coerce_bool(value: str | None, *, default: bool) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {'1', 'true', 't', 'yes', 'y', 'on'}:
        return True
    if normalized in {'0', 'false', 'f', 'no', 'n', 'off'}:
        return False
    return default


def _normalize_log_level(value: str | None) -> str:
    normalized = (value or 'INFO').strip().upper()
    if normalized == 'WARN':
        return 'WARNING'
    if normalized not in {'DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'}:
        return 'INFO'
    return normalized


def _default_log_format(app_env: str | None) -> Literal['json', 'text']:
    normalized_env = (app_env or '').strip().lower()
    if normalized_env in {'prod', 'stage'}:
        return 'json'
    return 'text'


def _resolve_log_format(value: str | None, *, app_env: str | None) -> Literal['json', 'text']:
    normalized = (value or '').strip().lower()
    if normalized in {'json', 'text'}:
        return 'json' if normalized == 'json' else 'text'
    return _default_log_format(app_env)


def _format_timestamp(created: float) -> str:
    timestamp = datetime.fromtimestamp(created, tz=timezone.utc)
    return timestamp.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class JsonFormatter(logging.Formatter):
    """Render records as one-line JSON for machine parsing."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            'timestamp': _format_timestamp(record.created),
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
            'service': getattr(record, 'service', 'torghut'),
            'environment': getattr(record, 'environment', os.getenv('APP_ENV', 'dev') or 'dev'),
            'module': record.module,
            'function': record.funcName,
            'line': record.lineno,
        }
        extras = {
            key: value
            for key, value in record.__dict__.items()
            if key not in _STANDARD_RECORD_FIELDS and not key.startswith('_')
        }
        if extras:
            payload['extra'] = extras
        if record.exc_info:
            payload['exception'] = self.formatException(record.exc_info)
        if record.stack_info:
            payload['stack'] = self.formatStack(record.stack_info)
        return json.dumps(payload, ensure_ascii=True, sort_keys=True, default=str)


class ServiceContextFilter(logging.Filter):
    """Attach stable service metadata to every log record."""

    def __init__(self, *, service: str, environment: str) -> None:
        super().__init__()
        self._service = service
        self._environment = environment

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, 'service'):
            record.service = self._service
        if not hasattr(record, 'environment'):
            record.environment = self._environment
        return True


@dataclass(frozen=True)
class LoggingRuntimeConfig:
    level: str
    format: Literal['json', 'text']
    access_log_enabled: bool
    service: str
    environment: str


def _build_logging_dict_config(config: LoggingRuntimeConfig) -> dict[str, Any]:
    access_logger_config: dict[str, Any] = {
        'handlers': [],
        'level': 'INFO',
        'propagate': True,
    }
    if not config.access_log_enabled:
        access_logger_config['propagate'] = False

    return {
        'version': 1,
        'disable_existing_loggers': False,
        'filters': {
            'service_context': {
                '()': ServiceContextFilter,
                'service': config.service,
                'environment': config.environment,
            }
        },
        'formatters': {
            'json': {
                '()': JsonFormatter,
            },
            'text': {
                'format': _TEXT_FORMAT,
                'datefmt': _TEXT_DATE_FORMAT,
            },
        },
        'handlers': {
            'default': {
                'class': 'logging.StreamHandler',
                'filters': ['service_context'],
                'formatter': config.format,
                'stream': 'ext://sys.stderr',
            }
        },
        'root': {
            'handlers': ['default'],
            'level': config.level,
        },
        'loggers': {
            'uvicorn': {
                'handlers': [],
                'level': config.level,
                'propagate': True,
            },
            'uvicorn.error': {
                'handlers': [],
                'level': config.level,
                'propagate': True,
            },
            'uvicorn.access': access_logger_config,
        },
    }


def configure_logging(*, force: bool = False) -> LoggingRuntimeConfig:
    """Configure root and Uvicorn logging for torghut."""

    service = (os.getenv('LOG_SERVICE_NAME', 'torghut') or 'torghut').strip() or 'torghut'
    environment = (os.getenv('APP_ENV', 'dev') or 'dev').strip() or 'dev'
    level = _normalize_log_level(os.getenv('LOG_LEVEL'))
    log_format = _resolve_log_format(os.getenv('LOG_FORMAT'), app_env=environment)
    access_log_enabled = _coerce_bool(os.getenv('LOG_ACCESS_LOG'), default=True)
    config = LoggingRuntimeConfig(
        level=level,
        format=log_format,
        access_log_enabled=access_log_enabled,
        service=service,
        environment=environment,
    )
    signature = (
        config.level,
        config.format,
        config.access_log_enabled,
        config.service,
        config.environment,
    )
    global _config_signature
    if not force and _config_signature == signature:
        return config

    dictConfig(_build_logging_dict_config(config))
    logging.captureWarnings(True)
    _config_signature = signature
    return config
