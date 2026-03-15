from __future__ import annotations

from pathlib import Path
import unittest


class SimulationParityGuardTest(unittest.TestCase):
    def test_trading_modules_do_not_branch_directly_on_simulation_mode_outside_allowlist(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        trading_root = repo_root / 'app' / 'trading'
        allowlist = {
            'execution_adapters.py',
            'market_session.py',
            'simulation.py',
            'simulation_progress.py',
            'simulation_window.py',
            'time_source.py',
            'universe.py',
        }
        violations: list[str] = []

        for path in sorted(trading_root.rglob('*.py')):
            relative = path.relative_to(trading_root).as_posix()
            if relative in allowlist:
                continue
            for line_number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), start=1):
                if 'settings.trading_simulation_enabled' not in line:
                    continue
                violations.append(f'{relative}:{line_number}: {line.strip()}')

        self.assertEqual(
            violations,
            [],
            msg=(
                'Direct simulation-mode branching leaked into trading business modules outside the allowlist:\n'
                + '\n'.join(violations)
            ),
        )
