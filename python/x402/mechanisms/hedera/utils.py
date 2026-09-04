import re

from .constants import SUPPORTED_HEDERA_NETWORKS


ENTITY_ID_PATTERN = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
MINIMAL_UNSIGNED_DECIMAL_PATTERN = re.compile(r"^(0|[1-9][0-9]*)$")


def assert_supported_hedera_network(network: str) -> None:
    if network not in SUPPORTED_HEDERA_NETWORKS:
        raise ValueError(f"Unsupported Hedera network: {network}")


def require_entity_id(value: object, field: str) -> str:
    if not isinstance(value, str) or ENTITY_ID_PATTERN.fullmatch(value) is None:
        raise ValueError(f"{field} must be a canonical numeric Hedera entity ID")
    return value


def require_positive_amount(value: object) -> int:
    if (
        not isinstance(value, str)
        or MINIMAL_UNSIGNED_DECIMAL_PATTERN.fullmatch(value) is None
        or value == "0"
    ):
        raise ValueError("amount must be a positive minimal unsigned decimal string")
    return int(value)
