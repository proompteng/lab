from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import Mock
from unittest.mock import call
from unittest.mock import patch

from scripts.check_diff_coverage import (
    FileDiffCoverage,
    _executable_source_lines,
    _format_summary,
    _git,
    _git_optional,
    _include_untracked_python_files,
    _load_coverage_index,
    _list_untracked_python_files,
    _parse_args,
    _parse_changed_python_lines,
    _repo_root,
    _resolve_base_spec,
    _resolve_diff_base,
    main,
    summarize_changed_coverage,
)


class TestCheckDiffCoverage(TestCase):
    def test_file_diff_coverage_ratio_defaults_to_one_for_zero_executable_lines(self) -> None:
        item = FileDiffCoverage(
            filename='app/trading/foo.py',
            executable_changed_lines=0,
            covered_lines=0,
            missing_lines=(),
        )

        self.assertEqual(item.coverage_ratio, 1.0)

    def test_parse_args_uses_expected_defaults(self) -> None:
        with patch.object(sys, 'argv', ['check_diff_coverage.py']):
            args = _parse_args()

        self.assertEqual(args.coverage_xml, 'coverage.xml')
        self.assertEqual(args.threshold, 90.0)
        self.assertEqual(args.base_ref, '')

    def test_parse_args_accepts_explicit_values(self) -> None:
        with patch.object(
            sys,
            'argv',
            ['check_diff_coverage.py', '--coverage-xml', 'custom.xml', '--threshold', '95', '--base-ref', 'origin/main'],
        ):
            args = _parse_args()

        self.assertEqual(args.coverage_xml, 'custom.xml')
        self.assertEqual(args.threshold, 95.0)
        self.assertEqual(args.base_ref, 'origin/main')

    def test_repo_root_finds_nearest_git_directory(self) -> None:
        with TemporaryDirectory() as tmpdir:
            repo_root = Path(tmpdir)
            (repo_root / '.git').mkdir()
            nested = repo_root / 'services' / 'torghut'
            nested.mkdir(parents=True, exist_ok=True)

            resolved = _repo_root(nested)

        self.assertEqual(resolved, repo_root.resolve())

    def test_repo_root_raises_when_git_directory_missing(self) -> None:
        with TemporaryDirectory() as tmpdir:
            start = Path(tmpdir)
            with self.assertRaisesRegex(RuntimeError, 'repo_root_not_found'):
                _repo_root(start)

    @patch('scripts.check_diff_coverage.subprocess.run')
    def test_git_returns_stripped_stdout(self, run_mock: object) -> None:
        run_mock.return_value = Mock(stdout=' abc123 \n')

        result = _git(Path('/tmp/repo'), 'rev-parse', 'HEAD')

        self.assertEqual(result, 'abc123')
        run_mock.assert_called_once()

    @patch('scripts.check_diff_coverage._git')
    def test_git_optional_returns_none_on_called_process_error(self, git_mock: object) -> None:
        git_mock.side_effect = subprocess.CalledProcessError(1, ['git'])

        result = _git_optional(Path('/tmp/repo'), 'rev-parse', 'HEAD')

        self.assertIsNone(result)

    @patch.dict('os.environ', {'GITHUB_BASE_REF': 'main'})
    def test_resolve_base_spec_uses_explicit_then_env(self) -> None:
        self.assertEqual(_resolve_base_spec('origin/release'), 'origin/release')
        self.assertEqual(_resolve_base_spec(''), 'origin/main')

    @patch.dict('os.environ', {}, clear=True)
    def test_resolve_base_spec_returns_none_without_inputs(self) -> None:
        self.assertIsNone(_resolve_base_spec(''))

    def test_parse_changed_python_lines_extracts_added_source_lines(self) -> None:
        diff_text = '''
diff --git a/services/torghut/app/trading/foo.py b/services/torghut/app/trading/foo.py
index 1111111..2222222 100644
--- a/services/torghut/app/trading/foo.py
+++ b/services/torghut/app/trading/foo.py
@@ -10,0 +11,2 @@
+first = 1
+second = 2
@@ -20 +23 @@
+third = 3
diff --git a/services/torghut/tests/test_foo.py b/services/torghut/tests/test_foo.py
--- a/services/torghut/tests/test_foo.py
+++ b/services/torghut/tests/test_foo.py
@@ -1 +1 @@
+ignored = True
'''.strip()

        changed_lines = _parse_changed_python_lines(diff_text)

        self.assertEqual(
            changed_lines,
            {'app/trading/foo.py': {11, 12, 23}},
        )

    def test_parse_changed_python_lines_ignores_zero_count_hunks(self) -> None:
        diff_text = '''
diff --git a/services/torghut/scripts/foo.py b/services/torghut/scripts/foo.py
+++ b/services/torghut/scripts/foo.py
@@ -10,0 +11,0 @@
'''.strip()

        changed_lines = _parse_changed_python_lines(diff_text)

        self.assertEqual(changed_lines, {'scripts/foo.py': set()})

    def test_load_coverage_index_reads_line_hits(self) -> None:
        xml_text = '''
<coverage>
  <packages>
    <package name="app">
      <classes>
        <class filename="app/trading/foo.py">
          <lines>
            <line number="11" hits="1"/>
            <line number="12" hits="0"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
'''.strip()
        with TemporaryDirectory() as tmpdir:
            xml_path = Path(tmpdir) / 'coverage.xml'
            xml_path.write_text(xml_text, encoding='utf-8')

            coverage_index = _load_coverage_index(xml_path)

        self.assertEqual(coverage_index['app/trading/foo.py'][11], 1)
        self.assertEqual(coverage_index['app/trading/foo.py'][12], 0)

    def test_load_coverage_index_prefixes_bare_script_filenames(self) -> None:
        xml_text = '''
<coverage>
  <packages>
    <package name=".">
      <classes>
        <class filename="check_diff_coverage.py">
          <lines>
            <line number="20" hits="1"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
'''.strip()
        with TemporaryDirectory() as tmpdir:
            scripts_dir = Path(tmpdir) / 'scripts'
            scripts_dir.mkdir(parents=True, exist_ok=True)
            (scripts_dir / 'check_diff_coverage.py').write_text('print("ok")\n', encoding='utf-8')
            xml_path = Path(tmpdir) / 'coverage.xml'
            xml_path.write_text(xml_text, encoding='utf-8')

            coverage_index = _load_coverage_index(xml_path)

        self.assertEqual(coverage_index['scripts/check_diff_coverage.py'][20], 1)

    def test_load_coverage_index_prefixes_nested_app_filenames(self) -> None:
        xml_text = '''
<coverage>
  <packages>
    <package name="trading">
      <classes>
        <class filename="trading/session_context.py">
          <lines>
            <line number="20" hits="1"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
'''.strip()
        with TemporaryDirectory() as tmpdir:
            app_path = Path(tmpdir) / 'app' / 'trading' / 'session_context.py'
            app_path.parent.mkdir(parents=True, exist_ok=True)
            app_path.write_text('print("ok")\n', encoding='utf-8')
            xml_path = Path(tmpdir) / 'coverage.xml'
            xml_path.write_text(xml_text, encoding='utf-8')

            coverage_index = _load_coverage_index(xml_path)

        self.assertEqual(coverage_index['app/trading/session_context.py'][20], 1)

    def test_summarize_changed_coverage_uses_only_executable_changed_lines(self) -> None:
        summary = summarize_changed_coverage(
            changed_lines={'app/trading/foo.py': {11, 12, 99}},
            coverage_index={'app/trading/foo.py': {11: 1, 12: 0, 30: 1}},
        )

        self.assertEqual(len(summary), 1)
        self.assertEqual(summary[0].filename, 'app/trading/foo.py')
        self.assertEqual(summary[0].covered_lines, 1)
        self.assertEqual(summary[0].executable_changed_lines, 2)
        self.assertEqual(summary[0].missing_lines, (12,))

    def test_summarize_changed_coverage_flags_files_missing_from_coverage(self) -> None:
        summary = summarize_changed_coverage(
            changed_lines={'app/trading/foo.py': {11, 12}},
            coverage_index={},
        )

        self.assertEqual(len(summary), 1)
        self.assertTrue(summary[0].missing_from_coverage)
        self.assertEqual(summary[0].missing_lines, (11, 12))

    @patch.dict('os.environ', {}, clear=True)
    @patch('scripts.check_diff_coverage._git_optional')
    def test_resolve_diff_base_prefers_origin_main_when_no_explicit_base(self, git_optional: object) -> None:
        git_optional.side_effect = ['head-commit', 'base-from-origin-main']

        resolved = _resolve_diff_base(Path('/tmp/repo'), '')

        self.assertEqual(resolved, 'base-from-origin-main')
        self.assertEqual(
            git_optional.call_args_list,
            [
                call(Path('/tmp/repo'), 'rev-parse', 'HEAD'),
                call(Path('/tmp/repo'), 'merge-base', 'origin/main', 'HEAD'),
            ],
        )

    @patch.dict('os.environ', {}, clear=True)
    @patch('scripts.check_diff_coverage._git_optional')
    def test_resolve_diff_base_falls_back_to_head_parent(self, git_optional: object) -> None:
        git_optional.side_effect = ['head-commit', None, None, 'parent-commit']

        resolved = _resolve_diff_base(Path('/tmp/repo'), '')

        self.assertEqual(resolved, 'parent-commit')
        self.assertEqual(
            git_optional.call_args_list[-1].args,
            (Path('/tmp/repo'), 'rev-parse', 'HEAD^'),
        )

    @patch.dict('os.environ', {}, clear=True)
    @patch('scripts.check_diff_coverage._git_optional')
    def test_resolve_diff_base_falls_back_to_head_parent_when_merge_base_is_head(
        self,
        git_optional: object,
    ) -> None:
        git_optional.side_effect = ['head-commit', 'head-commit', 'head-commit', 'parent-commit']

        resolved = _resolve_diff_base(Path('/tmp/repo'), '')

        self.assertEqual(resolved, 'parent-commit')
        self.assertEqual(
            git_optional.call_args_list,
            [
                call(Path('/tmp/repo'), 'rev-parse', 'HEAD'),
                call(Path('/tmp/repo'), 'merge-base', 'origin/main', 'HEAD'),
                call(Path('/tmp/repo'), 'merge-base', 'main', 'HEAD'),
                call(Path('/tmp/repo'), 'rev-parse', 'HEAD^'),
            ],
        )

    @patch('scripts.check_diff_coverage._git_optional')
    def test_list_untracked_python_files_filters_tracked_prefixes(self, git_optional: object) -> None:
        git_optional.return_value = '\n'.join(
            (
                'services/torghut/scripts/check_diff_coverage.py',
                'services/torghut/app/trading/new_module.py',
                'services/torghut/tests/test_foo.py',
                'README.md',
            )
        )

        files = _list_untracked_python_files(Path('/tmp/repo'))

        self.assertEqual(
            files,
            ('app/trading/new_module.py', 'scripts/check_diff_coverage.py'),
        )

    @patch('scripts.check_diff_coverage._git_optional')
    def test_list_untracked_python_files_returns_empty_tuple_when_git_has_no_output(self, git_optional: object) -> None:
        git_optional.return_value = ''

        files = _list_untracked_python_files(Path('/tmp/repo'))

        self.assertEqual(files, ())

    def test_executable_source_lines_extracts_statement_line_numbers(self) -> None:
        with TemporaryDirectory() as tmpdir:
            source_path = Path(tmpdir) / 'module.py'
            source_path.write_text(
                '\n'.join(
                    (
                        '"""module docstring"""',
                        '',
                        'def build() -> int:',
                        '    value = 1',
                        '    return value',
                    )
                ),
                encoding='utf-8',
            )

            executable_lines = _executable_source_lines(source_path)

        self.assertEqual(executable_lines, {3, 4, 5})

    @patch('scripts.check_diff_coverage._list_untracked_python_files')
    def test_include_untracked_python_files_uses_coverage_lines_when_present(self, list_untracked: object) -> None:
        list_untracked.return_value = ('scripts/check_diff_coverage.py',)
        changed_lines = {'app/trading/foo.py': {10}}
        coverage_index = {'scripts/check_diff_coverage.py': {20: 1, 21: 0}}

        with TemporaryDirectory() as tmpdir:
            combined = _include_untracked_python_files(
                changed_lines=changed_lines,
                coverage_index=coverage_index,
                service_root=Path(tmpdir),
                repo_root=Path(tmpdir),
            )

        self.assertEqual(combined['app/trading/foo.py'], {10})
        self.assertEqual(combined['scripts/check_diff_coverage.py'], {20, 21})

    @patch('scripts.check_diff_coverage._list_untracked_python_files')
    def test_include_untracked_python_files_falls_back_to_ast_lines(self, list_untracked: object) -> None:
        list_untracked.return_value = ('scripts/new_tool.py',)

        with TemporaryDirectory() as tmpdir:
            service_root = Path(tmpdir)
            script_path = service_root / 'scripts' / 'new_tool.py'
            script_path.parent.mkdir(parents=True, exist_ok=True)
            script_path.write_text(
                '\n'.join(
                    (
                        'def main() -> int:',
                        '    return 1',
                    )
                ),
                encoding='utf-8',
            )

            combined = _include_untracked_python_files(
                changed_lines={},
                coverage_index={},
                service_root=service_root,
                repo_root=service_root,
            )

        self.assertEqual(combined['scripts/new_tool.py'], {1, 2})

    def test_summarize_changed_coverage_skips_non_executable_changed_lines(self) -> None:
        summary = summarize_changed_coverage(
            changed_lines={'app/trading/foo.py': {90}},
            coverage_index={'app/trading/foo.py': {11: 1, 12: 0}},
        )

        self.assertEqual(summary, [])

    def test_format_summary_includes_missing_from_coverage_suffix(self) -> None:
        text = _format_summary(
            [
                FileDiffCoverage(
                    filename='scripts/check_diff_coverage.py',
                    executable_changed_lines=2,
                    covered_lines=1,
                    missing_lines=(20,),
                    missing_from_coverage=True,
                )
            ]
        )

        self.assertIn('missing-from-coverage', text)
        self.assertIn('missing lines: 20', text)

    @patch('scripts.check_diff_coverage._parse_args')
    @patch('scripts.check_diff_coverage._repo_root')
    @patch('scripts.check_diff_coverage._resolve_diff_base')
    def test_main_skips_when_no_base_commit(
        self,
        resolve_diff_base: object,
        repo_root: object,
        parse_args: object,
    ) -> None:
        parse_args.return_value = Mock(coverage_xml='coverage.xml', threshold=90.0, base_ref='')
        repo_root.return_value = Path('/tmp/repo')
        resolve_diff_base.return_value = None

        with patch('sys.stdout.write') as stdout_write:
            exit_code = main()

        self.assertEqual(exit_code, 0)
        self.assertTrue(any('no base commit available' in call.args[0] for call in stdout_write.call_args_list))

    @patch('scripts.check_diff_coverage._parse_args')
    @patch('scripts.check_diff_coverage._repo_root')
    @patch('scripts.check_diff_coverage._resolve_diff_base')
    @patch('scripts.check_diff_coverage._git')
    @patch('scripts.check_diff_coverage._load_coverage_index')
    @patch('scripts.check_diff_coverage._include_untracked_python_files')
    def test_main_skips_when_no_changed_python_source_lines(
        self,
        include_untracked: object,
        load_coverage: object,
        git_mock: object,
        resolve_diff_base: object,
        repo_root: object,
        parse_args: object,
    ) -> None:
        parse_args.return_value = Mock(coverage_xml='coverage.xml', threshold=90.0, base_ref='')
        repo_root.return_value = Path('/tmp/repo')
        resolve_diff_base.return_value = 'base'
        git_mock.return_value = ''
        load_coverage.return_value = {}
        include_untracked.return_value = {}

        with patch('sys.stdout.write') as stdout_write:
            exit_code = main()

        self.assertEqual(exit_code, 0)
        self.assertTrue(any('no changed Torghut Python source lines' in call.args[0] for call in stdout_write.call_args_list))

    @patch('scripts.check_diff_coverage._parse_args')
    @patch('scripts.check_diff_coverage._repo_root')
    @patch('scripts.check_diff_coverage._resolve_diff_base')
    @patch('scripts.check_diff_coverage._git')
    @patch('scripts.check_diff_coverage._load_coverage_index')
    @patch('scripts.check_diff_coverage._include_untracked_python_files')
    def test_main_fails_for_missing_coverage_files(
        self,
        include_untracked: object,
        load_coverage: object,
        git_mock: object,
        resolve_diff_base: object,
        repo_root: object,
        parse_args: object,
    ) -> None:
        parse_args.return_value = Mock(coverage_xml='coverage.xml', threshold=90.0, base_ref='')
        repo_root.return_value = Path('/tmp/repo')
        resolve_diff_base.return_value = 'base'
        git_mock.return_value = ''
        load_coverage.return_value = {}
        include_untracked.return_value = {'scripts/check_diff_coverage.py': {20, 21}}

        with patch('sys.stderr.write') as stderr_write:
            exit_code = main()

        self.assertEqual(exit_code, 1)
        self.assertTrue(any('missing from coverage.xml' in call.args[0] for call in stderr_write.call_args_list))

    @patch('scripts.check_diff_coverage._parse_args')
    @patch('scripts.check_diff_coverage._repo_root')
    @patch('scripts.check_diff_coverage._resolve_diff_base')
    @patch('scripts.check_diff_coverage._git')
    @patch('scripts.check_diff_coverage._load_coverage_index')
    @patch('scripts.check_diff_coverage._include_untracked_python_files')
    def test_main_fails_when_threshold_not_met(
        self,
        include_untracked: object,
        load_coverage: object,
        git_mock: object,
        resolve_diff_base: object,
        repo_root: object,
        parse_args: object,
    ) -> None:
        parse_args.return_value = Mock(coverage_xml='coverage.xml', threshold=95.0, base_ref='')
        repo_root.return_value = Path('/tmp/repo')
        resolve_diff_base.return_value = 'base'
        git_mock.return_value = ''
        load_coverage.return_value = {'scripts/check_diff_coverage.py': {20: 1, 21: 0}}
        include_untracked.return_value = {'scripts/check_diff_coverage.py': {20, 21}}

        with patch('sys.stderr.write') as stderr_write:
            exit_code = main()

        self.assertEqual(exit_code, 1)
        self.assertTrue(any('below threshold 95.00%' in call.args[0] for call in stderr_write.call_args_list))

    @patch('scripts.check_diff_coverage._parse_args')
    @patch('scripts.check_diff_coverage._repo_root')
    @patch('scripts.check_diff_coverage._resolve_diff_base')
    @patch('scripts.check_diff_coverage._git')
    @patch('scripts.check_diff_coverage._load_coverage_index')
    @patch('scripts.check_diff_coverage._include_untracked_python_files')
    def test_main_succeeds_when_threshold_is_met(
        self,
        include_untracked: object,
        load_coverage: object,
        git_mock: object,
        resolve_diff_base: object,
        repo_root: object,
        parse_args: object,
    ) -> None:
        parse_args.return_value = Mock(coverage_xml='coverage.xml', threshold=50.0, base_ref='')
        repo_root.return_value = Path('/tmp/repo')
        resolve_diff_base.return_value = 'base'
        git_mock.return_value = ''
        load_coverage.return_value = {'scripts/check_diff_coverage.py': {20: 1, 21: 0}}
        include_untracked.return_value = {'scripts/check_diff_coverage.py': {20, 21}}

        exit_code = main()

        self.assertEqual(exit_code, 0)
