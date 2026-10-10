import contextlib
import io
import unittest
from pathlib import Path
from unittest.mock import patch

import inventory


class InventoryTests(unittest.TestCase):
    def test_current_services_are_completely_classified(self):
        with contextlib.redirect_stdout(io.StringIO()):
            inventory.main()

    def test_new_rpc_fails_before_it_can_be_shipped(self):
        read_text = Path.read_text

        def inject(path, *args, **kwargs):
            content = read_text(path, *args, **kwargs)
            if str(path).endswith("microvm.proto"):
                content += "\nrpc ExportCredentials(Empty) returns (Empty);\n"
            return content

        with patch.object(Path, "read_text", inject):
            with self.assertRaisesRegex(
                AssertionError, "unclassified=.*ExportCredentials"
            ):
                inventory.main()

    def test_new_http_method_fails_before_it_can_be_shipped(self):
        read_text = Path.read_text

        def inject(path, *args, **kwargs):
            content = read_text(path, *args, **kwargs)
            if str(path).endswith("api/tengri/route.ts"):
                content += "\nexport const DELETE = () => new Response();\n"
            return content

        with patch.object(Path, "read_text", inject):
            with self.assertRaisesRegex(
                AssertionError, "unclassified=.*DELETE /api/tengri"
            ):
                inventory.main()

    def test_go_handlers_in_every_source_file_are_classified(self):
        read_text = Path.read_text
        for source in ["api.go", "browser_cua.go", "grpc.go"]:
            for handler in ["Handle", "HandleFunc"]:
                with self.subTest(source=source, handler=handler):

                    def inject(path, *args, **kwargs):
                        content = read_text(path, *args, **kwargs)
                        if str(path).endswith(f"nanoagent/{source}"):
                            content += f'\nmux.{handler}("GET /secret", secret)\n'
                        return content

                    with patch.object(Path, "read_text", inject):
                        with self.assertRaisesRegex(
                            AssertionError, "unclassified=.*GET /secret"
                        ):
                            inventory.main()


if __name__ == "__main__":
    unittest.main()
