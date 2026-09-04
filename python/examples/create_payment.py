import json
import os

from hiero_sdk_python import PrivateKey
from x402.schemas import PaymentRequirements

from python.x402.mechanisms.hedera.constants import (
    HBAR_ASSET_ID,
    HEDERA_TESTNET_CAIP2,
)
from python.x402.mechanisms.hedera.exact.client import ExactHederaScheme
from python.x402.mechanisms.hedera.signer import create_client_hedera_signer


def main() -> None:
    account_id = os.environ["HEDERA_ACCOUNT_ID"]
    signer = create_client_hedera_signer(
        account_id,
        PrivateKey.from_string(os.environ["HEDERA_PRIVATE_KEY"]),
    )
    requirements = PaymentRequirements(
        scheme="exact",
        network=HEDERA_TESTNET_CAIP2,
        asset=HBAR_ASSET_ID,
        amount="1000000",
        payTo=os.environ["HEDERA_PAY_TO"],
        maxTimeoutSeconds=60,
        extra={"feePayer": os.environ["HEDERA_FEE_PAYER"]},
    )
    payload = ExactHederaScheme(signer).create_payment_payload(requirements)
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
