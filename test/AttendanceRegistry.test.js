const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AttendanceRegistry", function () {
  let AttendanceRegistry;
  let registry;
  let owner, faculty1, faculty2, studentWallet, attacker;

  // Helpers
  const toBytes32 = (text) => ethers.encodeBytes32String(text);
  const hashRoll = (roll) => ethers.keccak256(ethers.toUtf8Bytes(roll));
  const dummyCommitment = (hexByte = "11") => "0x" + hexByte.repeat(32);
  const dummyEvidence = (hexByte = "aa") => "0x" + hexByte.repeat(32);

  beforeEach(async function () {
    [owner, faculty1, faculty2, studentWallet, attacker] = await ethers.getSigners();
    AttendanceRegistry = await ethers.getContractFactory("AttendanceRegistry");
    registry = await AttendanceRegistry.deploy();
    await registry.waitForDeployment();
  });

  describe("Deployment & Roles", function () {
    it("should set deployer as owner and default faculty", async function () {
      expect(await registry.owner()).to.equal(owner.address);
      expect(await registry.isFaculty(owner.address)).to.be.true;
    });

    it("should allow owner to add and remove faculty", async function () {
      await expect(registry.connect(owner).setFaculty(faculty1.address, true))
        .to.emit(registry, "FacultyUpdated")
        .withArgs(faculty1.address, true);

      expect(await registry.isFaculty(faculty1.address)).to.be.true;

      await expect(registry.connect(owner).setFaculty(faculty1.address, false))
        .to.emit(registry, "FacultyUpdated")
        .withArgs(faculty1.address, false);

      expect(await registry.isFaculty(faculty1.address)).to.be.false;
    });

    it("should revert if non-owner tries to set faculty", async function () {
      await expect(
        registry.connect(attacker).setFaculty(faculty1.address, true)
      ).to.be.revertedWithCustomError(registry, "NotOwner");
    });
  });

  describe("Student Registration", function () {
    const studentId = hashRoll("CS101");
    const commitment = dummyCommitment("22");

    it("should allow owner to register a student and emit event", async function () {
      const tx = await registry.connect(owner).registerStudent(studentId, commitment);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(registry, "StudentRegistered")
        .withArgs(studentId, commitment, block.timestamp);

      const [registered, registeredAt, faceCommitment] = await registry.getStudent(studentId);
      expect(registered).to.be.true;
      expect(registeredAt).to.equal(block.timestamp);
      expect(faceCommitment).to.equal(commitment);
    });

    it("should revert if student is already registered", async function () {
      await registry.connect(owner).registerStudent(studentId, commitment);

      await expect(
        registry.connect(owner).registerStudent(studentId, commitment)
      ).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    });

    it("should revert if non-owner tries to register a student", async function () {
      await expect(
        registry.connect(attacker).registerStudent(studentId, commitment)
      ).to.be.revertedWithCustomError(registry, "NotOwner");
    });

    it("should return false and zero fields for unregistered student", async function () {
      const unknownId = hashRoll("UNKNOWN");
      const [registered, registeredAt, faceCommitment] = await registry.getStudent(unknownId);
      expect(registered).to.be.false;
      expect(registeredAt).to.equal(0);
      expect(faceCommitment).to.equal(ethers.ZeroHash);
    });
  });

  describe("Session Lifecycle", function () {
    const subject = toBytes32("CS301_BLOCKCHAIN");
    const duration = 3600; // 1 hour

    beforeEach(async function () {
      await registry.connect(owner).setFaculty(faculty1.address, true);
    });

    it("should allow faculty to open a session", async function () {
      const tx = await registry.connect(faculty1).openSession(subject, duration);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(registry, "SessionOpened")
        .withArgs(1, subject, faculty1.address, block.timestamp, block.timestamp + duration);

      expect(await registry.sessionCount()).to.equal(1);
      expect(await registry.isSessionActive(1)).to.be.true;

      const [sSubject, sFaculty, sStart, sEnd, sClosed, sPresentCount] = await registry.getSession(1);
      expect(sSubject).to.equal(subject);
      expect(sFaculty).to.equal(faculty1.address);
      expect(sStart).to.equal(block.timestamp);
      expect(sEnd).to.equal(block.timestamp + duration);
      expect(sClosed).to.be.false;
      expect(sPresentCount).to.equal(0);
    });

    it("should revert if non-faculty opens a session", async function () {
      await expect(
        registry.connect(attacker).openSession(subject, duration)
      ).to.be.revertedWithCustomError(registry, "NotFaculty");
    });

    it("should revert if subject is empty (bytes32(0))", async function () {
      await expect(
        registry.connect(faculty1).openSession(ethers.ZeroHash, duration)
      ).to.be.revertedWithCustomError(registry, "InvalidSubject");
    });

    it("should revert if duration < 60s or > 43200s (12h)", async function () {
      await expect(
        registry.connect(faculty1).openSession(subject, 59)
      ).to.be.revertedWithCustomError(registry, "InvalidDuration");

      await expect(
        registry.connect(faculty1).openSession(subject, 43201)
      ).to.be.revertedWithCustomError(registry, "InvalidDuration");
    });

    it("should allow session faculty or contract owner to close session", async function () {
      await registry.connect(faculty1).openSession(subject, duration);

      // Faculty closes it
      await expect(registry.connect(faculty1).closeSession(1))
        .to.emit(registry, "SessionClosed");

      expect(await registry.isSessionActive(1)).to.be.false;

      // Cannot close already closed session
      await expect(
        registry.connect(faculty1).closeSession(1)
      ).to.be.revertedWithCustomError(registry, "SessionNotActive");
    });

    it("should allow owner to close any session", async function () {
      await registry.connect(faculty1).openSession(subject, duration);

      await expect(registry.connect(owner).closeSession(1))
        .to.emit(registry, "SessionClosed");
      expect(await registry.isSessionActive(1)).to.be.false;
    });

    it("should revert if non-session faculty or attacker tries to close session", async function () {
      await registry.connect(owner).setFaculty(faculty2.address, true);
      await registry.connect(faculty1).openSession(subject, duration);

      await expect(
        registry.connect(faculty2).closeSession(1)
      ).to.be.revertedWithCustomError(registry, "NotSessionFaculty");

      await expect(
        registry.connect(attacker).closeSession(1)
      ).to.be.revertedWithCustomError(registry, "NotSessionFaculty");
    });

    it("should revert on invalid session id for getSession and closeSession", async function () {
      await expect(registry.getSession(0)).to.be.revertedWithCustomError(registry, "InvalidSession");
      await expect(registry.getSession(999)).to.be.revertedWithCustomError(registry, "InvalidSession");

      await expect(registry.connect(faculty1).closeSession(0)).to.be.revertedWithCustomError(registry, "InvalidSession");
      await expect(registry.connect(faculty1).closeSession(999)).to.be.revertedWithCustomError(registry, "InvalidSession");

      expect(await registry.isSessionActive(0)).to.be.false;
      expect(await registry.isSessionActive(999)).to.be.false;
    });

    it("should consider session inactive after time window expires", async function () {
      await registry.connect(faculty1).openSession(subject, 100);
      expect(await registry.isSessionActive(1)).to.be.true;

      // Time travel past 100s
      await ethers.provider.send("evm_increaseTime", [101]);
      await ethers.provider.send("evm_mine");

      expect(await registry.isSessionActive(1)).to.be.false;
    });
  });

  describe("Attendance Marking", function () {
    const subject = toBytes32("CS301_BLOCKCHAIN");
    const duration = 1800; // 30 mins
    const student1 = hashRoll("ROLL01");
    const student2 = hashRoll("ROLL02");
    const commitment1 = dummyCommitment("33");
    const commitment2 = dummyCommitment("44");
    const evidence1 = dummyEvidence("aa");
    const evidence2 = dummyEvidence("bb");

    beforeEach(async function () {
      await registry.connect(owner).setFaculty(faculty1.address, true);
      await registry.connect(owner).registerStudent(student1, commitment1);
      await registry.connect(owner).registerStudent(student2, commitment2);
      await registry.connect(faculty1).openSession(subject, duration);
    });

    it("should mark attendance, store evidence, update counts and emit event", async function () {
      const tx = await registry.connect(faculty1).markAttendance(1, student1, evidence1);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(registry, "AttendanceMarked")
        .withArgs(1, student1, subject, evidence1, block.timestamp);

      expect(await registry.hasAttended(1, student1)).to.be.true;
      expect(await registry.getEvidence(1, student1)).to.equal(evidence1);

      const [, , , , , presentCount] = await registry.getSession(1);
      expect(presentCount).to.equal(1);
      expect(await registry.presentSessions(subject, student1)).to.equal(1);
      expect(await registry.totalSessions(subject)).to.equal(1);
      expect(await registry.attendancePercent(subject, student1)).to.equal(100);
    });

    it("should revert if non-session-faculty attempts to mark attendance", async function () {
      await expect(
        registry.connect(owner).markAttendance(1, student1, evidence1)
      ).to.be.revertedWithCustomError(registry, "NotSessionFaculty");

      await expect(
        registry.connect(attacker).markAttendance(1, student1, evidence1)
      ).to.be.revertedWithCustomError(registry, "NotSessionFaculty");
    });

    it("should revert if session id is invalid", async function () {
      await expect(
        registry.connect(faculty1).markAttendance(0, student1, evidence1)
      ).to.be.revertedWithCustomError(registry, "InvalidSession");

      await expect(
        registry.connect(faculty1).markAttendance(99, student1, evidence1)
      ).to.be.revertedWithCustomError(registry, "InvalidSession");
    });

    it("should revert if student is not registered", async function () {
      const unregistered = hashRoll("NOT_EXIST");
      await expect(
        registry.connect(faculty1).markAttendance(1, unregistered, evidence1)
      ).to.be.revertedWithCustomError(registry, "NotRegistered");
    });

    it("should revert if student is marked more than once in same session", async function () {
      await registry.connect(faculty1).markAttendance(1, student1, evidence1);

      await expect(
        registry.connect(faculty1).markAttendance(1, student1, evidence1)
      ).to.be.revertedWithCustomError(registry, "AlreadyMarked");
    });

    it("should revert if session is closed or expired", async function () {
      // Close session
      await registry.connect(faculty1).closeSession(1);
      await expect(
        registry.connect(faculty1).markAttendance(1, student1, evidence1)
      ).to.be.revertedWithCustomError(registry, "SessionNotActive");

      // Open second session and let it expire
      await registry.connect(faculty1).openSession(subject, 100);
      await ethers.provider.send("evm_increaseTime", [150]);
      await ethers.provider.send("evm_mine");

      await expect(
        registry.connect(faculty1).markAttendance(2, student1, evidence1)
      ).to.be.revertedWithCustomError(registry, "SessionNotActive");
    });
  });

  describe("Percentage & Multi-Session Math", function () {
    const subjectA = toBytes32("MATH101");
    const subjectB = toBytes32("PHY101");
    const student = hashRoll("STUDENT_A");

    beforeEach(async function () {
      await registry.connect(owner).registerStudent(student, dummyCommitment());
      await registry.connect(owner).setFaculty(faculty1.address, true);
    });

    it("should return 0% when no sessions exist", async function () {
      expect(await registry.totalSessions(subjectA)).to.equal(0);
      expect(await registry.attendancePercent(subjectA, student)).to.equal(0);
    });

    it("should calculate correct integer percentage across multiple sessions", async function () {
      // Open 3 sessions for MATH101
      await registry.connect(faculty1).openSession(subjectA, 3600); // Session 1
      await registry.connect(faculty1).openSession(subjectA, 3600); // Session 2
      await registry.connect(faculty1).openSession(subjectA, 3600); // Session 3

      // Mark student in Session 1 only (1 out of 3 = 33%)
      await registry.connect(faculty1).markAttendance(1, student, dummyEvidence("01"));
      expect(await registry.totalSessions(subjectA)).to.equal(3);
      expect(await registry.presentSessions(subjectA, student)).to.equal(1);
      expect(await registry.attendancePercent(subjectA, student)).to.equal(33);

      // Mark student in Session 2 (2 out of 3 = 66%)
      await registry.connect(faculty1).markAttendance(2, student, dummyEvidence("02"));
      expect(await registry.presentSessions(subjectA, student)).to.equal(2);
      expect(await registry.attendancePercent(subjectA, student)).to.equal(66);

      // Mark student in Session 3 (3 out of 3 = 100%)
      await registry.connect(faculty1).markAttendance(3, student, dummyEvidence("03"));
      expect(await registry.presentSessions(subjectA, student)).to.equal(3);
      expect(await registry.attendancePercent(subjectA, student)).to.equal(100);

      // Verify PHY101 remains untouched at 0
      expect(await registry.totalSessions(subjectB)).to.equal(0);
      expect(await registry.attendancePercent(subjectB, student)).to.equal(0);
    });
  });
});

