// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AttendanceRegistry
 * @dev Verifiable, privacy-preserving face recognition attendance registry for Hedera EVM.
 * Zero PII/biometrics stored on-chain: only SHA-256 face commitments and keccak256 student IDs.
 */
contract AttendanceRegistry {
    // --- Custom Errors ---
    error NotOwner();
    error NotFaculty();
    error NotSessionFaculty();
    error AlreadyRegistered();
    error NotRegistered();
    error InvalidSession();
    error InvalidSubject();
    error InvalidDuration();
    error SessionNotActive();
    error AlreadyMarked();

    // --- State Structures ---
    struct Student {
        bool registered;
        uint64 registeredAt;
        bytes32 faceCommitment;
    }

    struct Session {
        bytes32 subject;
        address faculty;
        uint64 startTime;
        uint64 endTime;
        bool closed;
        uint32 presentCount;
    }

    // --- State Variables ---
    address public immutable owner;
    mapping(address => bool) public isFaculty;

    // studentId (keccak256(rollNo)) => Student
    mapping(bytes32 => Student) private students;

    // 1-indexed sessions: sessionId => Session
    mapping(uint256 => Session) private sessions;
    uint256 public sessionCount;

    // subject => list of session IDs
    mapping(bytes32 => uint256[]) private subjectSessions;

    // sessionId => (studentId => attended)
    mapping(uint256 => mapping(bytes32 => bool)) private attendance;

    // sessionId => (studentId => evidenceHash)
    mapping(uint256 => mapping(bytes32 => bytes32)) private evidenceHashes;

    // subject => (studentId => attended session count)
    mapping(bytes32 => mapping(bytes32 => uint32)) private studentSubjectAttendance;

    // --- Events ---
    event FacultyUpdated(address indexed faculty, bool status);
    event StudentRegistered(bytes32 indexed studentId, bytes32 faceCommitment, uint64 timestamp);
    event SessionOpened(uint256 indexed sessionId, bytes32 indexed subject, address indexed faculty, uint64 startTime, uint64 endTime);
    event SessionClosed(uint256 indexed sessionId, uint64 timestamp);
    event AttendanceMarked(uint256 indexed sessionId, bytes32 indexed studentId, bytes32 indexed subject, bytes32 evidenceHash, uint64 timestamp);

    // --- Modifiers ---
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyFaculty() {
        if (!isFaculty[msg.sender]) revert NotFaculty();
        _;
    }

    constructor() {
        owner = msg.sender;
        isFaculty[msg.sender] = true;
        emit FacultyUpdated(msg.sender, true);
    }

    // --- Faculty Management ---
    function setFaculty(address faculty, bool status) external onlyOwner {
        isFaculty[faculty] = status;
        emit FacultyUpdated(faculty, status);
    }

    // --- Student Registration ---
    function registerStudent(bytes32 studentId, bytes32 faceCommitment) external onlyOwner {
        if (students[studentId].registered) revert AlreadyRegistered();
        uint64 nowTs = uint64(block.timestamp);
        students[studentId] = Student({
            registered: true,
            registeredAt: nowTs,
            faceCommitment: faceCommitment
        });
        emit StudentRegistered(studentId, faceCommitment, nowTs);
    }

    function getStudent(bytes32 studentId) external view returns (bool registered, uint64 registeredAt, bytes32 faceCommitment) {
        Student memory s = students[studentId];
        return (s.registered, s.registeredAt, s.faceCommitment);
    }

    // --- Session Lifecycle ---
    function openSession(bytes32 subject, uint64 durationSeconds) external onlyFaculty returns (uint256) {
        if (subject == bytes32(0)) revert InvalidSubject();
        if (durationSeconds < 60 || durationSeconds > 43200) revert InvalidDuration(); // 60s to 12h

        uint256 id = ++sessionCount;
        uint64 start = uint64(block.timestamp);
        uint64 end = start + durationSeconds;

        sessions[id] = Session({
            subject: subject,
            faculty: msg.sender,
            startTime: start,
            endTime: end,
            closed: false,
            presentCount: 0
        });

        subjectSessions[subject].push(id);

        emit SessionOpened(id, subject, msg.sender, start, end);
        return id;
    }

    function closeSession(uint256 sessionId) external {
        if (sessionId == 0 || sessionId > sessionCount) revert InvalidSession();
        Session storage s = sessions[sessionId];
        if (msg.sender != s.faculty && msg.sender != owner) revert NotSessionFaculty();
        if (s.closed) revert SessionNotActive();

        s.closed = true;
        emit SessionClosed(sessionId, uint64(block.timestamp));
    }

    function getSession(uint256 sessionId) external view returns (
        bytes32 subject,
        address faculty,
        uint64 startTime,
        uint64 endTime,
        bool closed,
        uint32 presentCount
    ) {
        if (sessionId == 0 || sessionId > sessionCount) revert InvalidSession();
        Session memory s = sessions[sessionId];
        return (s.subject, s.faculty, s.startTime, s.endTime, s.closed, s.presentCount);
    }

    function isSessionActive(uint256 sessionId) public view returns (bool) {
        if (sessionId == 0 || sessionId > sessionCount) return false;
        Session memory s = sessions[sessionId];
        if (s.closed) return false;
        if (block.timestamp > s.endTime) return false;
        return true;
    }

    // --- Attendance Marking ---
    function markAttendance(uint256 sessionId, bytes32 studentId, bytes32 evidenceHash) external {
        if (sessionId == 0 || sessionId > sessionCount) revert InvalidSession();
        Session storage s = sessions[sessionId];

        if (msg.sender != s.faculty) revert NotSessionFaculty();
        if (s.closed || block.timestamp > s.endTime) revert SessionNotActive();
        if (!students[studentId].registered) revert NotRegistered();
        if (attendance[sessionId][studentId]) revert AlreadyMarked();

        attendance[sessionId][studentId] = true;
        evidenceHashes[sessionId][studentId] = evidenceHash;
        s.presentCount++;
        studentSubjectAttendance[s.subject][studentId]++;

        emit AttendanceMarked(sessionId, studentId, s.subject, evidenceHash, uint64(block.timestamp));
    }

    // --- Views ---
    function hasAttended(uint256 sessionId, bytes32 studentId) external view returns (bool) {
        return attendance[sessionId][studentId];
    }

    function getEvidence(uint256 sessionId, bytes32 studentId) external view returns (bytes32) {
        return evidenceHashes[sessionId][studentId];
    }

    function totalSessions(bytes32 subject) external view returns (uint256) {
        return subjectSessions[subject].length;
    }

    function presentSessions(bytes32 subject, bytes32 studentId) external view returns (uint32) {
        return studentSubjectAttendance[subject][studentId];
    }

    function attendancePercent(bytes32 subject, bytes32 studentId) external view returns (uint256) {
        uint256 total = subjectSessions[subject].length;
        if (total == 0) return 0;
        uint256 attended = studentSubjectAttendance[subject][studentId];
        return (attended * 100) / total;
    }
}

