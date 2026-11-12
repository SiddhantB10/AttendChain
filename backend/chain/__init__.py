import os
from .base import ChainAdapter
from .mock_chain import MockChainAdapter

def get_chain_adapter() -> ChainAdapter:
    mode = os.getenv("CHAIN_MODE", "mock").lower()

    if mode == "mock":
        return MockChainAdapter()

    elif mode in ("local", "hedera"):
        rpc_url = os.getenv("HEDERA_RPC_URL", "https://testnet.hashio.io/api") if mode == "hedera" else os.getenv("LOCAL_RPC_URL", "http://127.0.0.1:8545")
        chain_id = int(os.getenv("HEDERA_CHAIN_ID", 296)) if mode == "hedera" else int(os.getenv("LOCAL_CHAIN_ID", 31337))
        private_key = os.getenv("FACULTY_PRIVATE_KEY", "0x0000000000000000000000000000000000000000000000000000000000000001")
        contract_addr = os.getenv("CONTRACT_ADDRESS")

        # Try Web3ChainAdapter first; if Windows C-extension DLL policy blocks web3/ckzg, use HederaNodeBridgeAdapter
        try:
            from .web3_chain import Web3ChainAdapter
            return Web3ChainAdapter(
                mode=mode,
                rpc_url=rpc_url,
                chain_id=chain_id,
                private_key=private_key,
                contract_address=contract_addr
            )
        except Exception:
            from .hedera_bridge import HederaNodeBridgeAdapter
            return HederaNodeBridgeAdapter(
                mode=mode,
                rpc_url=rpc_url,
                chain_id=chain_id,
                private_key=private_key,
                contract_address=contract_addr
            )

    else:
        raise ValueError(f"Unknown CHAIN_MODE: {mode}. Must be 'mock', 'local', or 'hedera'.")
