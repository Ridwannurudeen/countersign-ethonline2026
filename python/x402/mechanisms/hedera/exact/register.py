from collections.abc import Iterable
from typing import Protocol, Self

from ..constants import SUPPORTED_HEDERA_NETWORKS
from ..signer import ClientHederaSigner
from .client import ExactHederaScheme


class ClientRegistration(Protocol):
    def register(
        self,
        network: str,
        client: ExactHederaScheme,
    ) -> Self: ...


def register_exact_hedera_client(
    client: ClientRegistration,
    signer: ClientHederaSigner,
    networks: str | Iterable[str] | None = None,
) -> ClientRegistration:
    selected_networks = (
        SUPPORTED_HEDERA_NETWORKS
        if networks is None
        else (networks,)
        if isinstance(networks, str)
        else networks
    )
    for network in selected_networks:
        client.register(network, ExactHederaScheme(signer))
    return client
