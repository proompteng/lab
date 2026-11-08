import concurrent.futures
import http.client
import http.server
import json
import shutil
import subprocess
import sys
import threading
import time
import uuid

sys.path.insert(0, "/cleanup")
import maintenance
from test_cleanup import CleanupTest

started = threading.Event()
finish_upload = threading.Event()
frozen = threading.Event()
release_gate = threading.Event()


class Backend(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        self.send_response(201)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_PUT(self):
        started.set()
        self.rfile.read(int(self.headers["Content-Length"]))
        self.send_response(201)
        self.send_header("Content-Length", "0")
        self.end_headers()


def request(method):
    connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=3)
    try:
        connection.request(method, "/v2/fixture/blobs/uploads/", b"")
        response = connection.getresponse()
        response.read()
        return response.status
    finally:
        connection.close()


def slow_upload():
    connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=10)
    try:
        connection.putrequest("PUT", "/slow")
        connection.putheader("Content-Length", "8")
        connection.endheaders()
        connection.send(b"ab")
        assert finish_upload.wait(5)
        connection.send(b"cdefgh")
        assert connection.getresponse().status == 201
    finally:
        connection.close()


def proxy_start():
    process = subprocess.Popen(
        ["haproxy", "-db", "-f", "/proxy.cfg"], stdout=subprocess.DEVNULL
    )
    for _ in range(100):
        assert process.poll() is None, "HAProxy exited before serving traffic"
        try:
            if request("GET") == 200:
                return process
        except OSError:
            pass
        time.sleep(0.05)
    raise RuntimeError("HAProxy did not become ready")


def proxy_stop(process):
    process.terminate()
    process.wait(timeout=5)


def hold_gate():
    with gate.frozen(time.monotonic() + 5):
        frozen.set()
        assert release_gate.wait(5)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 5000), Backend)
threading.Thread(target=server.serve_forever, daemon=True).start()
maintenance.CONTROL.mkdir(exist_ok=True)
(maintenance.CONTROL / "freeze.map").write_text("freeze 0\n")
proxy = proxy_start()
gate = maintenance.WriteGate()
try:
    gate.open()
    assert request("POST") == 201
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        upload = pool.submit(slow_upload)
        assert started.wait(2)
        collection = pool.submit(hold_gate)
        for _ in range(100):
            if request("POST") == 405:
                break
            time.sleep(0.01)
        else:
            raise AssertionError("new writes were not rejected")
        assert not frozen.is_set(), "cleanup started before the existing upload drained"
        assert request("GET") == 200
        finish_upload.set()
        upload.result(timeout=5)
        assert frozen.wait(2)
        gate.require_frozen()
        for method in ["POST", "PUT", "PATCH", "DELETE"]:
            assert request(method) == 405
        proxy_stop(proxy)
        proxy = proxy_start()
        assert request("GET") == 200
        assert request("POST") == 405, "proxy restart reopened a frozen registry"
        release_gate.set()
        collection.result(timeout=5)
    assert request("POST") == 201
    try:
        with gate.frozen(time.monotonic() + 2):
            raise RuntimeError("fixture collection failure")
    except RuntimeError as error:
        assert str(error) == "fixture collection failure"
    assert request("POST") == 201

    fixture = CleanupTest()
    fixture.setUp()
    try:
        orphan = fixture.blob(b"native worker orphan")
        for number in range(6):
            fixture.tag(format(number, "040x"), fixture.image)
        maintenance.ROOT.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(fixture.root, maintenance.ROOT)
        process = subprocess.Popen(
            ["python3", "/cleanup/maintenance.py", "run", uuid.uuid4().hex],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        process.stdin.write(
            json.dumps(
                {
                    "references": fixture.references,
                    "storage": {"pvcUid": "claim", "pv": "volume"},
                    "code": maintenance.code_hashes(),
                }
            )
            + "\n"
        )
        process.stdin.flush()
        summary = None
        for line in process.stdout:
            event = json.loads(line)
            if event["event"] == "refresh-references":
                process.stdin.write(
                    json.dumps({"references": fixture.references}) + "\n"
                )
                process.stdin.flush()
            if event["event"] == "complete":
                summary = event
        assert process.wait(timeout=5) == 0
        process.stdin.close()
        process.stdout.close()
        assert summary and summary["deletedBlobs"] == 1 and summary["deletedTags"] == 1
        store = maintenance.Store(maintenance.ROOT)
        assert not store.blob(orphan).exists()
        assert store.blob(fixture.image).exists()
        assert (
            len(list((store.repository("lab/test") / "_manifests/tags").iterdir())) == 6
        )
        assert request("POST") == 201
    finally:
        fixture.doCleanups()

    run_id = uuid.uuid4().hex
    code = """import json,os,sys,time
sys.path.insert(0,'/cleanup')
import maintenance as m
with m.locked(m.ROOT):
 m.atomic_json(m.CONTROL/'worker.json',{'run':sys.argv[1],'pid':os.getpid(),'start':m.process_start(os.getpid()),'boot':m.boot_id()})
 with m.WriteGate().frozen(time.monotonic()+5):
  print('frozen',flush=True)
  time.sleep(300)
"""
    crashed = subprocess.Popen(
        ["python3", "-c", code, run_id], stdout=subprocess.PIPE, text=True
    )
    for line in crashed.stdout:
        if line.strip() == "frozen":
            break
    assert request("POST") == 405
    crashed.kill()
    crashed.wait(timeout=5)
    crashed.stdout.close()
    subprocess.run(
        ["python3", "/cleanup/maintenance.py", "stop", run_id], check=True, timeout=5
    )
    assert request("POST") == 201

    cancelled_id = uuid.uuid4().hex
    subprocess.run(
        ["python3", "/cleanup/maintenance.py", "stop", cancelled_id],
        check=True,
        timeout=5,
    )
    initial = {
        "references": fixture.references,
        "storage": {"pvcUid": "claim", "pv": "volume"},
        "code": maintenance.code_hashes(),
    }
    cancelled = subprocess.run(
        ["python3", "/cleanup/maintenance.py", "run", cancelled_id],
        input=json.dumps(initial) + "\n",
        text=True,
        capture_output=True,
        timeout=5,
    )
    assert (
        cancelled.returncode != 0
        and "stopped before its worker started" in cancelled.stderr
    )
    assert request("POST") == 201
    initial["code"] = {}
    mixed = subprocess.run(
        ["python3", "/cleanup/maintenance.py", "run", uuid.uuid4().hex],
        input=json.dumps(initial) + "\n",
        text=True,
        capture_output=True,
        timeout=5,
    )
    assert mixed.returncode != 0 and "different script revisions" in mixed.stderr
    assert request("POST") == 201
    print(
        json.dumps(
            {
                "stalledUploadDrained": True,
                "readsAvailableWhileFrozen": True,
                "proxyRestartPreservesFence": True,
                "failureRestoresUploads": True,
                "nativeRetentionAndPurgePassed": True,
                "killedWorkerRecoveryPassed": True,
                "cancelBeforeStartPassed": True,
                "mixedRevisionRejected": True,
            }
        )
    )
finally:
    proxy_stop(proxy)
    server.shutdown()
    server.server_close()
