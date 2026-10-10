import concurrent.futures
import hashlib
import http.client
import http.server
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

PAYLOAD = b"x" * (8 * 1024 * 1024)
DIGEST = hashlib.sha256(PAYLOAD).hexdigest()
slow_started = threading.Event()


class Backend(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_PUT(self):
        if self.path == "/slow":
            slow_started.set()
        digest = hashlib.sha256()
        remaining = int(self.headers["Content-Length"])
        while remaining:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                return
            digest.update(chunk)
            remaining -= len(chunk)
        body = digest.hexdigest().encode()
        try:
            self.send_response(201)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except ConnectionError:
            pass


def put(index):
    connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=7)
    try:
        connection.request("PUT", f"/fast-{index}", PAYLOAD)
        response = connection.getresponse()
        assert response.status == 201 and response.read().decode() == DIGEST
    finally:
        connection.close()


def slow_put():
    connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=20)
    try:
        connection.putrequest("PUT", "/slow")
        connection.putheader("Content-Length", str(len(PAYLOAD)))
        connection.endheaders()
        connection.send(PAYLOAD[:65536])
        time.sleep(8)
        connection.send(PAYLOAD[65536:])
        response = connection.getresponse()
        assert response.status == 201 and response.read().decode() == DIGEST
    finally:
        connection.close()


server = http.server.ThreadingHTTPServer(("127.0.0.1", 5000), Backend)
threading.Thread(target=server.serve_forever, daemon=True).start()
config = Path("/tmp/registry-pacing.cfg")
config.write_text(
    Path(sys.argv[1]).read_text().replace("global\n", "global\n  nbthread 4\n", 1)
)
proxy = subprocess.Popen(
    ["haproxy", "-db", "-f", str(config)], stdout=subprocess.DEVNULL
)
try:
    for attempt in range(100):
        if proxy.poll() is not None:
            raise RuntimeError("HAProxy exited before accepting traffic")
        try:
            connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=1)
            connection.request("GET", "/v2/")
            assert connection.getresponse().status == 200
            connection.close()
            break
        except OSError:
            time.sleep(0.05)
    else:
        raise RuntimeError("HAProxy did not become ready")
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        slow = pool.submit(slow_put)
        assert slow_started.wait(2), "slow upload never reached the backend"
        start = time.monotonic()
        fast = [pool.submit(put, index) for index in range(3)]
        connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=2)
        connection.request("GET", "/v2/")
        assert connection.getresponse().status == 200
        connection.close()
        read_elapsed = time.monotonic() - start
        for future in fast:
            future.result()
        fast_elapsed = time.monotonic() - start
        assert fast_elapsed < 7, "fast uploads waited behind the stalled upload"
        assert fast_elapsed >= 3, (
            "concurrent uploads exceeded the shared 5 MiB/s budget"
        )
        slow.result()
    print(
        json.dumps(
            {
                "concurrentUploads": 4,
                "fastUploadBytes": 3 * len(PAYLOAD),
                "fastUploadsSeconds": round(fast_elapsed, 3),
                "readWhileUploadingSeconds": round(read_elapsed, 3),
                "allPayloadDigestsMatch": True,
                "sharedUploadBudgetPassed": True,
            }
        )
    )
finally:
    proxy.terminate()
    try:
        proxy.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proxy.kill()
        proxy.wait()
    server.shutdown()
    server.server_close()
