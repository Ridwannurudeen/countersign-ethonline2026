import json
import subprocess
from pathlib import Path

import pytest
from hiero_sdk_python import PrivateKey
from x402.client import x402Client
from x402.schemas import PaymentRequirements

from python.x402.mechanisms.hedera.constants import (
    HBAR_ASSET_ID,
    HEDERA_TESTNET_CAIP2,
)
from python.x402.mechanisms.hedera.exact.client import ExactHederaScheme
from python.x402.mechanisms.hedera.exact.register import (
    register_exact_hedera_client,
)
from python.x402.mechanisms.hedera.signer import create_client_hedera_signer


REPO_ROOT = Path(__file__).resolve().parents[2]
INSPECT_SCRIPT = Path(__file__).with_name("inspect-transaction.mjs")
FIXTURE_PATH = Path(__file__).parent / "fixtures" / "hbar-payment.json"
SENDER_ACCOUNT_ID = "0.0.1001"
RECIPIENT_ACCOUNT_ID = "0.0.1002"
FEE_PAYER_ACCOUNT_ID = "0.0.7162784"
TOKEN_ID = "0.0.429274"
PRIVATE_KEY = PrivateKey.from_bytes_ed25519(bytes(range(1, 33)))


def requirements(asset: str = HBAR_ASSET_ID) -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network=HEDERA_TESTNET_CAIP2,
        asset=asset,
        amount="123456",
        payTo=RECIPIENT_ACCOUNT_ID,
        maxTimeoutSeconds=60,
        extra={"feePayer": FEE_PAYER_ACCOUNT_ID},
    )


def inspect_with_typescript(transaction: str) -> dict[str, object]:
    result = subprocess.run(
        ["node", str(INSPECT_SCRIPT)],
        cwd=REPO_ROOT,
        input=json.dumps({"transaction": transaction}),
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def test_exact_client_builds_an_interoperable_hbar_payload() -> None:
    signer = create_client_hedera_signer(SENDER_ACCOUNT_ID, PRIVATE_KEY)
    payload = ExactHederaScheme(signer).create_payment_payload(requirements())

    assert set(payload) == {"transaction"}
    inspected = inspect_with_typescript(payload["transaction"])
    assert inspected["transactionIdAccountId"] == FEE_PAYER_ACCOUNT_ID
    assert inspected["hbarTransfers"] == [
        {"accountId": SENDER_ACCOUNT_ID, "amount": "-123456"},
        {"accountId": RECIPIENT_ACCOUNT_ID, "amount": "123456"},
    ]
    assert inspected["tokenTransfers"] == {}
    assert inspected["signerKeys"] == [PRIVATE_KEY.public_key().to_string_raw()]


def test_exact_client_builds_an_interoperable_hts_payload() -> None:
    signer = create_client_hedera_signer(SENDER_ACCOUNT_ID, PRIVATE_KEY)
    payload = ExactHederaScheme(signer).create_payment_payload(requirements(TOKEN_ID))

    inspected = inspect_with_typescript(payload["transaction"])
    assert inspected["transactionIdAccountId"] == FEE_PAYER_ACCOUNT_ID
    assert inspected["hbarTransfers"] == []
    assert inspected["tokenTransfers"] == {
        TOKEN_ID: [
            {"accountId": SENDER_ACCOUNT_ID, "amount": "-123456"},
            {"accountId": RECIPIENT_ACCOUNT_ID, "amount": "123456"},
        ]
    }


def test_checked_in_fixture_decodes_with_typescript() -> None:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    inspected = inspect_with_typescript(fixture["payload"]["transaction"])

    assert inspected == fixture["expectedDecode"]


def test_exact_client_requires_the_exact_scheme() -> None:
    signer = create_client_hedera_signer(SENDER_ACCOUNT_ID, PRIVATE_KEY)
    invalid = requirements().model_copy(update={"scheme": "upto"})

    with pytest.raises(ValueError, match="Unsupported scheme for Hedera exact client"):
        ExactHederaScheme(signer).create_payment_payload(invalid)


def test_exact_client_requires_a_supported_network() -> None:
    signer = create_client_hedera_signer(SENDER_ACCOUNT_ID, PRIVATE_KEY)
    invalid = requirements().model_copy(update={"network": "hedera:previewnet"})

    with pytest.raises(ValueError, match="Unsupported Hedera network"):
        ExactHederaScheme(signer).create_payment_payload(invalid)


def test_exact_client_requires_a_fee_payer() -> None:
    signer = create_client_hedera_signer(SENDER_ACCOUNT_ID, PRIVATE_KEY)
    invalid = requirements().model_copy(update={"extra": {}})

    with pytest.raises(ValueError, match="feePayer is required"):
        ExactHederaScheme(signer).create_payment_payload(invalid)


@pytest.mark.parametrize("amount", ["0", "-1", "01", "1.0"])
def test_signer_requires_a_positive_minimal_integer_amount(amount: str) -> None:
    signer = create_client_hedera_signer(SENDER_ACCOUNT_ID, PRIVATE_KEY)
    invalid = requirements().model_copy(update={"amount": amount})

    with pytest.raises(ValueError, match="positive minimal unsigned decimal"):
        ExactHederaScheme(signer).create_payment_payload(invalid)


def test_registration_adds_the_hedera_exact_client() -> None:
    signer = create_client_hedera_signer(SENDER_ACCOUNT_ID, PRIVATE_KEY)
    client = x402Client()

    registered = register_exact_hedera_client(
        client,
        signer,
        networks=HEDERA_TESTNET_CAIP2,
    )

    assert registered is client
    assert {
        "scheme": "exact",
        "network": HEDERA_TESTNET_CAIP2,
    } in client.get_registered_schemes()[2]
