from x402.schemas import PaymentRequirements

from ..signer import ClientHederaSigner
from ..types import ExactHederaPayload
from ..utils import assert_supported_hedera_network


class ExactHederaScheme:
    scheme = "exact"

    def __init__(self, signer: ClientHederaSigner):
        self.signer = signer

    def create_payment_payload(
        self,
        requirements: PaymentRequirements,
        extensions: dict[str, object] | None = None,
    ) -> ExactHederaPayload:
        del extensions
        if requirements.scheme != self.scheme:
            raise ValueError("Unsupported scheme for Hedera exact client")
        assert_supported_hedera_network(requirements.network)
        if not isinstance(requirements.extra, dict) or not isinstance(
            requirements.extra.get("feePayer"), str
        ):
            raise ValueError(
                "feePayer is required in paymentRequirements.extra for Hedera exact"
            )
        return {
            "transaction": self.signer.create_partially_signed_transfer_transaction(
                requirements
            )
        }
