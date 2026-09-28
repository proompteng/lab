"""Require verified backups and deny access to the live Cassandra data path."""

from __future__ import print_function
import errno
import os
import socket
import time


def blocked(address):
    try:
        connection = socket.create_connection((address, 9042), 2)
    except socket.timeout:
        return True
    except socket.error as error:
        if error.errno in (
            errno.EHOSTUNREACH,
            errno.ENETUNREACH,
            errno.EACCES,
            errno.EPERM,
            errno.ECONNREFUSED,
        ):
            return True
        raise
    else:
        connection.close()
        return False


def verify(directory, generation, timeout=120):
    with open(os.path.join(directory, "verified-generation")) as source:
        if source.read().strip() != generation:
            raise ValueError(
                "backup verification generation differs from the rehearsal"
            )
    with open(os.path.join(directory, "production-cassandra-addresses")) as source:
        addresses = source.read().splitlines()
    if len(addresses) != 3 or len(set(addresses)) != 3:
        raise ValueError("three verified production Cassandra addresses are required")
    deadline = time.time() + timeout
    consecutive = 0
    while time.time() < deadline:
        results = [blocked(address) for address in addresses]
        consecutive = consecutive + 1 if all(results) else 0
        if consecutive == 3:
            print(
                "PASS: all three positively verified production CQL endpoints are denied"
            )
            return
        time.sleep(3)
    raise RuntimeError(
        "rehearsal can reach production Cassandra; refusing to start engine"
    )


if __name__ == "__main__":
    verify("/proof", os.environ["GENERATION"])
