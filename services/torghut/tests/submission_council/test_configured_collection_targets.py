from __future__ import annotations

from app.trading.submission_council.configured_collection import (
    with_configured_paper_collection_targets,
)

from tests.submission_council.support import (
    Base,
    StaticPool,
    Strategy,
    SubmissionCouncilTestCase,
    create_engine,
    sessionmaker,
    settings,
)


class TestConfiguredCollectionTargets(SubmissionCouncilTestCase):
    def test_configured_collection_replaces_empty_plan_source(self) -> None:
        account_label_before = settings.trading_account_label
        static_symbols_before = settings.trading_static_symbols_raw
        try:
            settings.trading_simple_paper_route_probe_enabled = True
            settings.trading_simple_paper_route_probe_allow_live_mode = True
            settings.trading_simple_paper_route_probe_max_notional = 100
            settings.trading_account_label = "PA3SX7FYNUTF"
            settings.trading_static_symbols_raw = "NVDA,AMD,MU"

            engine = create_engine(
                "sqlite+pysqlite:///:memory:",
                future=True,
                connect_args={"check_same_thread": False},
                poolclass=StaticPool,
            )
            Base.metadata.create_all(engine)
            session_local = sessionmaker(
                bind=engine,
                expire_on_commit=False,
                future=True,
            )

            with session_local() as session:
                session.add(
                    Strategy(
                        name="string-universe",
                        description="configured paper collection",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols="nvda, mu, NVDA",
                    )
                )
                session.commit()

                result = with_configured_paper_collection_targets(
                    {
                        "targets": "not-a-target-list",
                        "target_count": "0",
                        "source_collection_target_count": True,
                    },
                    session=session,
                )
        finally:
            settings.trading_account_label = account_label_before
            settings.trading_static_symbols_raw = static_symbols_before

        self.assertEqual(
            result["source"], "configured_simple_lane_paper_data_collection"
        )
        self.assertEqual(
            result["source_ref"],
            "configured-static-universe-paper-data-collection",
        )
        self.assertEqual(result["account_label"], "TORGHUT_SIM")
        self.assertEqual(result["source_collection_target_count"], 2)
        self.assertEqual(result["configured_bounded_collection_target_count"], 1)
        targets = result["targets"]
        self.assertEqual(targets[0]["paper_route_probe_symbols"], ["NVDA", "MU"])

    def test_configured_collection_skips_unusable_and_duplicate_strategies(
        self,
    ) -> None:
        static_symbols_before = settings.trading_static_symbols_raw
        try:
            settings.trading_simple_paper_route_probe_enabled = True
            settings.trading_simple_paper_route_probe_allow_live_mode = True
            settings.trading_simple_paper_route_probe_max_notional = 100
            settings.trading_static_symbols_raw = "NVDA,AMD"

            engine = create_engine(
                "sqlite+pysqlite:///:memory:",
                future=True,
                connect_args={"check_same_thread": False},
                poolclass=StaticPool,
            )
            Base.metadata.create_all(engine)
            session_local = sessionmaker(
                bind=engine,
                expire_on_commit=False,
                future=True,
            )
            plan = {
                "source": "external_paper_route_target_plan",
                "target_count": 1,
                "targets": [
                    {
                        "hypothesis_id": "configured-paper-collection:duplicate",
                        "candidate_id": "configured:duplicate",
                    }
                ],
            }

            with session_local() as session:
                session.add_all(
                    [
                        Strategy(
                            name="duplicate",
                            description="duplicate target",
                            enabled=True,
                            base_timeframe="1Min",
                            universe_type="static",
                            universe_symbols=["NVDA"],
                        ),
                        Strategy(
                            name="no-match",
                            description="no static universe overlap",
                            enabled=True,
                            base_timeframe="1Min",
                            universe_type="static",
                            universe_symbols=["MSFT"],
                        ),
                        Strategy(
                            name="",
                            description="empty strategy name",
                            enabled=True,
                            base_timeframe="1Min",
                            universe_type="static",
                            universe_symbols=["AMD"],
                        ),
                    ]
                )
                session.commit()

                result = with_configured_paper_collection_targets(
                    plan,
                    session=session,
                )
        finally:
            settings.trading_static_symbols_raw = static_symbols_before

        self.assertEqual(result, plan)

    def test_configured_collection_limits_static_universe_targets(self) -> None:
        static_symbols_before = settings.trading_static_symbols_raw
        try:
            settings.trading_simple_paper_route_probe_enabled = True
            settings.trading_simple_paper_route_probe_allow_live_mode = True
            settings.trading_simple_paper_route_probe_max_notional = 100
            settings.trading_static_symbols_raw = "NVDA,AMD"

            engine = create_engine(
                "sqlite+pysqlite:///:memory:",
                future=True,
                connect_args={"check_same_thread": False},
                poolclass=StaticPool,
            )
            Base.metadata.create_all(engine)
            session_local = sessionmaker(
                bind=engine,
                expire_on_commit=False,
                future=True,
            )

            with session_local() as session:
                session.add_all(
                    Strategy(
                        name=f"collector-{index}",
                        description="static fallback collector",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=None,
                    )
                    for index in range(9)
                )
                session.commit()

                result = with_configured_paper_collection_targets(
                    {
                        "source": "external_paper_route_target_plan",
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "external",
                                "candidate_id": "external",
                            }
                        ],
                    },
                    session=session,
                )
        finally:
            settings.trading_static_symbols_raw = static_symbols_before

        self.assertEqual(result["source"], "external_paper_route_target_plan")
        self.assertEqual(
            result["configured_collection_source"],
            "configured_simple_lane_paper_data_collection",
        )
        self.assertEqual(result["configured_bounded_collection_target_count"], 8)
        self.assertEqual(result["target_count"], 9)
        configured_targets = [
            target
            for target in result["targets"]
            if target.get("source_kind")
            == "configured_simple_lane_paper_data_collection"
        ]
        self.assertEqual(len(configured_targets), 8)
        self.assertTrue(
            configured_targets[0]["paper_route_probe_strategy_universe_fallback"]
        )
