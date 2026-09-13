"""Strict, lossless public telemetry contracts."""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping

SNAPSHOT_FIELDS = frozenset({
    "schema_version", "event_id", "producer", "producer_instance_id", "occurred_at",
    "received_at", "agent_id", "run_id", "task_id", "task_type", "scope", "provenance",
    "idempotency_key", "source", "authoritative", "completeness", "captured_at",
    "values", "quality_flags",
})
VALUE_FIELDS = frozenset({"raw_value", "value_type", "unit", "category"})


def _string(data: Mapping[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} must be a non-empty string")
    return value


def _timestamp(value: Any, key: str) -> None:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} must be an ISO-8601 string")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{key} must be an ISO-8601 string") from exc


@dataclass(frozen=True)
class MetricValue:
    raw_value: Any
    value_type: str
    unit: str
    category: str

    @classmethod
    def from_dict(cls, value: Any) -> "MetricValue":
        if not isinstance(value, dict) or set(value) != VALUE_FIELDS:
            raise ValueError("metric values must contain exactly the v1 fields")
        if not all(isinstance(value[k], str) and value[k] for k in ("value_type", "unit", "category")):
            raise ValueError("metric value descriptors must be non-empty strings")
        return cls(value["raw_value"], value["value_type"], value["unit"], value["category"])

    def to_dict(self) -> dict[str, Any]:
        return {"raw_value": deepcopy(self.raw_value), "value_type": self.value_type,
                "unit": self.unit, "category": self.category}


@dataclass(frozen=True)
class MetricSnapshot:
    payload: dict[str, Any]
    record_id: Any = None

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> "MetricSnapshot":
        if not isinstance(payload, dict) or set(payload) != SNAPSHOT_FIELDS:
            raise ValueError("telemetry.v1 snapshot has unknown or missing fields")
        if payload["schema_version"] != "telemetry.v1":
            raise ValueError("unsupported telemetry schema version")
        for key in ("event_id", "producer", "producer_instance_id", "agent_id", "run_id", "task_id",
                    "task_type", "scope", "provenance", "idempotency_key", "source", "completeness"):
            _string(payload, key)
        for key in ("occurred_at", "received_at", "captured_at"):
            _timestamp(payload[key], key)
        if type(payload["authoritative"]) is not bool:
            raise TypeError("authoritative must be bool")
        if not isinstance(payload["values"], dict):
            raise TypeError("values must be an object")
        for value in payload["values"].values():
            MetricValue.from_dict(value)
        if not isinstance(payload["quality_flags"], list) or not all(isinstance(x, str) for x in payload["quality_flags"]):
            raise TypeError("quality_flags must be a list of strings")
        return cls(deepcopy(payload))

    def to_dict(self) -> dict[str, Any]:
        return deepcopy(self.payload)

    def __getattr__(self, name: str) -> Any:
        try:
            return self.payload[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    @property
    def values(self) -> dict[str, MetricValue]:
        return {key: MetricValue.from_dict(value) for key, value in self.payload["values"].items()}
