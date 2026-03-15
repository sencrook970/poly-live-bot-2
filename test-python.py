"""
Quick test: place a tiny order using the Python CLOB client.
This will tell us if the issue is the TS SDK or the account itself.

Run: pip install py-clob-client && python test-python.py
"""
import os
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import OrderArgs, OrderType
from py_clob_client.order_builder.constants import BUY

# Your credentials (same as .env)
PRIVATE_KEY = "0xc6aa75152847995291b36669768b3797e852e359049781bc436ab1def897d1dc"
FUNDER = "0xC82B17C50e91f0D4872528c2B3dC7562dA85A3A9"

host = "https://clob.polymarket.com"
chain_id = 137

print("=== Python SDK Test ===\n")

# Try signature type 1 (email/Magic) first
for sig_type in [1, 0, 2]:
    print(f"\n--- Testing signatureType: {sig_type} ---")
    try:
        client = ClobClient(
            host,
            key=PRIVATE_KEY,
            chain_id=chain_id,
            signature_type=sig_type,
            funder=FUNDER,
        )

        # Derive API creds
        print("Deriving API keys...")
        creds = client.create_or_derive_api_creds()
        print(f"API Key: {creds.api_key}")
        client.set_api_creds(creds)

        # Check if we can get the server time (basic health check)
        print("Server time:", client.get_server_time())

        # Try to get balance
        print("Checking balance...")
        try:
            balance = client.get_balance_allowance(asset_type=0)  # COLLATERAL
            print(f"Balance: {balance}")
        except Exception as e:
            print(f"Balance check failed: {e}")

        # Try to place a tiny order
        # "US forces enter Iran by March 31?" NO token
        token_id = "81697486240392901899167649997008736380137911909662773455994395620863894931973"

        print(f"Placing test order (BUY 1 share @ $0.01)...")
        order_args = OrderArgs(
            price=0.01,
            size=1,
            side=BUY,
            token_id=token_id,
        )
        signed_order = client.create_order(order_args)
        result = client.post_order(signed_order, OrderType.GTC)
        print(f"Result: {result}")

        if result and "error" not in str(result).lower():
            print(f"\n*** SUCCESS with signatureType {sig_type}! ***")
            break
        else:
            print(f"Failed with type {sig_type}")

    except Exception as e:
        print(f"Error with type {sig_type}: {e}")

print("\nDone.")
