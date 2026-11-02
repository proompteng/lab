#!/usr/bin/env python3
import json
import socket


def main() -> None:
    server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    server.bind((socket.VMADDR_CID_ANY, 1024))
    server.listen(4)

    while True:
        connection, _ = server.accept()
        with connection:
            command = connection.recv(128).decode("utf-8").strip()
            if command == "status":
                response = {
                    "agent": "ready",
                    "control": "vsock",
                    "guest_cid": socket.VMADDR_CID_ANY,
                }
            else:
                response = {"error": "unsupported-command", "command": command}
            connection.sendall((json.dumps(response, sort_keys=True) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
