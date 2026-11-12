"""
Node.js Ethers Bridge Blockchain Adapter for Hedera Smart Contract Service.
Provides 100% AppLocker-safe, pure-JS EVM transaction execution on Hedera Testnet.
"""

import os
import json
import logging
import subprocess
from pathlib import Path
from typing import Dict, Any, Tuple, Optional
from .base import ChainAdapter

logger = logging.getLogger("attendchain.hedera")

class HederaNodeBridgeAdapter(ChainAdapter):
    def __init__(
        self,
        mode: str = "hedera",
        rpc_url: Optional[str] = None,
        chain_id: Optional[int] = None,
        private_key: Optional[str] = None,
        contract_address: Optional[str] = None
    ):
        self._mode = mode
        self._rpc_url = rpc_url or os.getenv("HEDERA_RPC_URL", "https://testnet.hashio.io/api")
        self._chain_id = chain_id or int(os.getenv("HEDERA_CHAIN_ID", "296"))
        self._private_key = private_key or os.getenv("FACULTY_PRIVATE_KEY", "")
        self._contract_address = contract_address or os.getenv("CONTRACT_ADDRESS", "")

        self._bridge_script = Path(__file__).resolve().parent.parent.parent / "scripts" / "hedera_bridge.js"

    @property
    def mode(self) -> str:
        return self._mode

    @property
    def contract_address(self) -> str:
        return self._contract_address or ""

    def _call_bridge(self, action: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Invokes scripts/hedera_bridge.js via node with JSON payload."""
        payload_str = json.dumps(payload or {})
        cmd = ["node", str(self._bridge_script), action, payload_str]

        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
            stdout = res.stdout.strip()
            if not stdout:
                return {"ok": False, "error": f"Empty response from hedera_bridge. stderr: {res.stderr}"}

            # Find the last valid JSON line
            for line in reversed(stdout.splitlines()):
                line = line.strip()
                if line.startswith("{") and line.endswith("}"):
                    try:
                        return json.loads(line)
                    except json.JSONDecodeError:
                        continue

            return {"ok": False, "error": f"Could not parse bridge output: {stdout}"}
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "Hedera transaction execution timed out after 45s."}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_health(self) -> Dict[str, Any]:
        res = self._call_bridge("get_health")
        if res.get("ok"):
            res.pop("ok", None)
            if res.get("contract_address"):
                self._contract_address = res["contract_address"]
            return res
        return {
            "mode": "hedera",
            "network": "Hedera Testnet (296)",
            "chain_id": self._chain_id,
            "contract_address": self._contract_address,
            "wallet_address": "0x0000000000000000000000000000000000000000",
            "wallet_balance_hbar": 0.0,
            "node_reachable": False,
            "contract_deployed": False,
            "error": res.get("error")
        }

    def register_student(self, student_id_hex: str, face_commitment_hex: str) -> str:
        res = self._call_bridge("register_student", {
            "student_id": student_id_hex,
            "face_commitment": face_commitment_hex
        })
        if not res.get("ok"):
            raise RuntimeError(f"Hedera student registration failed: {res.get('error')}")
        return res.get("tx_hash", "")

    def get_student(self, student_id_hex: str) -> Dict[str, Any]:
        res = self._call_bridge("get_student", {"student_id": student_id_hex})
        if not res.get("ok"):
            return {"registered": False, "registered_at": 0, "face_commitment": "0x0"}
        return {
            "registered": res.get("registered", False),
            "registered_at": res.get("registered_at", 0),
            "face_commitment": res.get("face_commitment", "")
        }

    def open_session(self, subject_str: str, duration_seconds: int) -> Tuple[int, str]:
        res = self._call_bridge("open_session", {
            "subject": subject_str,
            "duration_seconds": duration_seconds
        })
        if not res.get("ok"):
            raise RuntimeError(f"Hedera open_session failed: {res.get('error')}")
        return res.get("session_id", 1), res.get("tx_hash", "")

    def close_session(self, session_id: int) -> str:
        res = self._call_bridge("close_session", {"session_id": session_id})
        if not res.get("ok"):
            raise RuntimeError(f"Hedera close_session failed: {res.get('error')}")
        return res.get("tx_hash", "")

    def get_session(self, session_id: int) -> Dict[str, Any]:
        res = self._call_bridge("get_session", {"session_id": session_id})
        if not res.get("ok"):
            return {
                "session_id": session_id,
                "subject": "",
                "faculty": "",
                "start_time": 0,
                "end_time": 0,
                "closed": True,
                "present_count": 0
            }
        res.pop("ok", None)
        return res

    def is_session_active(self, session_id: int) -> bool:
        res = self._call_bridge("is_session_active", {"session_id": session_id})
        return res.get("active", False)

    def get_session_count(self) -> int:
        return 1

    def mark_attendance(self, session_id: int, student_id_hex: str, evidence_hash_hex: str) -> str:
        res = self._call_bridge("record_attendance", {
            "session_id": session_id,
            "student_id": student_id_hex,
            "evidence_hash": evidence_hash_hex
        })
        if not res.get("ok"):
            raise RuntimeError(f"Hedera record_attendance failed: {res.get('error')}")
        return res.get("tx_hash", "")

    def has_attended(self, session_id: int, student_id_hex: str) -> bool:
        res = self._call_bridge("get_attendance", {
            "session_id": session_id,
            "student_id": student_id_hex
        })
        return res.get("present", False)

    def get_evidence(self, session_id: int, student_id_hex: str) -> str:
        res = self._call_bridge("get_attendance", {
            "session_id": session_id,
            "student_id": student_id_hex
        })
        return res.get("evidence_hash", "")

    def get_student_summary(self, student_id_hex: str, subject_str: str) -> Dict[str, Any]:
        return {
            "total_sessions": 0,
            "present_sessions": 0,
            "attendance_percent": 100
        }

    def get_explorer_tx_url(self, tx_hash: str) -> str:
        clean = tx_hash.strip()
        return f"https://hashscan.io/testnet/transaction/{clean}"

    def get_explorer_contract_url(self, contract_address: Optional[str] = None) -> str:
        addr = contract_address or self.contract_address
        return f"https://hashscan.io/testnet/contract/{addr}"

