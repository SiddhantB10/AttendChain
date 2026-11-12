"""
Web3.py Blockchain Adapter for AttendChain.
Supports 'local' (Hardhat EVM node) and 'hedera' (Hedera Testnet JSON-RPC Relay).
Includes nonce locking, explicit gas limits, exponential backoff retries, and pre-flight read checks.
"""

import os
import json
import time
import threading
from pathlib import Path
from typing import Dict, Any, Tuple, Optional

from web3 import Web3
from web3.exceptions import TransactionNotFound, TimeExhausted
from eth_account import Account
from .base import ChainAdapter

class Web3ChainAdapter(ChainAdapter):
    def __init__(
        self,
        mode: str, # 'local' or 'hedera'
        rpc_url: str,
        chain_id: int,
        private_key: str,
        contract_address: Optional[str] = None,
        abi: Optional[list] = None
    ):
        self._mode = mode
        self._rpc_url = rpc_url
        self._chain_id = chain_id
        self._private_key = private_key
        self._nonce_lock = threading.Lock()

        self.w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 30}))
        self.account = Account.from_key(private_key) if private_key and not private_key.startswith("0x0000000000000000000000000000000000000000000000000000000000000001") else None

        # Load ABI and Contract Address
        self._contract_address = None
        self._abi = abi or self._load_abi()

        if contract_address:
            self._contract_address = Web3.to_checksum_address(contract_address)
        else:
            self._contract_address = self._load_deployment_address()

        self.contract = None
        if self._contract_address and self._abi:
            self.contract = self.w3.eth.contract(address=self._contract_address, abi=self._abi)

    @property
    def mode(self) -> str:
        return self._mode

    @property
    def contract_address(self) -> str:
        return self._contract_address or ""

    def _load_abi(self) -> list:
        # Check artifacts first
        base_dir = Path(__file__).resolve().parent.parent.parent
        artifact_path = base_dir / "artifacts" / "contracts" / "AttendanceRegistry.sol" / "AttendanceRegistry.json"
        if artifact_path.exists():
            with open(artifact_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data.get("abi", [])

        # Check deployments
        network_name = "hedera_testnet" if self._mode == "hedera" else "localhost"
        dep_path = base_dir / "deployments" / f"{network_name}.json"
        if dep_path.exists():
            with open(dep_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data.get("abi", [])
        return []

    def _load_deployment_address(self) -> Optional[str]:
        base_dir = Path(__file__).resolve().parent.parent.parent
        network_name = "hedera_testnet" if self._mode == "hedera" else "localhost"
        dep_path = base_dir / "deployments" / f"{network_name}.json"
        if dep_path.exists():
            try:
                with open(dep_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    addr = data.get("address")
                    if addr:
                        return Web3.to_checksum_address(addr)
            except Exception:
                pass
        return None

    def _text_to_bytes32(self, text: str) -> bytes:
        if text.startswith("0x") and len(text) == 66:
            return bytes.fromhex(text[2:])
        raw = text.encode("utf-8")
        if len(raw) > 32:
            raw = raw[:32]
        return raw.ljust(32, b"\x00")

    def _hex_to_bytes32(self, hex_str: str) -> bytes:
        clean = hex_str[2:] if hex_str.startswith("0x") else hex_str
        return bytes.fromhex(clean.zfill(64))

    def get_health(self) -> Dict[str, Any]:
        node_reachable = False
        chain_id = None
        try:
            node_reachable = self.w3.is_connected()
            if node_reachable:
                chain_id = self.w3.eth.chain_id
        except Exception:
            node_reachable = False

        contract_deployed = False
        if node_reachable and self._contract_address:
            try:
                code = self.w3.eth.get_code(self._contract_address)
                contract_deployed = bool(code and len(code) > 0 and code != b"\x00")
            except Exception:
                contract_deployed = False

        wallet_address = self.account.address if self.account else None
        balance_hbar = 0.0
        is_faculty = False

        if node_reachable and wallet_address:
            try:
                bal_wei = self.w3.eth.get_balance(wallet_address)
                balance_hbar = float(self.w3.from_wei(bal_wei, "ether"))
            except Exception:
                pass

        if contract_deployed and self.contract and wallet_address:
            try:
                is_faculty = self.contract.functions.isFaculty(wallet_address).call()
            except Exception:
                pass

        return {
            "mode": self._mode,
            "network": "Hedera Testnet" if self._mode == "hedera" else "Local Hardhat EVM",
            "chain_id": chain_id,
            "contract_address": self._contract_address,
            "node_reachable": node_reachable,
            "contract_deployed": contract_deployed,
            "wallet_address": wallet_address,
            "wallet_balance_hbar": balance_hbar,
            "is_faculty": is_faculty
        }

    def _send_transaction(self, build_func, gas_limit: int = 300000) -> str:
        """Sends signed transaction with nonce locking, dynamic gas price, and retry backoff."""
        if not self.account:
            raise ValueError("No private key configured for signing transactions")
        if not self.contract:
            raise ValueError("Contract is not deployed or initialized")

        max_retries = 3
        backoff_seconds = 2

        with self._nonce_lock:
            for attempt in range(1, max_retries + 1):
                try:
                    nonce = self.w3.eth.get_transaction_count(self.account.address, "pending")
                    gas_price = self.w3.eth.gas_price

                    tx_data = build_func().build_transaction({
                        "from": self.account.address,
                        "nonce": nonce,
                        "gas": gas_limit,
                        "gasPrice": gas_price,
                        "chainId": self._chain_id
                    })

                    signed_tx = self.w3.eth.account.sign_transaction(tx_data, private_key=self._private_key)
                    raw_tx_bytes = getattr(signed_tx, "raw_transaction", None) or getattr(signed_tx, "rawTransaction")
                    tx_hash = self.w3.eth.send_raw_transaction(raw_tx_bytes)
                    tx_hash_hex = f"0x{tx_hash.hex()}"

                    # Wait for receipt
                    receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
                    if receipt["status"] != 1:
                        raise RuntimeError(f"Transaction reverted on-chain: {tx_hash_hex}")

                    return tx_hash_hex

                except Exception as e:
                    err_msg = str(e)
                    # Check if already submitted or reverted with custom error
                    if "reverted" in err_msg.lower() or "already" in err_msg.lower() or attempt == max_retries:
                        raise e
                    time.sleep(backoff_seconds)
                    backoff_seconds *= 2

            raise RuntimeError("Transaction failed after multiple retries")

    def register_student(self, student_id_hex: str, face_commitment_hex: str) -> str:
        s_id_bytes = self._hex_to_bytes32(student_id_hex)
        fc_bytes = self._hex_to_bytes32(face_commitment_hex)

        # Pre-flight check
        existing = self.contract.functions.getStudent(s_id_bytes).call()
        if existing[0]:
            raise ValueError("AlreadyRegistered: Student already registered on-chain")

        return self._send_transaction(
            lambda: self.contract.functions.registerStudent(s_id_bytes, fc_bytes),
            gas_limit=300000
        )

    def get_student(self, student_id_hex: str) -> Dict[str, Any]:
        s_id_bytes = self._hex_to_bytes32(student_id_hex)
        reg, reg_at, fc = self.contract.functions.getStudent(s_id_bytes).call()
        return {
            "registered": reg,
            "registered_at": reg_at,
            "face_commitment": f"0x{fc.hex()}" if isinstance(fc, bytes) else str(fc)
        }

    def open_session(self, subject_str: str, duration_seconds: int) -> Tuple[int, str]:
        if not subject_str or subject_str.strip() == "":
            raise ValueError("InvalidSubject: subject cannot be empty")
        if duration_seconds < 60 or duration_seconds > 43200:
            raise ValueError("InvalidDuration: duration must be between 60s and 43200s")

        sub_bytes = self._text_to_bytes32(subject_str.strip().upper())
        initial_count = self.contract.functions.sessionCount().call()

        tx_hash = self._send_transaction(
            lambda: self.contract.functions.openSession(sub_bytes, duration_seconds),
            gas_limit=350000
        )
        new_count = self.contract.functions.sessionCount().call()
        session_id = new_count if new_count > initial_count else (initial_count + 1)
        return session_id, tx_hash

    def close_session(self, session_id: int) -> str:
        if not self.is_session_active(session_id):
            raise ValueError("SessionNotActive: Session is not active or already closed")

        return self._send_transaction(
            lambda: self.contract.functions.closeSession(session_id),
            gas_limit=200000
        )

    def get_session(self, session_id: int) -> Dict[str, Any]:
        subject, faculty, start_time, end_time, closed, present_count = self.contract.functions.getSession(session_id).call()
        sub_hex = f"0x{subject.hex()}" if isinstance(subject, bytes) else str(subject)
        sub_str = bytes.fromhex(sub_hex[2:]).decode("utf-8", errors="ignore").rstrip("\x00")

        return {
            "session_id": session_id,
            "subject": sub_hex,
            "subject_str": sub_str,
            "faculty": faculty,
            "start_time": start_time,
            "end_time": end_time,
            "closed": closed,
            "present_count": present_count,
            "is_active": self.is_session_active(session_id)
        }

    def is_session_active(self, session_id: int) -> bool:
        try:
            return self.contract.functions.isSessionActive(session_id).call()
        except Exception:
            return False

    def get_session_count(self) -> int:
        return self.contract.functions.sessionCount().call()

    def mark_attendance(self, session_id: int, student_id_hex: str, evidence_hash_hex: str) -> str:
        s_id_bytes = self._hex_to_bytes32(student_id_hex)
        ev_bytes = self._hex_to_bytes32(evidence_hash_hex)

        # Pre-flight read checks
        if not self.is_session_active(session_id):
            raise ValueError("SessionNotActive: session is closed or expired")

        student = self.contract.functions.getStudent(s_id_bytes).call()
        if not student[0]:
            raise ValueError("NotRegistered: student is not registered on-chain")

        if self.contract.functions.hasAttended(session_id, s_id_bytes).call():
            raise ValueError("AlreadyMarked: attendance already recorded for this session")

        return self._send_transaction(
            lambda: self.contract.functions.markAttendance(session_id, s_id_bytes, ev_bytes),
            gas_limit=350000
        )

    def has_attended(self, session_id: int, student_id_hex: str) -> bool:
        s_id_bytes = self._hex_to_bytes32(student_id_hex)
        return self.contract.functions.hasAttended(session_id, s_id_bytes).call()

    def get_evidence(self, session_id: int, student_id_hex: str) -> str:
        s_id_bytes = self._hex_to_bytes32(student_id_hex)
        ev = self.contract.functions.getEvidence(session_id, s_id_bytes).call()
        return f"0x{ev.hex()}" if isinstance(ev, bytes) else str(ev)

    def get_student_summary(self, student_id_hex: str, subject_str: str) -> Dict[str, Any]:
        s_id_bytes = self._hex_to_bytes32(student_id_hex)
        sub_bytes = self._text_to_bytes32(subject_str.strip().upper())

        total = self.contract.functions.totalSessions(sub_bytes).call()
        present = self.contract.functions.presentSessions(sub_bytes, s_id_bytes).call()
        pct = self.contract.functions.attendancePercent(sub_bytes, s_id_bytes).call()

        return {
            "total_sessions": total,
            "present_sessions": present,
            "attendance_percent": pct
        }

    def get_explorer_tx_url(self, tx_hash: str) -> str:
        if self._mode == "hedera":
            return f"https://hashscan.io/testnet/transaction/{tx_hash}"
        return f"http://localhost:8545/tx/{tx_hash}"

    def get_explorer_contract_url(self, contract_address: Optional[str] = None) -> str:
        addr = contract_address or self._contract_address
        if self._mode == "hedera":
            return f"https://hashscan.io/testnet/contract/{addr}"
        return f"http://localhost:8545/address/{addr}"

