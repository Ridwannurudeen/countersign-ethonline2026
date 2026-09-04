from typing import TypedDict


class ExactHederaPayload(TypedDict):
    transaction: str


class DefaultAssetInfo(TypedDict):
    asset: str
    decimals: int
    symbol: str
