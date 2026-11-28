import io
import json
import threading
import unittest
from unittest.mock import patch

import proxy


class ReadinessTest(unittest.TestCase):
    def setUp(self):
        proxy.validated.clear()
        self.resident = False
        self.embeds = 0
        self.width = proxy.embedding_dimension
        self.respond = lambda: None
        self.addCleanup(proxy.validated.clear)
        self.enterContext(patch.object(proxy, "require_gpu_residency", True))
        self.enterContext(patch.object(proxy, "upstream_request", self.upstream))

    def upstream(self, method, path, body=None, headers=None):
        if (method, path) == ("GET", "/api/ps"):
            models = (
                [{"name": proxy.embedding_model, "size_vram": 10}]
                if self.resident
                else []
            )
            return io.BytesIO(json.dumps({"models": models}).encode())
        self.assertEqual((method, path), ("POST", "/v1/embeddings"))
        self.assertEqual(json.loads(body)["dimensions"], proxy.embedding_dimension)
        self.embeds += 1
        self.respond()
        self.resident = True
        return io.BytesIO(
            json.dumps({"data": [{"embedding": [0] * self.width}]}).encode()
        )

    def test_warms_once_and_recovers_when_ollama_restarts(self):
        self.assertTrue(proxy.ready()[0])
        self.assertTrue(proxy.ready()[0])
        self.assertEqual(self.embeds, 1)
        self.resident = False
        self.assertTrue(proxy.ready()[0])
        self.assertEqual(self.embeds, 2)

    def test_overlapping_probes_do_not_enqueue_embeddings(self):
        entered, finish = threading.Event(), threading.Event()

        def wait_for_release():
            entered.set()
            finish.wait(5)

        self.respond = wait_for_release
        worker = threading.Thread(target=proxy.ready)
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertFalse(proxy.ready()[0])
            self.assertEqual(self.embeds, 1)
        finally:
            finish.set()
            worker.join(5)
        self.assertTrue(proxy.ready()[0])
        self.assertEqual(self.embeds, 1)

    def test_invalid_vector_cannot_mark_the_model_ready(self):
        self.width = 1
        self.assertFalse(proxy.ready()[0])
        self.width = proxy.embedding_dimension
        self.assertTrue(proxy.ready()[0])
