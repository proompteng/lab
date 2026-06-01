"""Runtime strategy-name resolution from family strategy identifiers."""

from __future__ import annotations

from functools import lru_cache

from .discovery.family_templates import load_family_template


def _safe_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def family_template_id_from_strategy_id(strategy_id: object) -> str | None:
    text = _safe_text(strategy_id)
    if text is None:
        return None
    base = text.split("@", 1)[0].strip()
    return base or None


def derived_strategy_name_from_strategy_id(strategy_id: object) -> str | None:
    family_template_id = family_template_id_from_strategy_id(strategy_id)
    if family_template_id is None:
        return None
    return family_template_id.replace("_", "-")


@lru_cache(maxsize=256)
def _runtime_harness_strategy_name(family_template_id: str) -> str | None:
    try:
        template = load_family_template(family_template_id)
    except (FileNotFoundError, OSError, ValueError):
        return None
    return _safe_text(template.runtime_harness.get("strategy_name"))


def runtime_strategy_name_from_strategy_id(strategy_id: object) -> str | None:
    family_template_id = family_template_id_from_strategy_id(strategy_id)
    if family_template_id is None:
        return None
    return _runtime_harness_strategy_name(
        family_template_id
    ) or derived_strategy_name_from_strategy_id(strategy_id)


def strategy_names_from_strategy_id(strategy_id: object) -> tuple[str, ...]:
    names: list[str] = []
    for name in (
        runtime_strategy_name_from_strategy_id(strategy_id),
        derived_strategy_name_from_strategy_id(strategy_id),
    ):
        if name is not None and name not in names:
            names.append(name)
    return tuple(names)


def explicit_runtime_strategy_name_or_family_harness(
    *,
    runtime_strategy_name: object,
    strategy_name: object = None,
    strategy_id: object,
) -> str | None:
    explicit_runtime_name = _safe_text(runtime_strategy_name)
    explicit_strategy_name = _safe_text(strategy_name)
    family_runtime_name = runtime_strategy_name_from_strategy_id(strategy_id)
    derived_name = derived_strategy_name_from_strategy_id(strategy_id)
    has_family_harness = (
        family_runtime_name is not None
        and derived_name is not None
        and family_runtime_name != derived_name
    )

    for explicit_name in (explicit_runtime_name, explicit_strategy_name):
        if explicit_name is None:
            continue
        if has_family_harness and explicit_name == derived_name:
            continue
        return explicit_name
    return family_runtime_name
