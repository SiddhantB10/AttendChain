"""
Abstract Base Interface for AttendChain Blockchain Adapters.
Supports three runtime modes:
- 'mock': In-memory hash-chained ledger for hermetic testing and offline UI work.
- 'local': Local Hardhat EVM node.
- 'hedera': Hedera Smart Contract Service on Hedera Testnet via JSON-RPC Relay.
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, Tuple, Optional

class ChainAdapter(ABC):
    @property
    @abstractmethod
    def mode(self) -> str:
        """Returns 'mock', 'local', or 'hedera'."""
        pass

    @property
    @abstractmethod
    def contract_address(self) -> str:
        """Returns deployed contract address."""
        pass

    @abstractmethod
    def get_health(self) -> Dict[str, Any]:
        """Returns connectivity, contract state, and wallet balance info."""
        pass

    @abstractmethod
    def register_student(self, student_id_hex: str, face_commitment_hex: str) -> str:
        """
        Registers student on-chain.
        student_id_hex: keccak256(rollNo) as 0x-prefixed 32-byte hex.
        face_commitment_hex: SHA-256(face embedding) as 0x-prefixed 32-byte hex.
        Returns transaction hash.
        """
        pass

    @abstractmethod
    def get_student(self, student_id_hex: str) -> Dict[str, Any]:
        """Returns {'registered': bool, 'registered_at': int, 'face_commitment': str}."""
        pass

    @abstractmethod
    def open_session(self, subject_str: str, duration_seconds: int) -> Tuple[int, str]:
        """
        Opens a new attendance session for subject.
        Returns (session_id, tx_hash).
        """
        pass

    @abstractmethod
    def close_session(self, session_id: int) -> str:
        """Closes active session. Returns tx_hash."""
        pass

    @abstractmethod
    def get_session(self, session_id: int) -> Dict[str, Any]:
        """Returns session details including start/end time, closed state, present count."""
        pass

    @abstractmethod
    def is_session_active(self, session_id: int) -> bool:
        """Checks if session exists, is not closed, and endTime > current time."""
        pass

    @abstractmethod
    def get_session_count(self) -> int:
        """Returns total number of sessions created."""
        pass

    @abstractmethod
    def mark_attendance(self, session_id: int, student_id_hex: str, evidence_hash_hex: str) -> str:
        """
        Records verified attendance on-chain.
        Returns transaction hash.
        """
        pass

    @abstractmethod
    def has_attended(self, session_id: int, student_id_hex: str) -> bool:
        """Returns whether student attended the session."""
        pass

    @abstractmethod
    def get_evidence(self, session_id: int, student_id_hex: str) -> str:
        """Returns on-chain evidence hash for the student in given session."""
        pass

    @abstractmethod
    def get_student_summary(self, student_id_hex: str, subject_str: str) -> Dict[str, Any]:
        """Returns {'total_sessions': int, 'present_sessions': int, 'attendance_percent': int}."""
        pass

    @abstractmethod
    def get_explorer_tx_url(self, tx_hash: str) -> str:
        """Returns explorer URL for a transaction hash."""
        pass

    @abstractmethod
    def get_explorer_contract_url(self, contract_address: Optional[str] = None) -> str:
        """Returns explorer URL for the contract."""
        pass

