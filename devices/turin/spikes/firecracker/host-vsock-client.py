#!/usr/bin/env python3
import socket
import sys


def receive_line(connection: socket.socket) -> str:
    chunks: list[bytes] = []
    while True:
        byte = connection.recv(1)
        if not byte:
            break
        chunks.append(byte)
        if byte == b"\n":
            break
    return b"".join(chunks).decode("utf-8").strip()


def main() -> None:
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(5)
    connection.connect(sys.argv[1])
    connection.sendall(b"CONNECT 1024\n")
    acknowledgement = receive_line(connection)
    if not acknowledgement.startswith("OK "):
        raise RuntimeError(f"unexpected Firecracker vsock acknowledgement: {acknowledgement!r}")
    connection.sendall(b"status\n")
    response = receive_line(connection)
    print(response)


if __name__ == "__main__":
    main()
