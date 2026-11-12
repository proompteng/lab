import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "integration_results", Path(__file__).with_name("verify-integration-results.py")
)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class IntegrationResultsTest(unittest.TestCase):
    def verify(self, suites: str, expected: list[Path] | None = None) -> None:
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "results.xml"
            report.write_text(f'<testsuites name="bun test">{suites}</testsuites>')
            module.verify(report, expected or [])

    def test_executed_required_file_passes(self) -> None:
        self.verify(
            '<testsuite file="required.test.ts"><testcase name="executes" /></testsuite>',
            [Path("required.test.ts")],
        )

    def test_one_passing_file_cannot_hide_an_all_skipped_file(self) -> None:
        with self.assertRaisesRegex(ValueError, "no successful cases"):
            self.verify(
                '<testsuite file="passing.test.ts"><testcase name="executes" /></testsuite>'
                '<testsuite file="disabled.test.ts"><testcase name="disabled"><skipped /></testcase></testsuite>'
            )

    def test_empty_or_missing_required_files_fail(self) -> None:
        with self.assertRaisesRegex(ValueError, "no test files"):
            self.verify("")
        with self.assertRaisesRegex(ValueError, "absent from report"):
            self.verify(
                '<testsuite file="other.test.ts"><testcase name="executes" /></testsuite>',
                [Path("required.test.ts")],
            )

    def test_failure_cannot_be_hidden_by_another_success(self) -> None:
        with self.assertRaisesRegex(ValueError, "integration failed"):
            self.verify(
                '<testsuite file="required.test.ts"><testcase name="executes" />'
                '<testcase name="failed"><failure /></testcase></testsuite>'
            )


if __name__ == "__main__":
    unittest.main()
