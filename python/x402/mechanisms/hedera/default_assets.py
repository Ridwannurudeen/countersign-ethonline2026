from .constants import HEDERA_MAINNET_CAIP2, HEDERA_TESTNET_CAIP2
from .types import DefaultAssetInfo


DEFAULT_ASSETS: dict[str, tuple[DefaultAssetInfo, ...]] = {
    HEDERA_MAINNET_CAIP2: (
        {"asset": "0.0.456858", "decimals": 6, "symbol": "USDC"},
    ),
    HEDERA_TESTNET_CAIP2: (
        {"asset": "0.0.429274", "decimals": 6, "symbol": "USDC"},
    ),
}


def find_default_asset(network: str, symbol: str) -> DefaultAssetInfo | None:
    return next(
        (
            asset
            for asset in DEFAULT_ASSETS.get(network, ())
            if asset["symbol"] == symbol
        ),
        None,
    )
