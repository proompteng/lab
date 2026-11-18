"""Check the local HTTP server and the shared PostgreSQL scheduler heartbeat."""

import os
import signal
import sys
import urllib.request


class HealthError(Exception):
    pass


def check_health():
    import psycopg

    request = urllib.request.Request(
        "http://127.0.0.1:8000/_health/", headers={"Host": "glitchtip-web"}
    )
    with urllib.request.urlopen(request, timeout=2) as response:
        if response.status != 200:
            raise HealthError("local HTTP health failed")

    # Use the existing application connection without loading Django or starting
    # another worker. Never include database exceptions/connection details in logs.
    with psycopg.connect(
        os.environ["DATABASE_URL"],
        connect_timeout=2,
        options="-c default_transaction_read_only=on -c statement_timeout=2000",
    ) as connection:
        row = connection.execute(
            """
            SELECT EXISTS (
                SELECT 1 FROM db_vtaskmetadata
                WHERE key = 'vtasks_scheduler_lock'
                  AND expires_at >= clock_timestamp() - interval '60 seconds'
            )
            """
        ).fetchone()
    if row != (True,):
        raise HealthError("shared scheduler heartbeat is stale or missing")


def main():
    # Kubernetes allows eight seconds; terminate within seven even if DNS or an
    # unexpected driver path fails to honor its narrower operation timeout.
    signal.alarm(7)
    try:
        check_health()
    except HealthError as error:
        print(f"GlitchTip health failed: {error}", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"GlitchTip health failed: {type(error).__name__}", file=sys.stderr)
        return 1
    finally:
        signal.alarm(0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
