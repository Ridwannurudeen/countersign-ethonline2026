from hashlib import sha256

from hiero_sdk_python import AccountId, PrivateKey, TransactionId, TransferTransaction


private_key = PrivateKey.from_bytes_ed25519(bytes(range(1, 33)))
transaction = (
    TransferTransaction()
    .add_hbar_transfer(AccountId.from_string("0.0.1001"), -123456)
    .add_hbar_transfer(AccountId.from_string("0.0.2002"), 123456)
    .set_transaction_id(
        TransactionId.from_string("0.0.7162784@1750000000.123456789")
    )
    .set_node_account_id(AccountId.from_string("0.0.3"))
    .freeze()
    .sign(private_key)
)
transaction_bytes = transaction.to_bytes()

print(f"pubkey_raw : {private_key.public_key().to_bytes_raw().hex()}")
print(f"bytes      : {len(transaction_bytes)}")
print(f"sha256     : {sha256(transaction_bytes).hexdigest()}")
print(f"hex_head   : {transaction_bytes[:24].hex()}")
print(f"hex_tail   : {transaction_bytes[-24:].hex()}")
