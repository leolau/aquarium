"""The schema-change check's diff (plan 2026-11-14-001, Phase 6).

``schema_diff`` is pure: given the live schema as ``{table: {columns}}`` and
the approved dictionary's ``tables`` map it lists each difference. The
scheduled sweep and the apply_design hook call ``check_source`` to store it.
"""

from __future__ import annotations

import hermes_cli.data_dictionary as dd


def test_schema_diff_flags_each_kind_of_drift():
    truth = {
        "orders": {"order_no", "amount", "coupon"},
        "customers": {"id"},
        "new_table": {"id", "name"},
    }
    tables = {
        "orders": {"columns": {"order_no": "", "amount": "", "legacy": ""}},
        "customers": {"columns": {"id": ""}},
        "stale_table": {"columns": {"id": ""}},
    }
    drift = {d["table"]: d for d in dd.schema_diff(truth, tables)}
    assert drift["orders"]["change"] == "columns"
    assert drift["orders"]["detail"] == {"added": ["coupon"], "removed": ["legacy"]}
    assert drift["new_table"]["change"] == "added"
    assert drift["new_table"]["detail"]["columns"] == ["id", "name"]
    assert drift["stale_table"]["change"] == "removed"
    assert "customers" not in drift


def test_schema_diff_is_empty_when_the_dictionary_matches():
    truth = {"orders": {"id", "amount"}}
    tables = {"orders": {"columns": {"id": "", "amount": "Total in HKD"}}}
    assert dd.schema_diff(truth, tables) == []
    assert dd.schema_diff({}, tables) == [
        {"table": "orders", "change": "removed"}
    ]
    assert dd.schema_diff(truth, {}) == [
        {"table": "orders", "change": "added", "detail": {"columns": ["amount", "id"]}}
    ]
