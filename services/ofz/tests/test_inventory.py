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

        for method in ["DELETE", "HEAD", "OPTIONS"]:
            with self.subTest(method=method):

                def inject(path, *args, **kwargs):
                    content = read_text(path, *args, **kwargs)
                    if str(path).endswith("api/tengri/route.ts"):
                        content += f"\nexport const {method} = () => new Response();\n"
                    return content

                with patch.object(Path, "read_text", inject):
                    with self.assertRaisesRegex(
                        AssertionError, f"unclassified=.*{method} /api/tengri"
                    ):
                        inventory.main()

    def test_new_gateway_or_supervisor_method_requires_classification(self):
        read_text = Path.read_text
        for source in ["gateway.rs", "slot/supervisor.rs"]:
            with self.subTest(source=source):

                def inject(path, *args, **kwargs):
                    content = read_text(path, *args, **kwargs)
                    if str(path).endswith(f"tengri/src/{source}"):
                        content = content.replace(
                            '.route("/livez", get(', '.route("/livez", post(', 1
                        )
                    return content

                with patch.object(Path, "read_text", inject):
                    with self.assertRaisesRegex(
                        AssertionError, "unclassified=.*POST /livez"
                    ):
                        inventory.main()

    def test_reexported_next_methods_require_classification(self):
        read_text = Path.read_text
        for declaration in [
            "const handler = () => new Response(); export { handler as DELETE }",
            "export { handler as DELETE } from './handler'",
            "export { DELETE } from './handler'",
            "export { handler as 'DELETE' } from './handler'",
            "export let DELETE = () => new Response()",
            'const url = "https://example.test/*"; export { handler /* } */ as DELETE }',
        ]:
            with self.subTest(declaration=declaration):

                def inject(path, *args, **kwargs):
                    content = read_text(path, *args, **kwargs)
                    if str(path).endswith("api/tengri/route.ts"):
                        content += "\n" + declaration + "\n"
                    return content

                with patch.object(Path, "read_text", inject):
                    with self.assertRaisesRegex(
                        AssertionError, "unclassified=.*DELETE /api/tengri"
                    ):
                        inventory.main()
        with self.assertRaisesRegex(AssertionError, "wildcard Next route exports"):
            inventory.next_methods("export * from './handler'")

    def test_nonliteral_axum_paths_fail_closed(self):
        read_text = Path.read_text
        for source in ["gateway.rs", "slot/supervisor.rs"]:
            with self.subTest(source=source):

                def inject(path, *args, **kwargs):
                    content = read_text(path, *args, **kwargs)
                    if str(path).endswith(f"tengri/src/{source}"):
                        content = content.replace(
                            '.route("/livez", get(', ".route(SECRET_PATH, get(", 1
                        )
                    return content

                with patch.object(Path, "read_text", inject):
                    with self.assertRaisesRegex(
                        AssertionError,
                        "Axum route path must be an explicit string literal",
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

    def test_nonliteral_go_handlers_fail_closed(self):
        read_text = Path.read_text
        for handler in ["Handle", "HandleFunc"]:
            with self.subTest(handler=handler):

                def inject(path, *args, **kwargs):
                    content = read_text(path, *args, **kwargs)
                    if str(path).endswith("nanoagent/api.go"):
                        content += f"\nmux.{handler}(secretPath, secret)\n"
                    return content

                with patch.object(Path, "read_text", inject):
                    with self.assertRaisesRegex(
                        AssertionError,
                        "Go handler path must be an explicit string literal",
                    ):
                        inventory.main()

    def test_every_codex_method_literal_requires_classification(self):
        read_text = Path.read_text
        for method in ["thread/foo2", "thread/foo_bar", "thread/foo-bar", "ping"]:
            with self.subTest(method=method):

                def inject(path, *args, **kwargs):
                    content = read_text(path, *args, **kwargs)
                    if str(path).endswith("nanoagent/codex.go"):
                        start = content.index("func allowedCodexMethod")
                        content = content[:start] + content[start:].replace(
                            'case "account/read",',
                            f'case "{method}", "account/read",',
                            1,
                        )
                    return content

                with patch.object(Path, "read_text", inject):
                    with self.assertRaisesRegex(AssertionError, "codex: unclassified="):
                        inventory.main()
        with self.assertRaisesRegex(AssertionError, "explicit string literals"):
            inventory.operation_cases("case dynamicMethod: return true")


if __name__ == "__main__":
    unittest.main()
