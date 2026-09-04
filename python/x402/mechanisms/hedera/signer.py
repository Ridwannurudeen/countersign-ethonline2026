from base64 import b64encode
from dataclasses import dataclass
from typing import Protocol

from hiero_sdk_python import (
    AccountId,
    PrivateKey,
    TokenId,
    TransactionId,
    TransferTransaction,
)
from x402.schemas import PaymentRequirements

from .constants import DEFAULT_NODE_ACCOUNT_ID, HBAR_ASSET_ID
from .utils import (
    assert_supported_hedera_network,
    require_entity_id,
    require_positive_amount,
)


class ClientHederaSigner(Protocol):
    account_id: str

    def create_partially_signed_transfer_transaction(
        self,
        requirements: PaymentRequirements,
    ) -> str: ...


@dataclass(frozen=True)
class PrivateKeyHederaSigner:
    account_id: str
    private_key: PrivateKey

    def __post_init__(self) -> None:
        require_entity_id(self.account_id, "account_id")

    def create_partially_signed_transfer_transaction(
        self,
        requirements: PaymentRequirements,
    ) -> str:
        assert_supported_hedera_network(requirements.network)
        amount = require_positive_amount(requirements.amount)
        pay_to = AccountId.from_string(
            require_entity_id(requirements.pay_to, "payTo")
        )
        extra = requirements.extra
        if not isinstance(extra, dict) or not isinstance(extra.get("feePayer"), str):
            raise ValueError(
                "feePayer is required in paymentRequirements.extra for Hedera exact"
            )
        fee_payer = AccountId.from_string(
            require_entity_id(extra["feePayer"], "feePayer")
        )
        sender = AccountId.from_string(self.account_id)
        transaction = TransferTransaction()
        if requirements.asset == HBAR_ASSET_ID:
            transaction.add_hbar_transfer(sender, -amount)
            transaction.add_hbar_transfer(pay_to, amount)
        else:
            token_id = TokenId.from_string(
                require_entity_id(requirements.asset, "asset")
            )
            transaction.add_token_transfer(token_id, sender, -amount)
            transaction.add_token_transfer(token_id, pay_to, amount)

        signed = (
            transaction.set_transaction_id(TransactionId.generate(fee_payer))
            .set_node_account_id(AccountId.from_string(DEFAULT_NODE_ACCOUNT_ID))
            .freeze()
            .sign(self.private_key)
        )
        return b64encode(signed.to_bytes()).decode("ascii")


def create_client_hedera_signer(
    account_id: str,
    private_key: PrivateKey,
) -> ClientHederaSigner:
    return PrivateKeyHederaSigner(account_id, private_key)
