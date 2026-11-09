"""Source-pinned native integration. No installed CosmosAlpha files are edited."""

import csv
from dataclasses import asdict, replace
import json
from pathlib import Path
import random

import numpy as np

from cosmosalpha.core import (
    from_json,
    encode_columnar_columns,
    COLUMNAR_RECORDS_MEDIA_TYPE,
    to_json,
)
from cosmosalpha.core.config import load_experiment_config
from cosmosalpha.data import DataSnapshot
from cosmosalpha.evaluation import ForwardReturnResult
from cosmosalpha.evaluation.evaluator import GraphNodeEligibilityGate
from cosmosalpha.evaluation.preprocessing import (
    _read_table,
    _table_string_array,
    FORWARD_RETURN_SCHEMA_VERSION,
    ReturnCalculationError,
)
from cosmosalpha.llm.openai_compatible import OpenAICompatibleLLMClient
from cosmosalpha.factors import build_base_field_catalog, build_base_operator_catalog
from cosmosalpha.pipeline.mcts.controller import MCTSController
from cosmosalpha.pipeline.preflight import run_preflight
from cosmosalpha.pipeline.runtime import (
    RuntimeBuilder,
    RuntimeDependencies,
    _base_context,
    _market_data_request,
)
from cosmosalpha.storage import LocalArtifactRepository, write_run_reports

from cosmosalpha_experiment import (
    CheckedModelClient,
    EvaluableTargetReached,
    digest,
    write_json,
)


def admit_config(path, run_id):
    config = load_experiment_config(path)
    report = run_preflight(config, run_id=run_id, resume=False)
    if not report.ready:
        raise ValueError("Native preflight failed: " + to_json(report))
    return config


def admit_model_config(path):
    from cosmosalpha.modeling.config import load_lightgbm_integration_config

    config = load_lightgbm_integration_config(path)
    expected = [
        ("train", "2010-04-01", "2019-05-31"),
        ("valid", "2019-06-01", "2020-12-31"),
        ("test", "2021-01-01", "2025-12-31"),
    ]
    if any(
        (
            getattr(config.segments, name).start_date,
            getattr(config.segments, name).end_date,
        )
        != (first, last)
        for name, first, last in expected
    ):
        raise ValueError("Model segments differ from verified target cutoffs")
    return config


def columns(artifacts, ref, kind):
    table = _read_table(artifacts.get_bytes(ref), kind, ReturnCalculationError)
    return (
        table,
        _table_string_array(table, "datetime", ReturnCalculationError),
        _table_string_array(table, "instrument", ReturnCalculationError),
    )


def project_targets(artifacts, snapshot, rows, target_id):
    table, dates, symbols = columns(
        artifacts, snapshot.market_data.data_ref, "market_data"
    )
    masks, mask_dates, mask_symbols = columns(
        artifacts, snapshot.mask_data.mask_data_ref, "mask_data"
    )
    if not np.array_equal(dates, mask_dates) or not np.array_equal(
        symbols, mask_symbols
    ):
        raise ValueError("Native market and mask keys differ")

    def mask(field):
        if masks.column_types[field] != "bool":
            raise ValueError("Native mask is not a boolean column")
        return np.where(
            masks.validity[field], masks.columns[field].astype(float), np.nan
        )

    universe, eligible = mask("universe_mask"), mask("eligible_mask")
    values = np.full(table.row_count, np.nan)
    for i, (date, symbol) in enumerate(zip(dates, symbols, strict=True)):
        row = rows[(str(date), str(symbol))]
        for field, value in [("universe", universe[i]), ("eligible", eligible[i])]:
            actual = "" if not np.isfinite(value) else str(int(value))
            if row[field] != actual:
                raise ValueError("Native mask differs from verified target row")
        if row["forward_return"]:
            values[i] = float(row["forward_return"])
        if date < snapshot.request.start_date and np.isfinite(values[i]):
            raise ValueError("Warmup target was admitted")
        if row["target_date"] and row["target_date"] > snapshot.request.end_date:
            raise ValueError("Target crosses snapshot cutoff")
    ref = artifacts.put_bytes(
        encode_columnar_columns(
            {"datetime": dates, "instrument": symbols, "forward_return": values}
        ),
        kind="forward_returns",
        media_type=COLUMNAR_RECORDS_MEDIA_TYPE,
    )
    valid = int(np.isfinite(values).sum())
    result = ForwardReturnResult(
        return_definition="close_t1_over_close_t",
        holding_period=1,
        entry_time="close_t",
        exit_time="close_t1",
        factor_timestamp="close_t",
        data_snapshot_id=snapshot.snapshot_id,
        return_values_ref=ref,
        valid_sample_count=valid,
        missing_sample_count=len(values) - valid,
        calculation_version="bayn-calendar-targets/" + target_id,
        schema_version=FORWARD_RETURN_SCHEMA_VERSION,
    )
    return result


def prepare_inputs(root, config_path, target_directory, target_id):
    config = load_experiment_config(config_path)
    window = json.loads((Path(target_directory) / "manifest.json").read_text())[
        "identity"
    ]["window"]
    expected = {
        "fromDate": config.data.warmup_start_date,
        "splits": [
            {
                "name": "train",
                "startDate": config.data.start_date,
                "endDate": config.data.end_date,
            },
            {"name": "validation", "startDate": "2019-06-01", "endDate": "2020-12-31"},
            {"name": "test", "startDate": "2021-01-01", "endDate": "2025-12-31"},
        ],
    }
    if window != expected:
        raise ValueError("Target splits differ from the frozen research windows")
    builder = RuntimeBuilder(config, run_id="freeze-inputs")
    artifacts = LocalArtifactRepository(root / "inputs")
    provider = builder._create_data_provider(artifacts)
    rows = {}
    with (Path(target_directory) / "targets.csv").open(newline="") as stream:
        for row in csv.DictReader(stream):
            key = (row["date"], row["instrument"])
            if key in rows:
                raise ValueError("Duplicate target key")
            rows[key] = row
    request = _market_data_request(config)
    prepared = {}
    for name, selected in [
        ("mining", request),
        ("downstream", replace(request, end_date="2025-12-31")),
    ]:
        snapshot = provider.load_snapshot(selected)
        returns = project_targets(artifacts, snapshot, rows, target_id)
        if name == "downstream" and snapshot.market_data.sample_count != len(rows):
            raise ValueError("Full native snapshot does not cover all target rows")
        snapshot_path = root / (name + "-snapshot.json")
        return_path = root / (name + "-returns.json")
        snapshot_path.write_text(to_json(snapshot) + "\n")
        return_path.write_text(to_json(returns) + "\n")
        prepared[name] = {
            "snapshot": snapshot_path.name,
            "snapshotSha256": digest(snapshot_path),
            "returns": return_path.name,
            "returnsSha256": digest(return_path),
            "snapshotId": snapshot.snapshot_id,
            "targetId": target_id,
            "rowsMatched": snapshot.market_data.sample_count,
            "unexplainedMismatches": 0,
            "targetArtifactId": returns.return_values_ref.artifact_id,
        }
        write_json(
            root / (name + "-source.json"),
            {
                "schemaVersion": "bayn.cosmosalpha-downstream-source-validation.v1",
                "snapshotId": snapshot.snapshot_id,
                "request": asdict(snapshot.request),
                "sampleCount": snapshot.market_data.sample_count,
                "artifactRefs": [asdict(ref) for ref in snapshot.artifact_refs],
            },
        )
    return prepared


class FrozenInputs:
    def __init__(self, root, binding):
        self.root, self.binding = root, binding
        for key in ["snapshot", "returns"]:
            if digest(root / binding[key]) != binding[key + "Sha256"]:
                raise ValueError("Frozen input metadata drifted")
        self.snapshot = from_json(
            (root / binding["snapshot"]).read_text(), DataSnapshot
        )
        self.returns = from_json(
            (root / binding["returns"]).read_text(), ForwardReturnResult
        )
        self.source = LocalArtifactRepository(root / "inputs")

    def copy(self, artifacts):
        for ref in (*self.snapshot.artifact_refs, self.returns.return_values_ref):
            raw = self.source.get_bytes(ref)
            copied = artifacts.put_bytes(raw, kind=ref.kind, media_type=ref.media_type)
            if copied.artifact_id != ref.artifact_id:
                raise ValueError("Frozen native input artifact differs")
        return self.snapshot

    def provider(self, artifacts, config):
        frozen = self

        class Provider:
            def load_snapshot(self, request):
                if request != frozen.snapshot.request:
                    raise ValueError(
                        "Runtime request differs from frozen training window"
                    )
                return frozen.copy(artifacts)

        return Provider()

    def calculate(self, snapshot):
        if snapshot != self.snapshot:
            raise ValueError("Return consumer requested an unfrozen snapshot")
        return self.returns


class BudgetedEvaluator:
    def __init__(self, delegate, budget):
        self.delegate, self.budget = delegate, budget
        self.policy = GraphNodeEligibilityGate(min_effective_date_ratio=0.8)

    @property
    def last_timing(self):
        return self.delegate.last_timing

    def set_reference_factor_values_provider(self, provider):
        self.delegate.set_reference_factor_values_provider(provider)

    def evaluate(self, preprocessing, *args, **kwargs):
        key = preprocessing.factor_id
        self.budget.start_evaluation(key)
        result, eligible = None, False
        try:
            result = self.delegate.evaluate(preprocessing, *args, **kwargs)
            eligible = self.policy.evaluate(result).eligible
            return result
        finally:
            self.budget.finish_evaluation(key, result, eligible)


def bind_loop(loop, inputs, budget, slots, *, stop_at_target):
    loop._forward_return_calculator = inputs
    loop._evaluator = BudgetedEvaluator(loop._evaluator, budget)
    original = loop.run

    def run(**kwargs):
        if stop_at_target and budget.target_reached():
            budget.record(
                {
                    "event": "search-stop",
                    "reason": "evaluable-factor-target",
                    "boundary": "new-root",
                }
            )
            raise EvaluableTargetReached()
        budget.proposal(slots)
        return original(**kwargs)

    loop.run = run
    return loop


def write_pool(runtime, budget, output):
    objects = runtime._objects
    records = tuple(
        record
        for record in objects.list_experiments()
        if record.completed_at is not None
    )
    write_run_reports(runtime._layout, records, objects=objects)
    csv_path = runtime._layout.factor_library_csv_path
    with csv_path.open(newline="") as stream:
        reader = csv.DictReader(stream)
        header = reader.fieldnames
        selected = [
            row
            for row in reader
            if row["factor_id"] in budget.evaluable
            and row["status"] in {"accepted", "rejected"}
        ]
    observed = {row["factor_id"] for row in selected}
    if observed != set(budget.evaluable):
        raise ValueError("Evaluable budget differs from persisted usable factor pool")
    pool = output.parent.parent / "pools" / runtime._run_id
    pool.mkdir(parents=True)
    for name in ["artifacts", "objects", runtime._layout.factor_library_db_path.name]:
        (pool / name).symlink_to(
            runtime._layout.run_root / name,
            target_is_directory=name in {"artifacts", "objects"},
        )
    target = pool / "factor_library" / "factors.csv"
    target.parent.mkdir()
    with target.open("x", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=header)
        writer.writeheader()
        writer.writerows(selected)
    write_json(
        output / "pool.json",
        {
            "factorIds": sorted(observed),
            "evaluableFactors": len(observed),
            "csvSha256": digest(target),
        },
    )


def run_arm(root, plan, run, budget, transport, output):
    random.seed(run["seed"])
    np.random.seed(run["seed"])
    config = admit_config(root / run["config"], run["runId"])
    frozen = FrozenInputs(root, plan["inputs"]["mining"])
    client = CheckedModelClient(
        OpenAICompatibleLLMClient.from_config(config.llm, transport=transport), budget
    )
    runtime = RuntimeBuilder(
        config,
        run_id=run["runId"],
        dependencies=RuntimeDependencies(
            llm_client=client, market_data_provider_factory=frozen.provider
        ),
    ).build(resume=False)
    if run["arm"] == "mcts":
        loop = bind_loop(
            runtime._loop,
            frozen,
            budget,
            config.factor_generation.max_proposals,
            stop_at_target=True,
        )
        snapshot = frozen.copy(runtime._artifacts)
        runtime._objects.put_object("data_snapshot", snapshot.snapshot_id, snapshot)
        controller = MCTSController(
            loop=loop,
            experiment_repository=runtime._objects,
            artifact_repository=runtime._artifacts,
            llm_client=client,
            field_catalog=build_base_field_catalog(),
            operator_catalog=build_base_operator_catalog(),
            exploration_weight=config.mcts.exploration_weight,
            alpha_threshold=config.evaluation.acceptance_threshold,
            model_alias=config.llm.model_alias,
            correlation_min_cross_section_samples=config.evaluation.min_cross_section_samples,
            correlation_min_daily_effective_stock_ratio=config.evaluation.min_daily_effective_stock_ratio,
            correlation_min_pair_window_ratio=config.evaluation.min_effective_date_ratio,
        )
        try:
            result = controller.run_multi_tree(
                data_snapshot=snapshot,
                base_context=_base_context(config, snapshot),
                config_snapshot_ref=runtime._config_snapshot_ref,
                code_version=__import__("cosmosalpha").__version__,
                max_total_rounds=config.mcts.max_iterations,
                initial_budget=config.mcts.initial_budget,
                budget_increment=config.mcts.budget_increment,
                breakthrough_relax=config.mcts.breakthrough_relax,
                run_id=run["runId"],
            )
            termination = {"iterations": result.iterations}
        except EvaluableTargetReached:
            termination = {"terminationReason": "evaluable-factor-target"}
        write_json(
            output / "native-result.json",
            {
                "entrypoint": "MCTSController.run_multi_tree",
                **termination,
                "trees": len(runtime._objects.list_object_ids("mcts_tree")),
            },
        )
    else:
        for field, slots in [
            ("_graph_loop_factory", config.factor_generation.max_proposals),
            ("_graph_initial_loop_factory", 1),
        ]:
            factory = getattr(runtime, field)

            def wrapped(factory=factory, slots=slots):
                return bind_loop(factory(), frozen, budget, slots, stop_at_target=False)

            setattr(runtime, field, wrapped)
        result = runtime.run(resume=False)
        (output / "native-result.json").write_text(to_json(result) + "\n")
    write_pool(runtime, budget, output)
    write_json(
        output / "target-consumption.json",
        {"targetId": plan["targetId"], **plan["inputs"]["mining"]},
    )


def downstream(root, plan, run):
    random.seed(run["seed"])
    np.random.seed(run["seed"])
    from cosmosalpha.modeling import lightgbm
    from cosmosalpha.modeling.config import load_lightgbm_integration_config

    config = load_lightgbm_integration_config(root / run["downstreamConfig"])
    frozen = FrozenInputs(root, plan["inputs"]["downstream"])
    original_returns = lightgbm.ForwardReturnCalculator
    original_snapshot = lightgbm._load_model_snapshot
    original_compatibility = lightgbm._validate_source_compatibility
    # This process owns model fitting; bind both consumers before native training.
    lightgbm.ForwardReturnCalculator = lambda artifacts: frozen
    lightgbm._load_model_snapshot = lambda config, specs, artifacts: frozen.copy(
        artifacts
    )
    lightgbm._validate_source_compatibility = validate_model_source
    try:
        result = lightgbm.run_lightgbm_integration(config, run["runId"] + "-model")
    finally:
        lightgbm.ForwardReturnCalculator = original_returns
        lightgbm._load_model_snapshot = original_snapshot
        lightgbm._validate_source_compatibility = original_compatibility
    write_json(
        root / "models" / (run["runId"] + "-model") / "target-consumption.json",
        plan["inputs"]["downstream"],
    )
    return json.loads(to_json(result))


def validate_model_source(config, source_snapshot):
    source = source_snapshot.config
    if source.architecture.name not in {"graph", "mcts"}:
        raise ValueError("Unsupported factor-pool architecture")
    if (source.data.start_date, source.data.end_date) != (
        config.segments.train.start_date,
        config.segments.train.end_date,
    ):
        raise ValueError("Factor search must use the training segment only")
    fields = (
        "provider",
        "market",
        "frequency",
        "dataset_version",
        "price_adjustment",
        "trading_calendar_version",
        "warmup_start_date",
    )
    if (
        any(getattr(source.data, name) != getattr(config.data, name) for name in fields)
        or source.universe != config.universe
    ):
        raise ValueError("Source/model research domains differ")
    for name in ("market", "exposure", "mask"):
        if getattr(source.qlib, name) != getattr(config.qlib, name):
            raise ValueError("Source/model provider identities differ")
    if (
        source.qlib.region != config.qlib.region
        or source.qlib.instruments != config.qlib.instruments
    ):
        raise ValueError("Source/model universes differ")
