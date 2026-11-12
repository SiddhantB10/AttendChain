#!/usr/bin/env python3
"""
AttendChain Hedera Testnet Connectivity & Status Diagnostic Tool
"""

import os
import sys
import json
from pathlib import Path

try:
    from dotenv import load_dotenv
    from web3 import Web3
except ImportError:
    print("[ERROR] Required packages not found. Please install requirements: pip install -r requirements.txt")
    sys.exit(1)

# Load environment
env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    load_dotenv(dotenv_path=env_path)
else:
    # Fallback to .env.example
    example_path = Path(__file__).resolve().parent.parent / ".env.example"
    if example_path.exists():
        load_dotenv(dotenv_path=example_path)

def main():
    print("==================================================")
    print("   AttendChain Hedera Testnet Diagnostic Tool    ")
    print("==================================================")

    rpc_url = os.getenv("HEDERA_RPC_URL", "https://testnet.hashio.io/api")
    private_key = os.getenv("FACULTY_PRIVATE_KEY")
    contract_address = os.getenv("CONTRACT_ADDRESS")

    print(f"Connecting to Hedera RPC Relay: {rpc_url}")
    w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 15}))

    if not w3.is_connected():
        print(f"[FAIL] Could not connect to RPC Relay at {rpc_url}")
        sys.exit(1)

    try:
        chain_id = w3.eth.chain_id
        print(f"[PASS] Connected successfully! Remote Chain ID: {chain_id}")
        if chain_id == 296:
            print("       [PASS] Verified Hedera Testnet (Chain ID 296)")
        else:
            print(f"       [WARN] Unexpected Chain ID (expected 296 for Hedera Testnet, got {chain_id})")
    except Exception as e:
        print(f"[FAIL] Error fetching chain ID: {e}")
        sys.exit(1)

    # Check Wallet
    if not private_key or private_key.startswith("0x0000000000000000000000000000000000000000000000000000000000000001"):
        print("[INFO] No custom FACULTY_PRIVATE_KEY configured in .env.")
        print("       To deploy to Hedera Testnet, register on portal.hedera.com and paste your EVM private key.")
    else:
        try:
            account = w3.eth.account.from_key(private_key)
            print(f"[PASS] Faculty Wallet EVM Address: {account.address}")
            balance_wei = w3.eth.get_balance(account.address)
            balance_hbar = w3.from_wei(balance_wei, "ether")
            print(f"       Balance: {balance_hbar} HBAR")
            if balance_wei == 0:
                print("       [WARN] Wallet balance is 0 HBAR. Request funds at https://portal.hedera.com")
            else:
                print("       [PASS] Wallet has sufficient funds for transactions.")
        except Exception as e:
            print(f"[FAIL] Invalid private key: {e}")

    # Check Contract
    target_addr = contract_address
    deployments_file = Path(__file__).resolve().parent.parent / "deployments" / "hedera_testnet.json"
    if not target_addr and deployments_file.exists():
        try:
            with open(deployments_file, "r") as f:
                data = json.load(f)
                target_addr = data.get("address")
                print(f"[INFO] Detected contract address from deployments/hedera_testnet.json: {target_addr}")
        except Exception:
            pass

    if target_addr:
        try:
            checksum_addr = Web3.to_checksum_address(target_addr)
            code = w3.eth.get_code(checksum_addr)
            if code and len(code) > 0 and code != b"\x00" and code != b"":
                print(f"[PASS] Contract is deployed at: {checksum_addr}")
                print(f"       Bytecode size: {len(code)} bytes")
                print(f"       HashScan: https://hashscan.io/testnet/contract/{checksum_addr}")
            else:
                print(f"[FAIL] No bytecode found at {checksum_addr}. Contract is not deployed.")
        except Exception as e:
            print(f"[FAIL] Error checking contract at {target_addr}: {e}")
    else:
        print("[INFO] No contract address configured yet.")

    print("==================================================")

if __name__ == "__main__":
    main()

