/**
 * AttendChain Professional Dashboard Application
 * Real-Time Face Tracking HUD • Automated Liveness & Attendance Kiosk • Hedera SCS
 */

(() => {
  "use strict";

  // --- Global State ---
  let markStream = null;
  let registerStream = null;
  let isTracking = false;
  let isCapturing = false;
  let isSoundEnabled = localStorage.getItem("attendchain_sound") !== "false";
  let activeSessions = [];
  let currentActiveSession = null;
  let sessionCountdownTimer = null;
  let autoMarkTimeout = null;
  let faceLockedFrames = 0;
  let recentCheckins = [];
  let registeredStudentCount = 0;

  // Face Tracker Interpolation State (smooth 60fps bounding box)
  let currentBox = null;
  let targetBox = null;
  let nativeFaceDetector = null;

  // Initialize Native FaceDetector if available in browser
  if ("FaceDetector" in window) {
    try {
      nativeFaceDetector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 2 });
    } catch (e) {
      nativeFaceDetector = null;
    }
  }

  // --- Sound Effects via Web Audio API ---
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  function playSound(type) {
    if (!isSoundEnabled || !audioCtx) return;
    try {
      if (audioCtx.state === "suspended") {
        audioCtx.resume();
      }

      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (type === "success") {
        // Harmonic positive chime
        osc.type = "sine";
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.12);
        osc.frequency.exponentialRampToValueAtTime(1046.50, now + 0.28);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
        osc.start(now);
        osc.stop(now + 0.45);

      } else if (type === "lock") {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(1200, now + 0.06);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        osc.start(now);
        osc.stop(now + 0.08);

      } else if (type === "error") {
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(260, now);
        osc.frequency.exponentialRampToValueAtTime(160, now + 0.25);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
      }
    } catch (e) {
      // Audio autoplay policy fallback
    }
  }

  // --- Utilities ---
  function escapeHtml(text) {
    if (text === null || text === undefined) return "";
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function shorten(str, chars = 6) {
    if (!str || str.length <= chars * 2 + 2) return str;
    return `${str.substring(0, chars + 2)}...${str.substring(str.length - chars)}`;
  }

  function getAdminToken() {
    return sessionStorage.getItem("attendchain_admin_token") || "attendchain-admin-secret-change-me";
  }

  // Bulletproof Safe Fetch JSON Helper - Prevents any "<!doctype" or HTML leaking into JSON errors
  async function safeFetchJson(url, options = {}) {
    try {
      const res = await fetch(url, options);
      const contentType = res.headers.get("content-type") || "";
      let data = {};
      if (contentType.includes("application/json")) {
        try {
          data = await res.json();
        } catch (err) {
          data = { error: "Invalid JSON response from server", verdict: "parse_error" };
        }
      } else {
        const text = await res.text();
        try {
          data = JSON.parse(text);
        } catch (err) {
          // Strip HTML tags if server returned HTML (e.g. 404/500/proxy page)
          const cleanText = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
          data = {
            error: res.ok ? "Server returned non-JSON data" : `Server error (${res.status}): ${cleanText.slice(0, 120) || res.statusText}`,
            verdict: "server_error",
            raw_text: cleanText.slice(0, 200)
          };
        }
      }
      return { ok: res.ok, status: res.status, data };
    } catch (networkErr) {
      console.warn("safeFetchJson network error:", url, networkErr);
      return {
        ok: false,
        status: 0,
        data: {
          error: `Network error or server unreachable: ${networkErr.message}`,
          verdict: "network_error"
        }
      };
    }
  }

  // --- Permanent Clean Light Theme ---
  localStorage.removeItem("attendchain_theme");
  document.body.className = "theme-light";

  // --- Brand Logo Home Navigation ---
  const brandHomeBtn = document.getElementById("brandHomeBtn");
  if (brandHomeBtn) {
    const handleHomeClick = (e) => {
      if (e) e.preventDefault();
      if (currentUserRole === "student" && currentStudentData) {
        switchTab("tab-portal");
      } else if (currentUserRole === "faculty") {
        switchTab("tab-admin");
      } else if (currentUserRole === "admin") {
        switchTab("tab-superadmin");
      } else {
        switchTab("tab-gateway");
        setGatewayMode("signin");
      }
    };
    brandHomeBtn.addEventListener("click", handleHomeClick);
    brandHomeBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleHomeClick();
      }
    });
  }

  // --- Role-Based Auth State ---
  let currentUserRole = sessionStorage.getItem("attendchain_user_role") || "guest"; // 'student', 'faculty', 'admin', 'guest'
  let currentStudentData = null;
  let currentFacultyData = null;
  let currentAdminData = null;
  try {
    if (currentUserRole === "student") {
      const raw = sessionStorage.getItem("attendchain_student_data");
      if (raw) currentStudentData = JSON.parse(raw);
    } else if (currentUserRole === "faculty") {
      const rawFac = sessionStorage.getItem("attendchain_faculty_data");
      if (rawFac) currentFacultyData = JSON.parse(rawFac);
      currentStudentData = null;
      sessionStorage.removeItem("attendchain_student_data");
    } else if (currentUserRole === "admin") {
      const rawAdm = sessionStorage.getItem("attendchain_admin_data");
      if (rawAdm) currentAdminData = JSON.parse(rawAdm);
      currentStudentData = null;
      sessionStorage.removeItem("attendchain_student_data");
    } else {
      currentStudentData = null;
      currentFacultyData = null;
      currentAdminData = null;
    }
  } catch (e) {
    currentStudentData = null;
    currentFacultyData = null;
    currentAdminData = null;
  }

  // --- Sleek Non-Blocking Toast Notification System ---
  function showToast(message, type = "info") {
    let container = document.getElementById("attendToastContainer");
    if (!container) {
      container = document.createElement("div");
      container.id = "attendToastContainer";
      container.className = "attend-toast-container";
      document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = `attend-toast toast-${type}`;

    let iconSvg = "";
    if (type === "success") {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    } else if (type === "error") {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
    } else {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
    }

    toast.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        ${iconSvg}
        <span>${escapeHtml(message)}</span>
      </div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(20px)";
      setTimeout(() => toast.remove(), 260);
    }, 3200);
  }

  // --- Real-Time Cross-Tab & Dashboard Live Sync (Instant Inter-Tab Broadcast) ---
  const attendSyncChannel = (typeof BroadcastChannel !== "undefined")
    ? new BroadcastChannel("attendchain_live_sync")
    : null;

  function notifySessionSync(groupId) {
    if (attendSyncChannel) {
      try {
        attendSyncChannel.postMessage({ type: "SESSION_UPDATE", groupId, timestamp: Date.now() });
      } catch (_) {}
    }
    try {
      localStorage.setItem("attendchain_last_sync", Date.now().toString());
    } catch (_) {}
  }

  function handleLiveSyncUpdate() {
    if (currentUserRole === "student" && currentStudentData) {
      loadStudentDashboard(currentStudentData.roll_no);
    } else if (currentUserRole === "faculty") {
      loadFacultyConsole();
      loadActiveSessions();
    }
  }

  if (attendSyncChannel) {
    attendSyncChannel.onmessage = (ev) => {
      if (ev.data && ev.data.type === "SESSION_UPDATE") {
        handleLiveSyncUpdate();
      }
    };
  }

  window.addEventListener("storage", (ev) => {
    if (ev.key === "attendchain_last_sync") {
      handleLiveSyncUpdate();
    }
  });

  window.addEventListener("focus", handleLiveSyncUpdate);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      handleLiveSyncUpdate();
    }
  });

  function updateAuthUI() {
    const academicNavbar = document.getElementById("academicNavbar") || document.querySelector(".academic-navbar");
    const userDropdownWrap = document.getElementById("userDropdownWrap");
    const userCapsule = document.getElementById("userCapsule");
    const capsuleAvatar = document.getElementById("capsuleAvatar");
    const capsuleUserName = document.getElementById("capsuleUserName");
    const capsuleUserRole = document.getElementById("capsuleUserRole");
    const dropdownHeaderName = document.getElementById("dropdownHeaderName");
    const dropdownHeaderSub = document.getElementById("dropdownHeaderSub");
    const dropdownItemProfile = document.getElementById("dropdownItemProfile");
    const dropdownItemSettings = document.getElementById("dropdownItemSettings");
    const dropdownItemConsole = document.getElementById("dropdownItemConsole");
    const dropdownItemConsoleText = document.getElementById("dropdownItemConsoleText");
    const fabJoinClassBtn = document.getElementById("fabJoinClassBtn");

    const tabNavGateway = document.getElementById("tabNavGateway");
    const tabNavStudentClasses = document.getElementById("tabNavStudentClasses");
    const tabNavStudentAttendance = document.getElementById("tabNavStudentAttendance");
    const tabNavStudentProfile = document.getElementById("tabNavStudentProfile");
    const tabNavStudentSettings = document.getElementById("tabNavStudentSettings");
    const tabNavFaculty = document.getElementById("tabNavFaculty");
    const tabNavAdmin = document.getElementById("tabNavAdmin");
    const tabNavKiosk = document.getElementById("tabNavKiosk");
    const tabNavRegister = document.getElementById("tabNavRegister");

    if (currentUserRole === "student" && currentStudentData) {
      if (academicNavbar) academicNavbar.style.display = "block";
      if (userDropdownWrap) userDropdownWrap.style.display = "inline-flex";
      if (userCapsule) userCapsule.style.display = "flex";
      if (capsuleAvatar) {
        capsuleAvatar.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>`;
      }
      const stName = currentStudentData.name || "Student";
      if (capsuleUserName) capsuleUserName.textContent = stName;
      if (capsuleUserRole) {
        capsuleUserRole.textContent = `STUDENT (${currentStudentData.roll_no})`;
        capsuleUserRole.className = "user-role-tag tag-student";
      }
      if (dropdownHeaderName) dropdownHeaderName.textContent = stName;
      if (dropdownHeaderSub) dropdownHeaderSub.textContent = `${currentStudentData.roll_no} • ${currentStudentData.email || "student@college.edu"}`;

      // Student Dropdown Menu Items
      if (dropdownItemProfile) dropdownItemProfile.style.display = "flex";
      if (dropdownItemSettings) dropdownItemSettings.style.display = "flex";
      if (dropdownItemConsole) dropdownItemConsole.style.display = "none";

      if (tabNavGateway) tabNavGateway.style.display = "none";
      if (tabNavStudentClasses) tabNavStudentClasses.style.display = "inline-flex";
      if (tabNavStudentAttendance) tabNavStudentAttendance.style.display = "inline-flex";
      if (tabNavStudentProfile) tabNavStudentProfile.style.display = "none";
      if (tabNavStudentSettings) tabNavStudentSettings.style.display = "none";
      if (tabNavFaculty) tabNavFaculty.style.display = "none";
      if (tabNavAdmin) tabNavAdmin.style.display = "none";
      if (tabNavKiosk) tabNavKiosk.style.display = "none";
      if (tabNavRegister) tabNavRegister.style.display = "none";

      const portalSec = document.getElementById("tab-portal");
      if (fabJoinClassBtn) {
        fabJoinClassBtn.style.display = (!portalSec || portalSec.classList.contains("active")) ? "flex" : "none";
      }

    } else if (currentUserRole === "faculty") {
      if (academicNavbar) academicNavbar.style.display = "block";
      if (userDropdownWrap) userDropdownWrap.style.display = "inline-flex";
      if (userCapsule) userCapsule.style.display = "flex";
      const facName = (currentFacultyData && currentFacultyData.name) ? currentFacultyData.name : "Prof. Dr. Alan Turing";
      if (capsuleAvatar) {
        capsuleAvatar.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
      }
      if (capsuleUserName) capsuleUserName.textContent = facName;
      if (capsuleUserRole) {
        capsuleUserRole.textContent = "Faculty / Staff";
        capsuleUserRole.className = "user-role-tag tag-faculty";
      }
      if (dropdownHeaderName) dropdownHeaderName.textContent = facName;
      if (dropdownHeaderSub) dropdownHeaderSub.textContent = (currentFacultyData && currentFacultyData.email) ? currentFacultyData.email : "faculty@college.edu";

      // Faculty Dropdown Menu Items: strictly course console only, NO student profile/settings
      if (dropdownItemProfile) dropdownItemProfile.style.display = "none";
      if (dropdownItemSettings) dropdownItemSettings.style.display = "none";
      if (dropdownItemConsole) {
        dropdownItemConsole.style.display = "flex";
        if (dropdownItemConsoleText) dropdownItemConsoleText.textContent = "Faculty & Course Console";
      }

      if (tabNavGateway) tabNavGateway.style.display = "none";
      if (tabNavStudentClasses) tabNavStudentClasses.style.display = "none";
      if (tabNavStudentAttendance) tabNavStudentAttendance.style.display = "none";
      if (tabNavStudentProfile) tabNavStudentProfile.style.display = "none";
      if (tabNavStudentSettings) tabNavStudentSettings.style.display = "none";
      if (tabNavFaculty) tabNavFaculty.style.display = "inline-flex";
      if (tabNavAdmin) tabNavAdmin.style.display = "none";
      if (tabNavKiosk) tabNavKiosk.style.display = "none";
      if (tabNavRegister) tabNavRegister.style.display = "none";
      if (fabJoinClassBtn) fabJoinClassBtn.style.display = "none";

    } else if (currentUserRole === "admin") {
      if (academicNavbar) academicNavbar.style.display = "block";
      if (userDropdownWrap) userDropdownWrap.style.display = "inline-flex";
      if (userCapsule) userCapsule.style.display = "flex";
      if (capsuleAvatar) {
        capsuleAvatar.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`;
      }
      if (capsuleUserName) capsuleUserName.textContent = "Central University Admin";
      if (capsuleUserRole) {
        capsuleUserRole.textContent = "University Admin";
        capsuleUserRole.className = "user-role-tag tag-admin";
      }
      if (dropdownHeaderName) dropdownHeaderName.textContent = "Central University Admin";
      if (dropdownHeaderSub) dropdownHeaderSub.textContent = "admin@attendchain.edu";

      // Admin Dropdown Menu Items: strictly admin console only, NO student profile/settings
      if (dropdownItemProfile) dropdownItemProfile.style.display = "none";
      if (dropdownItemSettings) dropdownItemSettings.style.display = "none";
      if (dropdownItemConsole) {
        dropdownItemConsole.style.display = "flex";
        if (dropdownItemConsoleText) dropdownItemConsoleText.textContent = "Central Admin Console";
      }

      if (tabNavGateway) tabNavGateway.style.display = "none";
      if (tabNavStudentClasses) tabNavStudentClasses.style.display = "none";
      if (tabNavStudentAttendance) tabNavStudentAttendance.style.display = "none";
      if (tabNavStudentProfile) tabNavStudentProfile.style.display = "none";
      if (tabNavStudentSettings) tabNavStudentSettings.style.display = "none";
      if (tabNavFaculty) tabNavFaculty.style.display = "none";
      if (tabNavAdmin) tabNavAdmin.style.display = "inline-flex";
      if (tabNavKiosk) tabNavKiosk.style.display = "none";
      if (tabNavRegister) tabNavRegister.style.display = "none";
      if (fabJoinClassBtn) fabJoinClassBtn.style.display = "none";

    } else {
      // Guest - hide capsule and navbar completely for a totally clean welcome page
      if (academicNavbar) academicNavbar.style.display = "none";
      if (userDropdownWrap) userDropdownWrap.style.display = "none";
      if (userCapsule) userCapsule.style.display = "none";
      if (dropdownItemProfile) dropdownItemProfile.style.display = "none";
      if (dropdownItemSettings) dropdownItemSettings.style.display = "none";
      if (dropdownItemConsole) dropdownItemConsole.style.display = "none";

      if (tabNavGateway) tabNavGateway.style.display = "none";
      if (tabNavStudentClasses) tabNavStudentClasses.style.display = "none";
      if (tabNavStudentAttendance) tabNavStudentAttendance.style.display = "none";
      if (tabNavStudentProfile) tabNavStudentProfile.style.display = "none";
      if (tabNavStudentSettings) tabNavStudentSettings.style.display = "none";
      if (tabNavFaculty) tabNavFaculty.style.display = "none";
      if (tabNavAdmin) tabNavAdmin.style.display = "none";
      if (tabNavKiosk) tabNavKiosk.style.display = "none";
      if (tabNavRegister) tabNavRegister.style.display = "none";
      if (fabJoinClassBtn) fabJoinClassBtn.style.display = "none";
    }
  }

  function logoutUser() {
    playSound("click");
    sessionStorage.removeItem("attendchain_user_role");
    sessionStorage.removeItem("attendchain_student_data");
    sessionStorage.removeItem("attendchain_faculty_data");
    sessionStorage.removeItem("attendchain_admin_data");
    sessionStorage.removeItem("attendchain_admin_token");
    currentUserRole = "guest";
    currentStudentData = null;
    currentFacultyData = null;
    currentAdminData = null;
    updateAuthUI();
    switchTab("tab-gateway");
  }

  if (document.getElementById("logoutBtn")) {
    document.getElementById("logoutBtn").addEventListener("click", () => {
      toggleUserDropdown(false);
      logoutUser();
    });
  }
  if (document.getElementById("settingsLogoutBtn")) {
    document.getElementById("settingsLogoutBtn").addEventListener("click", logoutUser);
  }

  // Top-Right User Profile Dropdown Menu Handlers
  const userCapsule = document.getElementById("userCapsule");
  const userDropdownWrap = document.getElementById("userDropdownWrap");
  const userDropdownMenu = document.getElementById("userDropdownMenu");
  const dropdownItemProfile = document.getElementById("dropdownItemProfile");
  const dropdownItemSettings = document.getElementById("dropdownItemSettings");
  const dropdownItemConsole = document.getElementById("dropdownItemConsole");

  function toggleUserDropdown(forceOpen) {
    if (!userDropdownMenu || !userDropdownWrap) return;
    const isOpen = userDropdownWrap.classList.contains("open");
    const nextState = forceOpen !== undefined ? forceOpen : !isOpen;
    if (nextState) {
      userDropdownWrap.classList.add("open");
      userDropdownMenu.classList.remove("hidden");
      if (userCapsule) userCapsule.setAttribute("aria-expanded", "true");
    } else {
      userDropdownWrap.classList.remove("open");
      userDropdownMenu.classList.add("hidden");
      if (userCapsule) userCapsule.setAttribute("aria-expanded", "false");
    }
  }

  if (userCapsule) {
    userCapsule.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleUserDropdown();
    });
  }

  if (dropdownItemConsole) {
    dropdownItemConsole.addEventListener("click", () => {
      toggleUserDropdown(false);
      if (currentUserRole === "admin") {
        switchTab("tab-superadmin");
      } else {
        switchTab("tab-admin");
      }
    });
  }

  if (dropdownItemProfile) {
    dropdownItemProfile.addEventListener("click", () => {
      toggleUserDropdown(false);
      if (currentUserRole === "student") {
        switchTab("tab-student-profile");
      }
    });
  }

  if (dropdownItemSettings) {
    dropdownItemSettings.addEventListener("click", () => {
      toggleUserDropdown(false);
      if (currentUserRole === "student") {
        switchTab("tab-student-settings");
      }
    });
  }

  // Close dropdown on click outside
  document.addEventListener("click", (e) => {
    if (userDropdownWrap && !userDropdownWrap.contains(e.target)) {
      toggleUserDropdown(false);
    }
  });

  // Floating Action Button (+) & Join Class Modal Handlers
  function openJoinClassModal() {
    playSound("click");
    const modal = document.getElementById("joinClassModal");
    const input = document.getElementById("modalInviteCodeInput");
    const alertBox = document.getElementById("modalJoinAlert");
    if (modal) {
      modal.classList.remove("hidden");
      if (input) {
        input.value = "";
        setTimeout(() => input.focus(), 60);
      }
      if (alertBox) {
        alertBox.classList.add("hidden");
        alertBox.textContent = "";
      }
    }
  }

  function closeJoinClassModal() {
    const modal = document.getElementById("joinClassModal");
    if (modal) {
      modal.classList.add("hidden");
    }
  }

  // Expose to window for inline onclick handlers as well
  window.openJoinClassModal = openJoinClassModal;
  window.closeJoinClassModal = closeJoinClassModal;

  const fabJoinClassBtn = document.getElementById("fabJoinClassBtn");
  if (fabJoinClassBtn) {
    fabJoinClassBtn.addEventListener("click", openJoinClassModal);
  }

  const closeJoinClassModalBtn = document.getElementById("closeJoinClassModalBtn");
  if (closeJoinClassModalBtn) {
    closeJoinClassModalBtn.addEventListener("click", closeJoinClassModal);
  }

  const cancelJoinClassModalBtn = document.getElementById("cancelJoinClassModalBtn");
  if (cancelJoinClassModalBtn) {
    cancelJoinClassModalBtn.addEventListener("click", closeJoinClassModal);
  }

  const joinClassModal = document.getElementById("joinClassModal");
  if (joinClassModal) {
    joinClassModal.addEventListener("click", (e) => {
      if (e.target === joinClassModal) closeJoinClassModal();
    });
  }

  // Quick code chip clicks inside modal
  document.querySelectorAll(".quick-code-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const code = chip.dataset.code || chip.textContent.trim();
      const input = document.getElementById("modalInviteCodeInput");
      if (input) input.value = code;
    });
  });

  async function handleModalJoinGroup() {
    const input = document.getElementById("modalInviteCodeInput");
    const alertBox = document.getElementById("modalJoinAlert");
    const code = input ? input.value.trim().toUpperCase() : "";
    if (!code) {
      if (alertBox) {
        alertBox.className = "alert-callout-box error";
        alertBox.classList.remove("hidden");
        alertBox.textContent = "Please enter a valid Course Invite Code (e.g. CS402-V9M).";
      }
      return;
    }
    if (!currentStudentData || !currentStudentData.roll_no) {
      if (alertBox) {
        alertBox.className = "alert-callout-box error";
        alertBox.classList.remove("hidden");
        alertBox.textContent = "Student profile not active. Please sign in again.";
      }
      return;
    }

    if (alertBox) {
      alertBox.className = "alert-callout-box";
      alertBox.style.background = "var(--bg-subtle)";
      alertBox.style.color = "var(--text-main)";
      alertBox.classList.remove("hidden");
      alertBox.textContent = `Validating invite code '${code}'...`;
    }

    const { ok, status, data } = await safeFetchJson("/api/student/join-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roll_no: currentStudentData.roll_no,
        invite_code: code
      })
    });

    if (ok && data.ok) {
      playSound("success");
      if (alertBox) {
        alertBox.className = "alert-callout-box";
        alertBox.style.background = "rgba(16, 185, 129, 0.12)";
        alertBox.style.color = "#059669";
        alertBox.textContent = data.message || `Successfully joined course ${code}!`;
      }
      setTimeout(() => {
        closeJoinClassModal();
        loadStudentDashboard(currentStudentData.roll_no);
      }, 1000);
    } else {
      playSound("error");
      if (alertBox) {
        alertBox.className = "alert-callout-box error";
        alertBox.style.background = "rgba(239, 68, 68, 0.12)";
        alertBox.style.color = "#dc2626";
        alertBox.classList.remove("hidden");
        alertBox.textContent = data.error || "Failed to join course. Please verify the invite code.";
      }
    }
  }

  const submitJoinClassModalBtn = document.getElementById("submitJoinClassModalBtn");
  if (submitJoinClassModalBtn) {
    submitJoinClassModalBtn.addEventListener("click", handleModalJoinGroup);
  }
  const modalInviteCodeInput = document.getElementById("modalInviteCodeInput");
  if (modalInviteCodeInput) {
    modalInviteCodeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleModalJoinGroup();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      toggleUserDropdown(false);
      closeJoinClassModal();
    }
  });

  // --- Tab Navigation ---
  function switchTab(targetId) {
    // Role guard: Ensure strict console isolation for each role
    if (currentUserRole === "student") {
      const staffTabs = ["tab-admin", "tab-superadmin"];
      if (staffTabs.includes(targetId)) targetId = "tab-portal";
    } else if (currentUserRole === "faculty") {
      const nonFacultyTabs = ["tab-student-profile", "tab-student-attendance", "tab-portal", "tab-student-settings", "tab-superadmin"];
      if (nonFacultyTabs.includes(targetId)) targetId = "tab-admin";
    } else if (currentUserRole === "admin") {
      const nonAdminTabs = ["tab-student-profile", "tab-student-attendance", "tab-portal", "tab-student-settings", "tab-admin"];
      if (nonAdminTabs.includes(targetId)) targetId = "tab-superadmin";
    }

    const navTabs = document.querySelectorAll(".academic-tab-btn, .nav-tab");
    navTabs.forEach(t => {
      if (t.dataset.tab === targetId) t.classList.add("active");
      else t.classList.remove("active");
    });
    document.querySelectorAll(".portal-section, .tab-section").forEach(s => s.classList.remove("active"));
    const targetSection = document.getElementById(targetId);
    if (targetSection) targetSection.classList.add("active");

    if (targetId === "tab-admin") {
      loadFacultyConsole();
      loadAdminData();
    } else if (targetId === "tab-superadmin") {
      loadAdminConsole();
    } else if (targetId === "tab-portal") {
      if (currentStudentData) {
        loadStudentDashboard(currentStudentData.roll_no);
      }
    } else if (targetId === "tab-student-attendance") {
      if (currentStudentData) {
        loadStudentDashboard(currentStudentData.roll_no);
      }
    } else if (targetId === "tab-student-profile") {
      if (currentUserRole === "student") {
        loadStudentProfile();
      }
    } else if (targetId === "tab-student-settings") {
      // settings ready
    }

    const fab = document.getElementById("fabJoinClassBtn");
    if (fab) {
      fab.style.display = (targetId === "tab-portal" && currentUserRole === "student") ? "flex" : "none";
    }
  }

  document.querySelectorAll(".academic-tab-btn, .nav-tab").forEach(tab => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // =========================================================================
  // UNIFIED GATEWAY: SIGN IN & STUDENT REGISTRATION
  // =========================================================================

  // Mode Switch: Sign In vs Create Student Account
  const gatewayTabSignInBtn = document.getElementById("gatewayTabSignInBtn");
  const gatewayTabSignUpBtn = document.getElementById("gatewayTabSignUpBtn");
  const unifiedSignInBox = document.getElementById("unifiedSignInBox");
  const unifiedSignUpBox = document.getElementById("unifiedSignUpBox");

  function setGatewayMode(mode) {
    playSound("click");
    if (mode === "signin") {
      if (gatewayTabSignInBtn) gatewayTabSignInBtn.classList.add("active");
      if (gatewayTabSignUpBtn) gatewayTabSignUpBtn.classList.remove("active");
      if (unifiedSignInBox) unifiedSignInBox.style.display = "block";
      if (unifiedSignUpBox) unifiedSignUpBox.style.display = "none";
    } else {
      if (gatewayTabSignInBtn) gatewayTabSignInBtn.classList.remove("active");
      if (gatewayTabSignUpBtn) gatewayTabSignUpBtn.classList.add("active");
      if (unifiedSignInBox) unifiedSignInBox.style.display = "none";
      if (unifiedSignUpBox) unifiedSignUpBox.style.display = "block";
    }
  }

  if (gatewayTabSignInBtn) {
    gatewayTabSignInBtn.addEventListener("click", () => setGatewayMode("signin"));
  }
  if (gatewayTabSignUpBtn) {
    gatewayTabSignUpBtn.addEventListener("click", () => setGatewayMode("signup"));
  }

  const linkToSignUp = document.getElementById("linkToSignUp");
  if (linkToSignUp) {
    linkToSignUp.addEventListener("click", (e) => {
      e.preventDefault();
      setGatewayMode("signup");
    });
  }
  const linkToSignIn = document.getElementById("linkToSignIn");
  if (linkToSignIn) {
    linkToSignIn.addEventListener("click", (e) => {
      e.preventDefault();
      setGatewayMode("signin");
    });
  }

  // Quick Demo Buttons
  const quickDemoStudentBtn = document.getElementById("quickDemoStudentBtn");
  const quickDemoFacultyBtn = document.getElementById("quickDemoFacultyBtn");
  const quickDemoAdminBtn = document.getElementById("quickDemoAdminBtn");
  const unifiedLoginId = document.getElementById("unifiedLoginId");
  const unifiedLoginPass = document.getElementById("unifiedLoginPass");
  const unifiedLoginSubmitBtn = document.getElementById("unifiedLoginSubmitBtn");
  const unifiedLoginAlert = document.getElementById("unifiedLoginAlert");

  if (quickDemoStudentBtn) {
    quickDemoStudentBtn.addEventListener("click", () => {
      playSound("click");
      if (unifiedLoginId) unifiedLoginId.value = "STU-250";
      if (unifiedLoginPass) unifiedLoginPass.value = "student123";
      handleUnifiedLogin("STU-250", "student123");
    });
  }

  if (quickDemoFacultyBtn) {
    quickDemoFacultyBtn.addEventListener("click", () => {
      playSound("click");
      if (unifiedLoginId) unifiedLoginId.value = "faculty@college.edu";
      if (unifiedLoginPass) unifiedLoginPass.value = "faculty123";
      handleUnifiedLogin("faculty@college.edu", "faculty123");
    });
  }

  if (quickDemoAdminBtn) {
    quickDemoAdminBtn.addEventListener("click", () => {
      playSound("click");
      if (unifiedLoginId) unifiedLoginId.value = "admin@attendchain.edu";
      if (unifiedLoginPass) unifiedLoginPass.value = "Admin@AttendChain2026";
      handleUnifiedLogin("admin@attendchain.edu", "Admin@AttendChain2026");
    });
  }

  // Unified Sign In Handler
  async function handleUnifiedLogin(loginId, password) {
    const id = loginId || (unifiedLoginId ? unifiedLoginId.value.trim() : "");
    const pass = password || (unifiedLoginPass ? unifiedLoginPass.value.trim() : "");

    if (!id || !pass) {
      if (unifiedLoginAlert) {
        unifiedLoginAlert.classList.remove("hidden");
        unifiedLoginAlert.textContent = "Please enter both Email/Student ID and Password.";
      }
      return;
    }

    if (unifiedLoginAlert) {
      unifiedLoginAlert.classList.remove("hidden");
      unifiedLoginAlert.className = "alert-callout-box";
      unifiedLoginAlert.style.background = "var(--bg-subtle)";
      unifiedLoginAlert.style.color = "var(--text-main)";
      unifiedLoginAlert.textContent = "Authenticating with university registry...";
    }

    const { ok, status, data } = await safeFetchJson("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login_id: id, password: pass })
    });

    if (ok && data.ok) {
      playSound("success");
      const role = data.role; // 'student', 'faculty', 'admin'
      currentUserRole = role;
      sessionStorage.setItem("attendchain_user_role", role);

      if (unifiedLoginAlert) unifiedLoginAlert.classList.add("hidden");

      if (role === "student") {
        currentStudentData = data.student;
        currentFacultyData = null;
        currentAdminData = null;
        sessionStorage.removeItem("attendchain_faculty_data");
        sessionStorage.removeItem("attendchain_admin_data");
        sessionStorage.removeItem("attendchain_admin_token");
        sessionStorage.setItem("attendchain_student_data", JSON.stringify(data.student));
        updateAuthUI();
        loadStudentDashboard(data.student.roll_no);
        switchTab("tab-portal");
      } else if (role === "faculty") {
        currentStudentData = null;
        currentAdminData = null;
        sessionStorage.removeItem("attendchain_student_data");
        sessionStorage.removeItem("attendchain_admin_data");
        sessionStorage.removeItem("attendchain_admin_token");
        currentFacultyData = data.faculty || data.user;
        sessionStorage.setItem("attendchain_faculty_data", JSON.stringify(currentFacultyData));
        updateAuthUI();
        loadFacultyConsole();
        switchTab("tab-admin");
      } else if (role === "admin") {
        currentStudentData = null;
        currentFacultyData = null;
        sessionStorage.removeItem("attendchain_student_data");
        sessionStorage.removeItem("attendchain_faculty_data");
        currentAdminData = data.admin || data.user;
        sessionStorage.setItem("attendchain_admin_data", JSON.stringify(currentAdminData));
        if (data.token) sessionStorage.setItem("attendchain_admin_token", data.token);
        updateAuthUI();
        loadAdminConsole();
        switchTab("tab-superadmin");
      }
    } else {
      playSound("error");
      if (unifiedLoginAlert) {
        unifiedLoginAlert.classList.remove("hidden");
        unifiedLoginAlert.className = "alert-callout-box error";
        unifiedLoginAlert.style.background = "rgba(239, 68, 68, 0.12)";
        unifiedLoginAlert.style.color = "#dc2626";
        unifiedLoginAlert.textContent = data.error || "Authentication failed. Please verify your credentials.";
      }
    }
  }

  if (unifiedLoginSubmitBtn) {
    unifiedLoginSubmitBtn.addEventListener("click", () => handleUnifiedLogin());
  }
  if (unifiedLoginId) {
    unifiedLoginId.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleUnifiedLogin();
    });
  }
  if (unifiedLoginPass) {
    unifiedLoginPass.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleUnifiedLogin();
    });
  }

  // Student Registration (Sign Up) Handler
  const signupName = document.getElementById("signupName");
  const signupEmail = document.getElementById("signupEmail");
  const signupPass = document.getElementById("signupPass");
  const signupPassConfirm = document.getElementById("signupPassConfirm");
  const signupSubmitBtn = document.getElementById("signupSubmitBtn");
  const signupAlert = document.getElementById("signupAlert");

  async function handleStudentSignup() {
    const name = signupName ? signupName.value.trim() : "";
    const email = signupEmail ? signupEmail.value.trim() : "";
    const pass = signupPass ? signupPass.value.trim() : "";
    const confirm = signupPassConfirm ? signupPassConfirm.value.trim() : "";

    if (!name || !email || !pass) {
      if (signupAlert) {
        signupAlert.classList.remove("hidden");
        signupAlert.className = "alert-callout-box error";
        signupAlert.textContent = "Please fill in all registration fields.";
      }
      return;
    }
    if (pass !== confirm) {
      if (signupAlert) {
        signupAlert.classList.remove("hidden");
        signupAlert.className = "alert-callout-box error";
        signupAlert.textContent = "Passwords do not match. Please verify.";
      }
      return;
    }
    if (pass.length < 6) {
      if (signupAlert) {
        signupAlert.classList.remove("hidden");
        signupAlert.className = "alert-callout-box error";
        signupAlert.textContent = "Password must be at least 6 characters long.";
      }
      return;
    }

    if (signupAlert) {
      signupAlert.classList.remove("hidden");
      signupAlert.className = "alert-callout-box";
      signupAlert.style.background = "var(--bg-subtle)";
      signupAlert.style.color = "var(--text-main)";
      signupAlert.textContent = "Creating student profile and allotting University ID...";
    }

    const { ok, data } = await safeFetchJson("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password: pass })
    });

    if (ok && data.ok) {
      playSound("success");
      const allottedRoll = data.student.roll_no;
      if (signupAlert) {
        signupAlert.className = "alert-callout-box";
        signupAlert.style.background = "rgba(16, 185, 129, 0.12)";
        signupAlert.style.color = "#059669";
        signupAlert.innerHTML = `<strong>Registration Successful!</strong> Your allotted Student ID is <strong>${allottedRoll}</strong>. Signing in...`;
      }

      // Auto-login newly created student
      setTimeout(() => {
        currentUserRole = "student";
        currentStudentData = data.student;
        sessionStorage.setItem("attendchain_user_role", "student");
        sessionStorage.setItem("attendchain_student_data", JSON.stringify(data.student));
        updateAuthUI();
        loadStudentDashboard(allottedRoll);
        switchTab("tab-portal");
      }, 1200);
    } else {
      playSound("error");
      if (signupAlert) {
        signupAlert.className = "alert-callout-box error";
        signupAlert.textContent = data.error || "Registration failed. Please check your details.";
      }
    }
  }

  if (signupSubmitBtn) {
    signupSubmitBtn.addEventListener("click", handleStudentSignup);
  }

  // --- Live Status Self-Check ---
  async function fetchHealth() {
    try {
      const { ok, data: d } = await safeFetchJson("/api/health");
      if (!ok) throw new Error(d.error || "Health check failed");

      registeredStudentCount = d.student_count || 0;
      const enrolledBadge = document.getElementById("enrolledStudentCountBadge");
      if (enrolledBadge) enrolledBadge.textContent = registeredStudentCount;

      const noStudentsCallout = document.getElementById("noStudentsCallout");
      if (noStudentsCallout) {
        if (registeredStudentCount === 0) {
          noStudentsCallout.classList.remove("hidden");
        } else {
          noStudentsCallout.classList.add("hidden");
        }
      }

      const dbBadgeEl = document.getElementById("dbBadgeText");
      if (dbBadgeEl) {
        if (d.database_type === "mongodb") {
          dbBadgeEl.textContent = "MongoDB Atlas";
          dbBadgeEl.style.color = "#10b981";
        } else {
          dbBadgeEl.textContent = "SQLite DB";
          dbBadgeEl.style.color = "var(--text-muted)";
        }
      }

      const chainModeEl = document.getElementById("chainModeText");
      if (chainModeEl) chainModeEl.textContent = (d.chain_mode || "MOCK").toUpperCase();
      const networkEl = document.getElementById("networkText");
      if (networkEl) networkEl.textContent = `${d.network || "Hedera"} (${d.chain_id || 296})`;

      const contractLink = document.getElementById("contractAddressLink");
      if (d.contract_address) {
        contractLink.textContent = shorten(d.contract_address, 4);
        contractLink.href = `https://hashscan.io/testnet/contract/${d.contract_address}`;
      } else {
        contractLink.textContent = "Contract: Not Set";
        contractLink.removeAttribute("href");
      }

      const aiModelEl = document.getElementById("aiModelText");
      if (aiModelEl) aiModelEl.textContent = d.models_ready ? "YuNet + SFace (ONNX)" : "Mock Face Engine";

    } catch (e) {
      const cmEl = document.getElementById("chainModeText");
      if (cmEl) cmEl.textContent = "DISCONNECTED";
      const nwEl = document.getElementById("networkText");
      if (nwEl) nwEl.textContent = "Offline";
    }
  }

  // --- Camera Management ---
  async function startCamera(videoEl, standbyEl) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false
      });
      videoEl.srcObject = stream;
      if (standbyEl) standbyEl.classList.add("hidden");
      return stream;
    } catch (err) {
      alert("Camera Permission Denied: Unable to access webcam. Please allow camera permissions in your browser.\nError: " + err.message);
      return null;
    }
  }

  function stopCamera(stream, videoEl, standbyEl) {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
    }
    if (videoEl) videoEl.srcObject = null;
    if (standbyEl) standbyEl.classList.remove("hidden");
    return null;
  }

  // =========================================================================
  // TAB 1: ATTENDANCE KIOSK (Real-Time Face Tracking & Attendance)
  // =========================================================================
  const kioskVideo = document.getElementById("kioskVideo");
  const hudCanvas = document.getElementById("hudCanvas");
  const hiddenCaptureCanvas = document.getElementById("hiddenCaptureCanvas");
  const cameraStandby = document.getElementById("cameraStandby");
  const startCamBtn = document.getElementById("startCamBtn");
  const kioskSessionSelect = document.getElementById("kioskSessionSelect");
  const triggerAttendanceBtn = document.getElementById("triggerAttendanceBtn");
  const autoMarkToggle = document.getElementById("autoMarkToggle");
  const cameraStateText = document.getElementById("cameraStateText");
  const cameraStatePill = document.getElementById("cameraStatePill");
  const burstProgressContainer = document.getElementById("burstProgressContainer");
  const burstProgressFill = document.getElementById("burstProgressFill");
  const burstPercentText = document.getElementById("burstPercentText");
  const kioskResultContainer = document.getElementById("kioskResultContainer");
  const kioskPresentCount = document.getElementById("kioskPresentCount") || document.getElementById("kioskPresentCountBadge") || { textContent: "" };
  const kioskSessionSubject = document.getElementById("kioskSessionSubject") || { textContent: "" };
  const kioskCountdown = document.getElementById("kioskCountdown") || { textContent: "" };
  const feedItemsList = document.getElementById("feedItemsList") || { prepend() { }, innerHTML: "" };
  const emptyFeedPlaceholder = document.getElementById("feedEmptyState") || document.getElementById("emptyFeedPlaceholder") || { classList: { add() { }, remove() { } } };
  const feedCounterBadge = document.getElementById("kioskPresentCountBadge") || document.getElementById("feedCounterBadge") || { textContent: "" };
  const hudFaceCountChip = document.getElementById("hudFaceCountChip");
  const hudDistanceChip = document.getElementById("hudDistanceChip");
  const hudBlinkChip = document.getElementById("hudBlinkChip");
  const blinkPromptOverlay = document.getElementById("blinkPromptOverlay");

  if (startCamBtn) startCamBtn.addEventListener("click", async () => {
    if (markStream) {
      markStream = stopCamera(markStream, kioskVideo, cameraStandby);
      isTracking = false;
      startCamBtn.textContent = "Start Camera";
      cameraStateText.textContent = "Camera Paused";
      cameraStatePill.style.borderColor = "var(--border-subtle)";
      updateTriggerBtnState();
    } else {
      markStream = await startCamera(kioskVideo, cameraStandby);
      if (markStream) {
        startCamBtn.textContent = "Pause Camera";
        cameraStateText.textContent = "Tracking Active";
        cameraStatePill.style.borderColor = "var(--accent-success)";
        isTracking = true;
        updateTriggerBtnState();
        requestAnimationFrame(renderTrackingHUD);
      }
    }
  });

  function updateTriggerBtnState() {
    const hasSession = kioskSessionSelect.value !== "";
    const hasCam = markStream !== null;
    triggerAttendanceBtn.disabled = !hasSession || !hasCam || isCapturing;
  }

  if (kioskSessionSelect) kioskSessionSelect.addEventListener("change", () => {
    const sessId = parseInt(kioskSessionSelect.value);
    currentActiveSession = activeSessions.find(s => s.session_id === sessId) || null;
    updateSessionWidget();
    updateTriggerBtnState();
  });

  function updateSessionWidget() {
    if (!currentActiveSession) {
      if (kioskPresentCount) kioskPresentCount.textContent = "0";
      if (kioskSessionSubject) kioskSessionSubject.textContent = "No Active Session";
      if (kioskCountdown) kioskCountdown.textContent = "--:--";
      if (sessionCountdownTimer) clearInterval(sessionCountdownTimer);
      return;
    }

    if (kioskSessionSubject) kioskSessionSubject.textContent = currentActiveSession.subject;
    if (sessionCountdownTimer) clearInterval(sessionCountdownTimer);
    updateCountdownText();
    sessionCountdownTimer = setInterval(updateCountdownText, 1000);
  }

  function updateCountdownText() {
    if (!currentActiveSession) return;
    const now = Math.floor(Date.now() / 1000);
    const remaining = Math.max(0, currentActiveSession.end_time - now);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    kioskCountdown.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    if (remaining === 0) {
      kioskCountdown.textContent = "EXPIRED";
      clearInterval(sessionCountdownTimer);
      loadActiveSessions();
    }
  }

  async function loadActiveSessions() {
    try {
      const { ok, data } = await safeFetchJson("/api/sessions?active=1");
      activeSessions = (data && data.sessions) || [];

      document.getElementById("activeSessionCountBadge").textContent = activeSessions.length;

      if (activeSessions.length === 0) {
        kioskSessionSelect.innerHTML = '<option value="">No Active Sessions (Open one in Faculty tab)</option>';
        currentActiveSession = null;
      } else {
        kioskSessionSelect.innerHTML = '<option value="">-- Select Active Course Session --</option>' +
          activeSessions.map(s => `<option value="${s.session_id}">#${s.session_id} • ${escapeHtml(s.subject)} (Closes in ${Math.max(0, Math.round((s.end_time - Date.now() / 1000) / 60))}m)</option>`).join("");

        if (!currentActiveSession && activeSessions.length > 0) {
          kioskSessionSelect.value = activeSessions[0].session_id;
          currentActiveSession = activeSessions[0];
        }
      }
      updateSessionWidget();
    } catch (e) {
      kioskSessionSelect.innerHTML = '<option value="">Failed to load sessions</option>';
    }
    updateTriggerBtnState();
  }

  // --- Real-Time Face Tracking & HUD Drawing Loop ---
  let backendTrackPending = false;
  let detectedLandmarks = [];
  let isFaceOptimal = false;

  async function detectFaceFrame() {
    if (!isTracking || !kioskVideo.videoWidth || backendTrackPending) return;

    if (nativeFaceDetector) {
      try {
        const detectedFaces = await nativeFaceDetector.detect(kioskVideo);
        if (detectedFaces && detectedFaces.length > 0) {
          const primary = detectedFaces[0].boundingBox;
          const vw = kioskVideo.videoWidth;
          const mirroredX = vw - primary.x - primary.width;

          targetBox = {
            x: mirroredX,
            y: primary.y,
            w: primary.width,
            h: primary.height,
            faceCount: detectedFaces.length
          };
          updateHudChips(detectedFaces.length, primary.width);
          return;
        } else {
          targetBox = null;
          updateHudChips(0, 0);
          return;
        }
      } catch (e) {
        // Fallback
      }
    }

    // Backend YuNet Tracking Ping
    backendTrackPending = true;
    try {
      const snapCanvas = document.createElement("canvas");
      snapCanvas.width = 320;
      snapCanvas.height = 240;
      const ctx = snapCanvas.getContext("2d");
      ctx.drawImage(kioskVideo, 0, 0, 320, 240);
      const b64 = snapCanvas.toDataURL("image/jpeg", 0.6);

      const { ok, data } = await safeFetchJson("/api/face/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frame: b64 })
      });

      if (ok && data && data.detected && data.box) {
        const scaleX = (kioskVideo.videoWidth || 640) / 320;
        const scaleY = (kioskVideo.videoHeight || 480) / 240;
        const rawX = data.box[0] * scaleX;
        const rawY = data.box[1] * scaleY;
        const rawW = data.box[2] * scaleX;
        const rawH = data.box[3] * scaleY;

        const totalW = kioskVideo.videoWidth || 640;
        const mirroredX = totalW - rawX - rawW;

        targetBox = {
          x: mirroredX,
          y: rawY,
          w: rawW,
          h: rawH,
          faceCount: data.face_count
        };

        if (data.landmarks) {
          detectedLandmarks = data.landmarks.map(pt => [
            totalW - (pt[0] * scaleX),
            pt[1] * scaleY
          ]);
        }
        updateHudChips(data.face_count, rawW);
      } else {
        targetBox = null;
        detectedLandmarks = [];
        updateHudChips(0, 0);
      }
    } catch (e) {
      // Ignore
    } finally {
      backendTrackPending = false;
    }
  }

  function updateHudChips(faceCount, faceWidth) {
    hudFaceCountChip.textContent = `Faces: ${faceCount}`;
    if (faceCount === 1) {
      isFaceOptimal = faceWidth >= 60;
      hudDistanceChip.textContent = `Size: ${Math.round(faceWidth)}px (${isFaceOptimal ? 'Optimal' : 'Move Closer'})`;
      hudDistanceChip.style.color = isFaceOptimal ? 'var(--accent-success)' : 'var(--accent-warning)';
    } else if (faceCount > 1) {
      isFaceOptimal = false;
      hudDistanceChip.textContent = 'Multiple Faces';
      hudDistanceChip.style.color = 'var(--accent-danger)';
    } else {
      isFaceOptimal = false;
      hudDistanceChip.textContent = 'Searching...';
      hudDistanceChip.style.color = 'var(--text-muted)';
    }
  }

  setInterval(detectFaceFrame, 180);

  function renderTrackingHUD() {
    if (!isTracking) return;

    const ctx = hudCanvas.getContext("2d");
    const width = hudCanvas.width;
    const height = hudCanvas.height;
    ctx.clearRect(0, 0, width, height);

    if (kioskVideo.videoWidth && hudCanvas.width !== kioskVideo.videoWidth) {
      hudCanvas.width = kioskVideo.videoWidth;
      hudCanvas.height = kioskVideo.videoHeight;
    }

    if (targetBox) {
      if (!currentBox) {
        currentBox = { ...targetBox };
      } else {
        const factor = 0.35;
        currentBox.x += (targetBox.x - currentBox.x) * factor;
        currentBox.y += (targetBox.y - currentBox.y) * factor;
        currentBox.w += (targetBox.w - currentBox.w) * factor;
        currentBox.h += (targetBox.h - currentBox.h) * factor;
        currentBox.faceCount = targetBox.faceCount;
      }
    } else {
      currentBox = null;
    }

    if (currentBox && !isCapturing) {
      const bx = currentBox.x;
      const by = currentBox.y;
      const bw = currentBox.w;
      const bh = currentBox.h;

      let hudColor = "#10b981";
      if (currentBox.faceCount > 1) {
        hudColor = "#ef4444";
      } else if (!isFaceOptimal) {
        hudColor = "#f59e0b";
      }

      const cornerLen = Math.min(26, bw * 0.25);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = hudColor;
      ctx.lineCap = "round";

      // Corners
      ctx.beginPath();
      ctx.moveTo(bx, by + cornerLen);
      ctx.lineTo(bx, by);
      ctx.lineTo(bx + cornerLen, by);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(bx + bw - cornerLen, by);
      ctx.lineTo(bx + bw, by);
      ctx.lineTo(bx + bw, by + cornerLen);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(bx, by + bh - cornerLen);
      ctx.lineTo(bx, by + bh);
      ctx.lineTo(bx + cornerLen, by + bh);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(bx + bw - cornerLen, by + bh);
      ctx.lineTo(bx + bw, by + bh);
      ctx.lineTo(bx + bw, by + bh - cornerLen);
      ctx.stroke();

      // Scanning beam
      const scanY = by + (Math.sin(Date.now() / 250) * 0.5 + 0.5) * bh;
      const scanGrad = ctx.createLinearGradient(bx, scanY, bx + bw, scanY);
      scanGrad.addColorStop(0, "rgba(59, 130, 246, 0)");
      scanGrad.addColorStop(0.5, "rgba(59, 130, 246, 0.65)");
      scanGrad.addColorStop(1, "rgba(59, 130, 246, 0)");

      ctx.lineWidth = 2;
      ctx.strokeStyle = scanGrad;
      ctx.beginPath();
      ctx.moveTo(bx + 4, scanY);
      ctx.lineTo(bx + bw - 4, scanY);
      ctx.stroke();

      // Landmarks
      if (detectedLandmarks.length > 0) {
        ctx.fillStyle = "rgba(6, 182, 212, 0.85)";
        detectedLandmarks.forEach(pt => {
          ctx.beginPath();
          ctx.arc(pt[0], pt[1], 3, 0, Math.PI * 2);
          ctx.fill();
        });
      }

      // Tag
      const labelText = currentBox.faceCount > 1
        ? "MULTIPLE FACES DETECTED"
        : (isFaceOptimal ? "FACE LOCKED • READY" : "MOVE CLOSER");

      ctx.font = "bold 12px 'Plus Jakarta Sans', sans-serif";
      const textWidth = ctx.measureText(labelText).width;
      const pad = 16;
      const tagH = 24;
      const tagX = bx + (bw - textWidth - pad) / 2;
      const tagY = Math.max(10, by - tagH - 6);

      ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
      ctx.beginPath();
      ctx.roundRect(tagX, tagY, textWidth + pad, tagH, 6);
      ctx.fill();
      ctx.strokeStyle = hudColor;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = hudColor;
      ctx.fillText(labelText, tagX + pad / 2, tagY + 16);

      handleAutoMarkCheck();

    } else if (!isCapturing) {
      faceLockedFrames = 0;
      const cx = width / 2;
      const cy = height / 2;
      const rx = width * 0.18;
      const ry = height * 0.32;

      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 8]);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    requestAnimationFrame(renderTrackingHUD);
  }

  function handleAutoMarkCheck() {
    if (!autoMarkToggle.checked || isCapturing || !currentActiveSession) return;

    if (isFaceOptimal && currentBox && currentBox.faceCount === 1) {
      faceLockedFrames++;
      if (faceLockedFrames >= 30 && !autoMarkTimeout) {
        playSound("lock");
        triggerAttendanceCapture();
      }
    } else {
      faceLockedFrames = 0;
    }
  }

  // --- Capture Burst & Attendance Execution ---
  if (triggerAttendanceBtn) triggerAttendanceBtn.addEventListener("click", triggerAttendanceCapture);

  async function triggerAttendanceCapture() {
    if (isCapturing || !markStream || !currentActiveSession) return;

    // Check if any students exist
    if (registeredStudentCount === 0) {
      alert("No faces are registered in the system yet! Please switch to 'Register Face (Get ID)' tab first to register your face.");
      switchTab("tab-register");
      return;
    }

    isCapturing = true;
    updateTriggerBtnState();
    triggerAttendanceBtn.disabled = true;

    burstProgressContainer.classList.remove("hidden");
    blinkPromptOverlay.classList.remove("hidden");
    burstProgressFill.style.width = "0%";
    burstPercentText.textContent = "0%";

    kioskResultContainer.innerHTML = `
      <div class="verification-guidance-card">
        <div class="step-num" style="animation: pulseGlow 1s infinite; display:flex; align-items:center; justify-content:center;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </div>
        <div class="step-text">
          <strong style="color:var(--brand-blue); font-size:1rem;">Scanning Face & Liveness...</strong><br>
          <span style="color:var(--text-main); font-weight:700;">Please BLINK naturally now!</span>
        </div>
      </div>
    `;

    try {
      const frames = await captureBurstFrames(20, 100);

      burstStatusText.textContent = "Matching SFace embedding & Hedera consensus...";

      const { status, data } = await safeFetchJson("/api/attendance/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: currentActiveSession.session_id,
          frames: frames
        })
      });

      handleAttendanceResponse(status, data);

    } catch (err) {
      playSound("error");
      renderErrorVerdict("NETWORK_ERROR", err.message);
    } finally {
      isCapturing = false;
      faceLockedFrames = 0;
      burstProgressContainer.classList.add("hidden");
      blinkPromptOverlay.classList.add("hidden");
      updateTriggerBtnState();
    }
  }

  async function captureBurstFrames(total = 20, interval = 100) {
    const frames = [];
    const ctx = hiddenCaptureCanvas.getContext("2d");

    for (let i = 0; i < total; i++) {
      ctx.drawImage(kioskVideo, 0, 0, hiddenCaptureCanvas.width, hiddenCaptureCanvas.height);
      const b64 = hiddenCaptureCanvas.toDataURL("image/jpeg", 0.7);
      frames.push(b64);

      const pct = Math.round(((i + 1) / total) * 100);
      burstProgressFill.style.width = `${pct}%`;
      burstPercentText.textContent = `${pct}% (${i + 1}/${total})`;

      await new Promise(r => setTimeout(r, interval));
    }
    return frames;
  }

  function handleAttendanceResponse(statusCode, data) {
    if (statusCode === 200 && data.verdict === "ok") {
      playSound("success");
      const rec = data.record;
      renderSuccessVerdict(rec);
      addCheckinToFeed(rec);

    } else {
      playSound("error");
      renderErrorVerdict(data.verdict, data.error, data);
    }
  }

  function renderSuccessVerdict(rec) {
    const simPct = Math.round(rec.match_score * 100);
    kioskResultContainer.innerHTML = `
      <div class="verdict-banner-official success">
        <div class="verdict-header-row">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
          <div>
            <div style="font-size:1.05rem; font-weight:700;">Biometric Attendance Recorded Successfully</div>
            <div style="font-size:0.8rem; font-weight:500; opacity:0.9;">Cryptographic Transaction Committed on Hedera SCS</div>
          </div>
        </div>

        <div class="verdict-details-grid">
          <div><strong>Student Name:</strong> ${escapeHtml(rec.name)}</div>
          <div><strong>Registration No:</strong> <span class="status-badge-pill status-eligible">${escapeHtml(rec.roll_no)}</span></div>
          <div><strong>Facial Match Score:</strong> <span class="status-badge-pill status-active">${simPct}% Similarity</span></div>
          <div><strong>Liveness Verification:</strong> ${rec.blink_count} Blink(s) Verified ✓</div>
        </div>

        <div style="margin-top:12px; padding-top:10px; border-top:1px solid rgba(5,150,105,0.25); display:flex; justify-content:space-between; align-items:center; font-size:0.82rem;">
          <span>On-Chain Evidence Hash: <code class="mono-code">${shorten(rec.tx_hash, 8)}</code></span>
          <a href="${rec.explorer_url}" target="_blank" class="link-btn" style="color:var(--primary-blue);">
            View HashScan Audit Record ↗
          </a>
        </div>
      </div>
    `;
  }

  function renderErrorVerdict(verdict, message, extraData = {}) {
    const explanations = {
      "no_blink": "Liveness Verification Failed: No natural eye closure detected. Please face the sensor and blink once when instructed.",
      "unknown_face": "Unregistered Biometric Profile: Your face template does not match any enrolled student in this course. Please complete registration.",
      "multiple_faces": "Multiple Faces Detected: More than one face was captured in the viewfinder. Please stand alone in front of the terminal.",
      "poor_frames": "Insufficient Image Quality: The face was not clearly aligned or lighting was inadequate. Please face the sensor directly.",
      "already_marked": "Duplicate Attendance Rejected: Attendance for this student has already been committed in this lecture session.",
      "session_inactive": "Session Inactive: The attendance window for this lecture has expired or been closed by faculty.",
      "no_students": "No Students Enrolled: No biometric profiles exist in the institutional registry."
    };

    const explanation = explanations[verdict] || message || "Verification could not be completed.";

    kioskResultContainer.innerHTML = `
      <div class="verdict-banner-official error">
        <div class="verdict-header-row">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <div>
            <div style="font-size:1.05rem; font-weight:700;">Attendance Verification Rejected</div>
            <div style="font-size:0.8rem; font-weight:500; opacity:0.9;">Reason: ${escapeHtml(verdict || 'VERIFICATION_FAILED')}</div>
          </div>
        </div>
        <p style="font-size:0.88rem; line-height:1.45; margin-top:4px;">${escapeHtml(explanation)}</p>
      </div>
    `;
  }

  function addCheckinToFeed(rec) {
    if (emptyFeedPlaceholder && emptyFeedPlaceholder.classList) {
      emptyFeedPlaceholder.classList.add("hidden");
    }
    recentCheckins.unshift(rec);
    if (feedCounterBadge) feedCounterBadge.textContent = `${recentCheckins.length} Present`;
    if (kioskPresentCount && kioskPresentCount !== feedCounterBadge) {
      kioskPresentCount.textContent = recentCheckins.length;
    }

    const timeStr = new Date(rec.timestamp * 1000).toLocaleTimeString();
    const initials = rec.name.split(" ").map(p => p[0]).join("").substring(0, 2).toUpperCase();

    const item = document.createElement("div");
    item.style.padding = "10px 14px";
    item.style.borderBottom = "1px solid var(--border-subtle)";
    item.style.display = "flex";
    item.style.justifyContent = "space-between";
    item.style.alignItems = "center";
    item.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px;">
        <div class="user-avatar-circle" style="width:28px; height:28px; font-size:0.75rem;">${escapeHtml(initials)}</div>
        <div>
          <div style="font-weight:700; font-size:0.86rem;">${escapeHtml(rec.name)}</div>
          <div style="font-size:0.74rem; color:var(--text-muted);">
            <strong style="color:var(--text-sub);">${escapeHtml(rec.roll_no)}</strong> • ${timeStr} • <span style="color:var(--accent-success); font-weight:600;">${Math.round(rec.match_score * 100)}% match</span>
          </div>
        </div>
      </div>
      <div>
        <a href="${rec.explorer_url}" target="_blank" class="status-badge-pill status-active" style="text-decoration:none; font-size:0.72rem;">
          Audit ↗
        </a>
      </div>
    `;

    if (feedItemsList && feedItemsList.prepend) {
      feedItemsList.prepend(item);
    }
  }

  const clearFeedBtn = document.getElementById("clearFeedBtn"); if (clearFeedBtn) clearFeedBtn.addEventListener("click", () => {
    recentCheckins = [];
    feedItemsList.innerHTML = "";
    if (emptyFeedPlaceholder && emptyFeedPlaceholder.classList) emptyFeedPlaceholder.classList.remove("hidden");
    if (feedCounterBadge) feedCounterBadge.textContent = "0 Checked In";
    if (kioskPresentCount) kioskPresentCount.textContent = "0";
  });

  const refreshKioskSessionsBtn = document.getElementById("refreshKioskSessionsBtn"); if (refreshKioskSessionsBtn) refreshKioskSessionsBtn.addEventListener("click", loadActiveSessions);

  // =========================================================================
  // TAB 2: REGISTER FACE & ISSUE DIGITAL STUDENT ID
  // =========================================================================
  const regStudentName = document.getElementById("regStudentName");
  const regStudentRoll = document.getElementById("regStudentRoll");
  const autoGenIdBtn = document.getElementById("autoGenIdBtn");
  const registerVideo = document.getElementById("registerVideo");
  const registerHudCanvas = document.getElementById("registerHudCanvas");
  const registerHiddenCanvas = document.getElementById("registerHiddenCanvas");
  const registerStandby = document.getElementById("registerStandby");
  const startRegisterCamBtn = document.getElementById("startRegisterCamBtn");
  const scanAndRegisterBtn = document.getElementById("scanAndRegisterBtn");
  const registerStatusAlert = document.getElementById("registerStatusAlert");
  const idCardAvatar = document.getElementById("idCardAvatar");
  const idCardName = document.getElementById("idCardName");
  const idCardRoll = document.getElementById("idCardRoll");
  const idCardStatus = document.getElementById("idCardStatus");
  const idCardHash = document.getElementById("idCardHash");
  const idCardLedger = document.getElementById("idCardLedger");
  const postRegActions = document.getElementById("postRegActions");
  const proceedToMarkBtn = document.getElementById("proceedToMarkBtn");

  // Real-time preview bindings on ID Card
  if (regStudentName) regStudentName.addEventListener("input", () => {
    const name = regStudentName.value.trim() || "Your Name";
    idCardName.textContent = name;
    idCardAvatar.textContent = name.split(" ").map(w => w[0]).join("").substring(0, 2).toUpperCase() || "?";
  });

  if (regStudentRoll) regStudentRoll.addEventListener("input", () => {
    const roll = regStudentRoll.value.trim() || "PENDING REGISTRATION";
    idCardRoll.textContent = `ID: ${roll}`;
  });

  if (autoGenIdBtn) autoGenIdBtn.addEventListener("click", async () => {
    try {
      const { ok, data: d } = await safeFetchJson("/api/students/next-roll");
      if (ok && d.next_roll_no) {
        regStudentRoll.value = d.next_roll_no;
        idCardRoll.textContent = `ID: ${d.next_roll_no}`;
        return;
      }
    } catch (e) {}
    regStudentRoll.value = "AC001";
    idCardRoll.textContent = "ID: AC001";
  });

  if (startRegisterCamBtn) startRegisterCamBtn.addEventListener("click", async () => {
    if (registerStream) {
      registerStream = stopCamera(registerStream, registerVideo, registerStandby);
      startRegisterCamBtn.textContent = "Start Register Camera";
      scanAndRegisterBtn.disabled = true;
    } else {
      registerStream = await startCamera(registerVideo, registerStandby);
      if (registerStream) {
        startRegisterCamBtn.textContent = "Pause Cam";
        scanAndRegisterBtn.disabled = false;
        // Draw registration alignment HUD
        renderRegisterHUD();
      }
    }
  });

  function renderRegisterHUD() {
    if (!registerStream) return;
    const ctx = registerHudCanvas.getContext("2d");
    const w = registerHudCanvas.width;
    const h = registerHudCanvas.height;
    ctx.clearRect(0, 0, w, h);

    // Draw central target oval
    const cx = w / 2;
    const cy = h / 2;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "rgba(59, 130, 246, 0.7)";
    ctx.setLineDash([10, 6]);
    ctx.beginPath();
    ctx.ellipse(cx, cy, w * 0.22, h * 0.35, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    if (registerStream) {
      requestAnimationFrame(renderRegisterHUD);
    }
  }

  if (scanAndRegisterBtn) scanAndRegisterBtn.addEventListener("click", async () => {
    const name = regStudentName.value.trim();
    const roll = regStudentRoll.value.trim();

    if (!name || !roll) {
      alert("Please provide both your Full Name and a Student ID / Roll Number.");
      return;
    }

    if (!registerStream) {
      alert("Please start the register camera first.");
      return;
    }

    registerStatusAlert.classList.remove("hidden");
    registerStatusAlert.className = "alert-banner";
    registerStatusAlert.style.background = "var(--bg-inset)";
    registerStatusAlert.textContent = "Capturing 10 consistent face frames...";
    scanAndRegisterBtn.disabled = true;

    try {
      const frames = [];
      const ctx = registerHiddenCanvas.getContext("2d");

      for (let i = 0; i < 10; i++) {
        ctx.drawImage(registerVideo, 0, 0, registerHiddenCanvas.width, registerHiddenCanvas.height);
        frames.push(registerHiddenCanvas.toDataURL("image/jpeg", 0.7));
        registerStatusAlert.textContent = `Capturing face: ${i + 1}/10 frames...`;
        await new Promise(r => setTimeout(r, 120));
      }

      registerStatusAlert.textContent = "Extracting SFace biometric vector & anchoring on Hedera SCS...";

      const { status, data } = await safeFetchJson("/api/students/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Token": getAdminToken()
        },
        body: JSON.stringify({ roll_no: roll, name: name, frames })
      });

      if (status === 201) {
        playSound("success");
        const st = data.student;

        // Update ID Card to Verified State!
        idCardName.textContent = st.name;
        idCardRoll.textContent = `ID: ${st.roll_no}`;
        idCardStatus.textContent = "REGISTERED & ACTIVE ✓";
        idCardStatus.style.color = "var(--accent-success)";
        idCardStatus.style.fontWeight = "700";
        idCardHash.textContent = shorten(st.student_id, 6);
        idCardLedger.textContent = "Hedera SCS Confirmed";
        idCardLedger.style.color = "var(--accent-success)";

        registerStatusAlert.className = "alert-banner";
        registerStatusAlert.style.background = "var(--accent-success-bg)";
        registerStatusAlert.style.border = "1px solid var(--accent-success-border)";
        registerStatusAlert.innerHTML = `
          <strong>✓ Face Successfully Registered & Student ID Issued!</strong><br>
          Student: <strong>${escapeHtml(st.name)}</strong> (ID: <code>${escapeHtml(st.roll_no)}</code>)<br>
          On-Chain Transaction: <a href="${st.explorer_url}" target="_blank" style="color:var(--brand-blue);">${shorten(st.tx_hash, 8)} ↗</a>
        `;

        postRegActions.classList.remove("hidden");
        fetchHealth();

        // Automatically log in the newly registered student
        currentUserRole = "student";
        currentStudentData = st;
        sessionStorage.setItem("attendchain_user_role", "student");
        sessionStorage.setItem("attendchain_student_data", JSON.stringify(st));
        updateAuthUI();

      } else {
        playSound("error");
        registerStatusAlert.className = "alert-banner";
        registerStatusAlert.style.background = "var(--accent-danger-bg)";
        registerStatusAlert.style.border = "1px solid var(--accent-danger-border)";
        registerStatusAlert.textContent = `Registration Failed: ${data.error || data.detail || data.verdict || "Unable to register face"}`;
      }
    } catch (e) {
      registerStatusAlert.className = "alert-banner";
      registerStatusAlert.style.background = "var(--accent-danger-bg)";
      registerStatusAlert.style.border = "1px solid var(--accent-danger-border)";
      registerStatusAlert.textContent = `Registration Error: ${e.message || "An unexpected error occurred during face scan"}`;
    } finally {
      scanAndRegisterBtn.disabled = false;
    }
  });

  if (proceedToMarkBtn) proceedToMarkBtn.addEventListener("click", () => {
    switchTab("tab-kiosk");
    // Start camera in kiosk tab automatically
    if (!markStream) {
      startCamBtn.click();
    }
  });

  // =========================================================================
  // TAB 3: STUDENT PORTAL (Lookup & Analytics)
  // =========================================================================
  const portalRollInput = document.getElementById("portalRollInput");
  const portalSearchBtn = document.getElementById("portalSearchBtn");
  const portalResultWrapper = document.getElementById("portalResultWrapper");
  const portalStudentName = document.getElementById("portalStudentName");
  const portalRollTag = document.getElementById("portalRollTag");
  const portalStudentIdChip = document.getElementById("portalStudentIdChip");
  const portalCommitmentChip = document.getElementById("portalCommitmentChip");
  const portalAvatarInitials = document.getElementById("portalAvatarInitials");
  const portalDefaulterBadgeWrap = document.getElementById("portalDefaulterBadgeWrap");
  const portalSubjectTbody = document.getElementById("portalSubjectTbody");
  const portalMinThresholdText = document.getElementById("portalMinThresholdText");

  if (portalSearchBtn) portalSearchBtn.addEventListener("click", performStudentSearch);
  if (portalRollInput) portalRollInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") performStudentSearch();
  });

  async function performStudentSearch() {
    const roll = portalRollInput.value.trim();
    if (!roll) {
      alert("Please enter a roll number to query.");
      return;
    }

    try {
      const { ok, status, data } = await safeFetchJson(`/api/students/${encodeURIComponent(roll)}/summary`);
      if (status === 404) {
        alert(`No student found with roll number "${roll}". Please check spelling.`);
        if (portalResultWrapper) portalResultWrapper.classList.add("hidden");
        return;
      }
      if (!ok) {
        alert("Search failed: " + (data.error || "Unknown error"));
        return;
      }
      renderPortalResults(data);
    } catch (e) {
      alert("Failed to query student summary: " + e.message);
    }
  }

  function renderPortalResults(data) {
    const portalResultWrapper = document.getElementById("portalResultWrapper");
    if (portalResultWrapper) portalResultWrapper.classList.remove("hidden");
    const st = data.student;

    if (portalStudentName) portalStudentName.textContent = st.name;
    if (portalRollTag) portalRollTag.textContent = st.roll_no;
    if (portalStudentIdChip) portalStudentIdChip.textContent = `ID: ${shorten(st.student_id, 8)}`;
    if (portalCommitmentChip) portalCommitmentChip.textContent = `SHA-256: ${shorten(st.face_commitment, 8)}`;
    if (portalAvatarInitials) {
      portalAvatarInitials.textContent = st.name.split(" ").map(w => w[0]).join("").substring(0, 2).toUpperCase();
    }
    if (portalMinThresholdText) {
      portalMinThresholdText.textContent = `${data.min_attendance_threshold}%`;
    }

    // Update Digital ID Card
    const idCardName = document.getElementById("idCardName");
    const idCardRoll = document.getElementById("idCardRoll");
    const idCardHash = document.getElementById("idCardHash");
    const idCardStatus = document.getElementById("idCardStatus");
    const idCardLedger = document.getElementById("idCardLedger");

    if (idCardName) idCardName.textContent = st.name;
    if (idCardRoll) idCardRoll.textContent = st.roll_no;
    if (idCardHash) idCardHash.textContent = shorten(st.student_id, 8);
    if (idCardStatus) idCardStatus.textContent = "Verified ✓";
    if (idCardLedger) idCardLedger.textContent = "Anchored ✓";

    if (portalDefaulterBadgeWrap) {
      if (data.is_defaulter_overall) {
        portalDefaulterBadgeWrap.innerHTML = `
          <span class="status-badge-pill status-defaulter" style="font-size:0.84rem; padding:6px 14px;">
            Academic Defaulter (&lt; ${data.min_attendance_threshold}%)
          </span>
        `;
      } else {
        portalDefaulterBadgeWrap.innerHTML = `
          <span class="status-badge-pill status-eligible" style="font-size:0.84rem; padding:6px 14px;">
            Eligible for Examinations (&ge; ${data.min_attendance_threshold}%)
          </span>
        `;
      }
    }

    if (portalSubjectTbody) {
      if (!data.subjects || data.subjects.length === 0) {
        portalSubjectTbody.innerHTML = '<tr><td colspan="6" class="text-muted" style="text-align:center; padding:24px;">No academic course sessions conducted yet.</td></tr>';
      } else {
        portalSubjectTbody.innerHTML = data.subjects.map(s => {
          const pct = s.attendance_percent;
          const barColor = s.defaulter ? "var(--accent-danger)" : "var(--accent-success)";
          const standingBadge = s.defaulter
            ? '<span class="status-badge-pill status-defaulter">Defaulter</span>'
            : '<span class="status-badge-pill status-eligible">Eligible</span>';

          return `
            <tr>
              <td><strong>${escapeHtml(s.subject)}</strong></td>
              <td>${s.present_sessions} hrs</td>
              <td>${s.total_sessions} hrs</td>
              <td><strong style="color:${barColor}; font-size:0.95rem;">${pct}%</strong></td>
              <td style="width: 160px;">
                <div class="progress-track-bar">
                  <div class="progress-fill-bar" style="width:${pct}%; background:${barColor};"></div>
                </div>
              </td>
              <td>${standingBadge}</td>
            </tr>
          `;
        }).join("");
      }
    }
  }

  // =========================================================================
  // TAB 4: FACULTY & ADMIN CONSOLE
  // =========================================================================
  const adminAuthTokenInput = document.getElementById("adminAuthTokenInput");
  const saveAdminTokenBtn = document.getElementById("saveAdminTokenBtn");
  const authAlertBox = document.getElementById("authAlertBox");

  if (adminAuthTokenInput) {
    adminAuthTokenInput.value = getAdminToken();
  }

  if (saveAdminTokenBtn) {
    if (saveAdminTokenBtn) saveAdminTokenBtn.addEventListener("click", () => {
      const val = adminAuthTokenInput ? adminAuthTokenInput.value.trim() : "";
      sessionStorage.setItem("attendchain_admin_token", val);
      if (authAlertBox) {
        authAlertBox.textContent = "Token stored securely in session storage.";
        authAlertBox.style.color = "var(--accent-success)";
      }
      loadAdminData();
    });
  }

  // Open New Session
  const newSessionSubject = document.getElementById("newSessionSubject");
  const newSessionDuration = document.getElementById("newSessionDuration");
  const openNewSessionBtn = document.getElementById("openNewSessionBtn");
  const openSessionResultAlert = document.getElementById("openSessionResultAlert");

  if (openNewSessionBtn) openNewSessionBtn.addEventListener("click", async () => {
    const subject = newSessionSubject.value.trim();
    const duration = parseInt(newSessionDuration.value);

    if (!subject) {
      alert("Please enter subject title / code.");
      return;
    }

    openSessionResultAlert.classList.remove("hidden");
    openSessionResultAlert.textContent = "Anchoring session on Hedera SCS...";
    openNewSessionBtn.disabled = true;

    try {
      const { status, data } = await safeFetchJson("/api/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Token": getAdminToken()
        },
        body: JSON.stringify({ subject, duration_seconds: duration })
      });

      if (status === 201) {
        playSound("success");
        openSessionResultAlert.style.background = "var(--accent-success-bg)";
        openSessionResultAlert.style.border = "1px solid var(--accent-success-border)";
        openSessionResultAlert.innerHTML = `
          <strong>✓ Session #${data.session.session_id} Opened on-chain!</strong><br>
          Subject: ${escapeHtml(data.session.subject)} | Tx: <a href="${data.session.explorer_url}" target="_blank">${shorten(data.session.tx_hash, 6)} ↗</a>
        `;
        newSessionSubject.value = "";
        loadAdminData();
        loadActiveSessions();
      } else {
        playSound("error");
        openSessionResultAlert.textContent = `Failed: ${data.error || "Unable to open session"}`;
      }
    } catch (e) {
      openSessionResultAlert.textContent = `Session Error: ${e.message || "Failed to open session"}`;
    } finally {
      openNewSessionBtn.disabled = false;
    }
  });

  // Load Admin Data (Sessions & Students Tables)
  async function loadAdminData() {
    loadAdminSessionsList();
    loadAdminStudentsList();
  }

  async function loadAdminSessionsList() {
    const tbody = document.getElementById("adminSessionsTbody");
    try {
      const { ok, data: d } = await safeFetchJson("/api/sessions");
      const sessions = (d && d.sessions) || [];

      const sessBadge = document.getElementById("adminSessionCountBadge");
      if (sessBadge) sessBadge.textContent = `${sessions.length} Session${sessions.length === 1 ? '' : 's'}`;

      if (sessions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-muted" style="text-align:center; padding:20px;">No academic sessions created yet.</td></tr>';
        return;
      }

      tbody.innerHTML = sessions.map(s => {
        const timeStr = new Date(s.start_time * 1000).toLocaleTimeString();
        const mins = Math.round(s.duration_seconds / 60);
        const stateBadge = s.is_active
          ? '<span class="status-badge-pill status-active">Active Window</span>'
          : '<span class="status-badge-pill status-closed">Closed</span>';

        const actionBtn = s.is_active
          ? `<button class="btn-outline-action close-sess-btn" style="padding:4px 10px; font-size:0.75rem;" data-id="${s.session_id}">Close Session</button>`
          : `<span class="text-muted">—</span>`;

        return `
          <tr>
            <td><strong>#${s.session_id}</strong></td>
            <td><strong>${escapeHtml(s.subject)}</strong></td>
            <td>${mins} mins</td>
            <td>${stateBadge}</td>
            <td class="text-muted">${timeStr}</td>
            <td>${actionBtn}</td>
            <td>
              <a href="/api/sessions/${s.session_id}/attendance.csv" download class="btn-secondary-action" style="padding:4px 10px; font-size:0.75rem; text-decoration:none; display:inline-flex;">
                Official CSV
              </a>
            </td>
          </tr>
        `;
      }).join("");

      tbody.querySelectorAll(".close-sess-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          if (confirm(`Close session #${id} now?`)) {
            await safeFetchJson(`/api/sessions/${id}/close`, {
              method: "POST",
              headers: { "X-Admin-Token": getAdminToken() }
            });
            loadAdminSessionsList();
            loadActiveSessions();
          }
        });
      });

    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:var(--accent-danger); text-align:center;">Failed to fetch sessions.</td></tr>';
    }
  }

  async function loadAdminStudentsList() {
    const tbody = document.getElementById("adminStudentsTbody");
    try {
      const { ok, data: d } = await safeFetchJson("/api/students", {
        headers: { "X-Admin-Token": getAdminToken() }
      });
      if (!ok) throw new Error(d.error || "Auth failed");
      const students = (d && d.students) || [];

      document.getElementById("adminStudentCountBadge").textContent = `${students.length} Enrolled`;

      if (students.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center; padding:20px;">No students enrolled yet.</td></tr>';
        return;
      }

      tbody.innerHTML = students.map(st => {
        const dateStr = new Date(st.registered_at * 1000).toLocaleDateString();
        return `
          <tr>
            <td><strong>${escapeHtml(st.roll_no)}</strong></td>
            <td>${escapeHtml(st.name)}</td>
            <td class="mono-text">${shorten(st.student_id, 8)}</td>
            <td class="mono-text">${shorten(st.face_commitment, 8)}</td>
            <td class="text-muted">${dateStr}</td>
          </tr>
        `;
      }).join("");

    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--accent-danger); text-align:center;">Unauthorized. Please verify X-Admin-Token above.</td></tr>';
    }
  }

  // Cryptographic Tamper Audit Engine
  const executeAuditBtn = document.getElementById("executeAuditBtn");
  const auditOutputWrapper = document.getElementById("auditOutputWrapper");

  if (executeAuditBtn) executeAuditBtn.addEventListener("click", async () => {
    executeAuditBtn.disabled = true;
    auditOutputWrapper.innerHTML = `
      <div class="audit-standby-state">
        <div class="audit-icon" style="animation: pulseGlow 1s infinite; display:flex; align-items:center; justify-content:center;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </div>
        <h4>Executing Cryptographic Verification Checks...</h4>
        <p>Comparing local face commitments, canonical evidence hashes, and row counts against Hedera blockchain...</p>
      </div>
    `;

    try {
      const { ok, data } = await safeFetchJson("/api/audit", {
        headers: { "X-Admin-Token": getAdminToken() }
      });

      if (!ok) {
        throw new Error(data.error || "Audit failed to execute");
      }

      if (data.status === "CLEAN") {
        playSound("success");
        auditOutputWrapper.innerHTML = `
          <div class="audit-card-result clean">
            <h4 style="color:var(--accent-success); display:flex; align-items:center; gap:8px;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              All Records 100% Verifiable & Cryptographically Matching (CLEAN)
            </h4>
            <p style="margin-top:8px;">
              Completed <strong>${data.total_checks_performed}</strong> mathematical proofs:
              (1) Stored SHA-256 face commitments equal on-chain registry;
              (2) Canonical JSON evidence SHA-256 matches on-chain hashes;
              (3) Local attendance counts equal smart contract present count.
            </p>
          </div>
        `;
      } else {
        playSound("error");
        const cards = data.discrepancies.map(d => `
          <div class="discrepancy-pill-box">
            <div style="display:flex; justify-content:space-between; font-weight:700; color:var(--accent-danger);">
              <span style="display:flex; align-items:center; gap:6px;">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                ${escapeHtml(d.type)}
              </span>
              <span class="badge badge-danger">${escapeHtml(d.severity)}</span>
            </div>
            <p style="margin-top:4px;">${escapeHtml(d.detail)}</p>
            ${d.local_commitment ? `<div class="mono-text text-sm">Local DB Hash: ${escapeHtml(d.local_commitment)}</div>` : ''}
            ${d.on_chain_commitment ? `<div class="mono-text text-sm">On-Chain Ledger Hash: ${escapeHtml(d.on_chain_commitment)}</div>` : ''}
          </div>
        `).join("");

        auditOutputWrapper.innerHTML = `
          <div class="audit-card-result tampered">
            <h4 style="color:var(--accent-danger); display:flex; align-items:center; gap:8px;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              Database Tampering Detected (${data.discrepancy_count} Discrepancies)
            </h4>
            <p style="margin-top:6px; font-size:0.9rem;">
              The cryptographic audit discovered mismatches between the off-chain database and the immutable Hedera Smart Contract:
            </p>
            ${cards}
          </div>
        `;
      }
    } catch (e) {
      auditOutputWrapper.innerHTML = `
        <div class="audit-card-result tampered">
          <h4>Audit Execution Failed: ${escapeHtml(e.message)}</h4>
        </div>
      `;
    } finally {
      executeAuditBtn.disabled = false;
    }
  });

  const refreshAdminSessionsBtn = document.getElementById("refreshAdminSessionsBtn"); if (refreshAdminSessionsBtn) refreshAdminSessionsBtn.addEventListener("click", loadAdminSessionsList);
  const refreshAdminStudentsBtn = document.getElementById("refreshAdminStudentsBtn"); if (refreshAdminStudentsBtn) refreshAdminStudentsBtn.addEventListener("click", loadAdminStudentsList);


  // --- Extended State for Multi-Role ERP ---
  let modalScanStream = null;
  let modalScanSessionId = null;
  let activeLiveAttendancePoll = null;

  function formatTime(seconds) {
    if (seconds <= 0) return "00:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function getFacultyEmail() {
    if (currentFacultyData && currentFacultyData.email) return currentFacultyData.email;
    return "faculty@college.edu";
  }

  // --- Student Dashboard: Enhanced with Joined Classes Grid & Live Attendance ---

  let studentDashboardPollTimer = null;

  async function loadStudentDashboard(rollNo) {
    if (!rollNo) return;
    try {
      const { ok, data } = await safeFetchJson(`/api/student/${encodeURIComponent(rollNo)}/dashboard`);
      if (ok && data) {
        currentStudentData = data.student;
        sessionStorage.setItem("attendchain_student_data", JSON.stringify(data.student));

        // Header Elements
        const nameEl = document.getElementById("portalStudentName");
        const rollEl = document.getElementById("portalRollTag");
        const emailEl = document.getElementById("portalEmailTag");
        const idChip = document.getElementById("portalStudentIdChip");
        const commitChip = document.getElementById("portalCommitmentChip");
        const initialsEl = document.getElementById("portalAvatarInitials");

        if (nameEl) nameEl.textContent = data.student.name || "Student Academic Portal";
        if (rollEl) rollEl.textContent = data.student.roll_no;
        if (emailEl) emailEl.textContent = data.student.email || `${data.student.roll_no}@student.college.edu`;
        if (idChip) idChip.textContent = `ID: ${shorten(data.student.student_id, 8)}`;
        if (commitChip) commitChip.textContent = `Commitment: ${shorten(data.student.face_commitment, 8)}`;
        if (initialsEl && data.student.name) {
          initialsEl.textContent = data.student.name.substring(0, 2).toUpperCase();
        }

        // 4 KPI Summary Cards
        const stats = data.overall_stats || {};
        const totEl = document.getElementById("metricTotalSessions");
        const attEl = document.getElementById("metricAttendedSessions");
        const pctEl = document.getElementById("metricAttendancePct");
        const standingEl = document.getElementById("metricStandingBadge");
        const standingSub = document.getElementById("metricStandingSub");

        if (totEl) totEl.textContent = stats.total_sessions || 0;
        if (attEl) attEl.textContent = stats.attended_sessions || 0;
        if (pctEl) {
          pctEl.textContent = `${stats.attendance_percent || 0}%`;
          pctEl.style.color = stats.is_defaulter ? "var(--accent-danger)" : "var(--accent-success)";
        }
        if (standingEl) {
          standingEl.textContent = stats.is_defaulter ? "Shortage (< 75%)" : "Eligible";
          standingEl.style.color = stats.is_defaulter ? "var(--accent-danger)" : "var(--accent-success)";
        }
        if (standingSub) {
          standingSub.textContent = stats.is_defaulter ? "Attendance below 75% requirement" : "Ordinance 14.2 Compliant ✓";
        }

        // Populate Attendance Status Banner
        const attNameEl = document.getElementById("attendanceStudentName");
        const attRollEl = document.getElementById("attendanceRollTag");
        const attEmailEl = document.getElementById("attendanceEmailTag");
        const attInitialsEl = document.getElementById("attendanceAvatarInitials");
        if (attNameEl) attNameEl.textContent = data.student.name || "Student Attendance Status";
        if (attRollEl) attRollEl.textContent = data.student.roll_no;
        if (attEmailEl) attEmailEl.textContent = data.student.email || `${data.student.roll_no}@student.college.edu`;
        if (attInitialsEl && data.student.name) {
          attInitialsEl.textContent = data.student.name.substring(0, 2).toUpperCase();
        }

        // Render Tables on Attendance Status Page
        renderStudentCourseBreakdown(data.joined_groups || []);
        renderStudentAttendanceHistory(data.attendance_history || []);

        // Render My Joined Classes Grid
        renderStudentClassesGrid(data.joined_groups || [], rollNo);

        // Fast live sync: poll every 2s while on student dashboard tab
        if (!studentDashboardPollTimer) {
          studentDashboardPollTimer = setInterval(() => {
            const portalSec = document.getElementById("tab-portal");
            if (portalSec && portalSec.classList.contains("active") && currentUserRole === "student" && currentStudentData) {
              loadStudentDashboard(currentStudentData.roll_no);
            }
          }, 2000);
        }
      }
    } catch (e) {
      console.warn("Student dashboard load error:", e);
    }
  }

  function renderStudentClassesGrid(groups, rollNo) {
    const gridEl = document.getElementById("studentClassesGrid");
    if (!gridEl) return;

    if (!groups || groups.length === 0) {
      gridEl.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 48px 24px; background: var(--bg-surface); border-radius: var(--radius-lg); border: 1px dashed var(--border-medium);">
          <div style="width: 52px; height: 52px; margin: 0 auto 14px; border-radius: 50%; background: var(--bg-subtle); display: flex; align-items: center; justify-content: center; color: var(--primary-blue);">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
            </svg>
          </div>
          <h4 style="font-size: 1.15rem; font-weight: 800; color: var(--text-main);">No Classes Joined Yet</h4>
          <p style="color: var(--text-muted); font-size: 0.88rem; max-width: 440px; margin: 6px auto 18px;">
            Click the button below or the <strong>+</strong> button in the bottom right corner to join your course subjects using an invite code.
          </p>
          <button class="btn-primary-action" id="emptyStateJoinBtn" type="button" style="width: auto; padding: 10px 24px; margin: 0 auto; display: inline-flex; align-items: center; gap: 8px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            <span>Join Course with Invite Code</span>
          </button>
        </div>
      `;
      const emptyBtn = document.getElementById("emptyStateJoinBtn");
      if (emptyBtn) emptyBtn.addEventListener("click", openJoinClassModal);
      return;
    }

    gridEl.innerHTML = groups.map(g => {
      const pct = g.attendance_percent || 0;
      const isDef = g.is_defaulter;
      const progressColor = isDef ? "var(--status-absent)" : "var(--status-present)";
      const standingTag = isDef
        ? `<span class="status-badge-a"><span class="toggle-letter">A</span> Shortage (< 75%)</span>`
        : `<span class="status-badge-p"><span class="toggle-letter">P</span> Eligible</span>`;

      const activeSess = g.active_session;
      const hasActive = !!activeSess;
      const alreadyMarked = hasActive && activeSess.already_marked;

      let actionBoxHtml = "";

      if (hasActive) {
        if (alreadyMarked) {
          actionBoxHtml = `
            <div class="class-attendance-box marked-mode">
              <div style="font-weight:700; font-size:0.88rem; color:var(--status-present); display:flex; align-items:center; gap:6px; margin-bottom:4px;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                <span>Attendance Marked: <strong class="status-badge-p"><span class="toggle-letter">P</span> PRESENT</strong></span>
              </div>
              <div style="font-size:0.78rem; color:var(--navy-500); margin-bottom:10px;">
                Recorded on Hedera SCS • Lecture Session #${activeSess.session_id}
              </div>
              <button class="btn-marked" disabled type="button">
                <span class="toggle-letter" style="font-weight:800; font-family:var(--font-serif); margin-right:4px;">P</span> Marked (Present)
              </button>
            </div>
          `;
        } else {
          const remaining = Math.max(0, activeSess.remaining_seconds || 0);
          actionBoxHtml = `
            <div class="class-attendance-box active-mode">
              <div class="class-live-badge">
                <span class="class-live-dot"></span>
                <span>Live Attendance In Progress (Closes in ${formatTime(remaining)})</span>
              </div>
              <div style="font-size:0.78rem; color:var(--navy-500); margin-bottom:10px;">
                Faculty has opened biometric verification for Lecture #${activeSess.session_id}.
              </div>
              <button class="btn-mark-active class-scan-trigger-btn" type="button"
                data-session-id="${activeSess.session_id}"
                data-subject="${escapeHtml(g.subject_code)}"
                data-name="${escapeHtml(g.name)}"
                style="display:flex; align-items:center; justify-content:center; gap:8px;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                <span>Scan Face & Mark Attendance</span>
              </button>
            </div>
          `;
        }
      } else {
        let lastStatusText = "";
        if (g.last_session_marked === true) {
          lastStatusText = `<span class="status-badge-p"><span class="toggle-letter">P</span> Present</span>`;
        } else if (g.last_session_marked === false) {
          lastStatusText = `<span class="status-badge-a"><span class="toggle-letter">A</span> Missed</span>`;
        } else {
          lastStatusText = `<span style="color:var(--navy-500);">No sessions yet</span>`;
        }

        actionBoxHtml = `
          <div class="class-attendance-box closed-mode">
            <div style="font-size:0.8rem; color:var(--navy-500); margin-bottom:8px; display:flex; align-items:center; gap:6px;">
              <span>Attendance Closed •</span> ${lastStatusText}
            </div>
            <button class="btn-closed" disabled type="button">
              Attendance Closed
            </button>
            <div style="font-size:0.75rem; color:var(--navy-500); margin-top:6px; text-align:center;">
              Option unlocks when instructor begins taking attendance.
            </div>
          </div>
        `;
      }

      return `
        <div class="class-card ${hasActive && !alreadyMarked ? 'has-active-session' : ''}">
          <div>
            <div class="class-card-top">
              <span class="class-subject-badge">${escapeHtml(g.subject_code)}</span>
              ${standingTag}
            </div>
            <div class="class-name-title">${escapeHtml(g.name)}</div>
            <div class="class-faculty-name" style="display:flex; align-items:center; gap:6px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
              <span>Instructor: <strong>${escapeHtml(g.faculty_name || 'Prof. Faculty')}</strong></span>
            </div>

            <div class="class-stats-panel">
              <div class="class-stats-row">
                <span class="class-pct-num" style="color:${progressColor};">${pct}%</span>
                <span class="class-count-text">${g.attended_sessions || 0} / ${g.total_sessions || 0} Lectures Attended</span>
              </div>
              <div class="class-progress-bar-wrap">
                <div class="class-progress-bar-fill" style="width:${Math.min(100, pct)}%; background:${progressColor};"></div>
              </div>
            </div>
          </div>

          ${actionBoxHtml}
        </div>
      `;
    }).join("");

    // Attach click listeners to all active attendance scan buttons
    gridEl.querySelectorAll(".class-scan-trigger-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const sessId = parseInt(btn.dataset.sessionId, 10);
        const subj = btn.dataset.subject || "Course";
        const cName = btn.dataset.name || "Lecture";
        openStudentFaceScanModal(sessId, `${subj} — ${cName}`);
      });
    });
  }

  function renderStudentCourseBreakdown(groups) {
    const tbody = document.getElementById("studentCourseBreakdownBody");
    if (!tbody) return;

    if (!groups || groups.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align:center; color:var(--text-muted); padding:30px;">
            No enrolled courses found. Click the + button in the bottom right corner to enroll.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = groups.map(g => {
      const pct = g.attendance_percent || 0;
      const isDef = g.is_defaulter;
      const progressColor = isDef ? "var(--accent-danger)" : "var(--accent-success)";
      const standingBadge = isDef
        ? `<span class="badge badge-danger">Shortage (< 75%)</span>`
        : `<span class="badge badge-success">Eligible</span>`;

      return `
        <tr>
          <td><strong class="mono-code">${escapeHtml(g.subject_code)}</strong></td>
          <td style="font-weight:700; color:var(--text-main);">${escapeHtml(g.name)}</td>
          <td style="color:var(--text-muted);">${escapeHtml(g.faculty_name || 'Course Faculty')}</td>
          <td>${g.attended_sessions || 0} / ${g.total_sessions || 0}</td>
          <td>
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-weight:700; color:${progressColor}; min-width:38px;">${pct}%</span>
              <div style="flex:1; max-width:90px; height:6px; background:var(--bg-subtle); border-radius:3px; overflow:hidden;">
                <div style="width:${Math.min(100, pct)}%; height:100%; background:${progressColor};"></div>
              </div>
            </div>
          </td>
          <td>${standingBadge}</td>
        </tr>
      `;
    }).join("");
  }

  function renderStudentAttendanceHistory(records) {
    const tbody = document.getElementById("studentAttendanceHistoryBody");
    if (!tbody) return;

    if (!records || records.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align:center; color:var(--text-muted); padding:30px;">
            No attendance records yet. Once you attend a lecture, verified ledger receipts will appear here.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = records.map(r => {
      const dateStr = r.timestamp ? new Date(r.timestamp * 1000).toLocaleString() : "Recent Session";
      const courseName = r.subject_code ? `${r.subject_code} — ${r.group_name || 'Course'}` : (r.group_name || 'Classroom Session');
      const hashShort = r.evidence_hash ? shorten(r.evidence_hash, 8) : "0x...";

      return `
        <tr>
          <td style="white-space:nowrap; font-size:0.84rem;">${dateStr}</td>
          <td style="font-weight:700; color:var(--text-main);">${escapeHtml(courseName)}</td>
          <td><span class="mono-code">#${r.session_id}</span></td>
          <td><span style="color:#059669; font-weight:700; font-size:0.82rem;">Liveness Verified (Blink)</span></td>
          <td><code class="mono-code" title="${escapeHtml(r.evidence_hash)}">${hashShort}</code></td>
          <td><span class="badge badge-success" style="font-size:0.75rem;">Hedera Anchored</span></td>
        </tr>
      `;
    }).join("");
  }

  // --- Student Join Group via Invite Code ---
  const studentJoinGroupBtn = document.getElementById("studentJoinGroupBtn");
  const studentInviteCodeInput = document.getElementById("studentInviteCodeInput");
  const studentJoinAlert = document.getElementById("studentJoinAlert");

  if (studentJoinGroupBtn) {
    studentJoinGroupBtn.addEventListener("click", async () => {
      const code = studentInviteCodeInput ? studentInviteCodeInput.value.trim().toUpperCase() : "";
      if (!code) {
        alert("Please enter a valid Course Invite Code (e.g. CS402-V9M).");
        return;
      }
      if (!currentStudentData || !currentStudentData.roll_no) {
        alert("Student profile not loaded. Please sign in again.");
        return;
      }

      if (studentJoinAlert) {
        studentJoinAlert.classList.remove("hidden");
        studentJoinAlert.className = "alert-callout-box info";
        studentJoinAlert.textContent = `Validating invite code '${code}'...`;
      }

      const { ok, status, data } = await safeFetchJson("/api/student/join-group", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roll_no: currentStudentData.roll_no,
          invite_code: code
        })
      });

      if (ok && data.ok) {
        playSound("success");
        if (studentJoinAlert) {
          studentJoinAlert.className = "alert-callout-box success";
          studentJoinAlert.textContent = data.message || `Successfully joined ${data.group.name}!`;
        }
        if (studentInviteCodeInput) studentInviteCodeInput.value = "";
        loadStudentDashboard(currentStudentData.roll_no);
      } else {
        playSound("error");
        if (studentJoinAlert) {
          studentJoinAlert.className = "alert-callout-box error";
          studentJoinAlert.textContent = data.error || "Failed to join group. Please check invite code.";
        }
      }
    });
  }

  // --- Student Biometric Face Scan Modal Logic ---
  const studentFaceScanModal = document.getElementById("studentFaceScanModal");
  const modalScanVideo = document.getElementById("modalScanVideo");
  const modalScanHudCanvas = document.getElementById("modalScanHudCanvas");
  const modalScanHiddenCanvas = document.getElementById("modalScanHiddenCanvas");
  const modalScanBlinkPrompt = document.getElementById("modalScanBlinkPrompt");
  const modalScanStandby = document.getElementById("modalScanStandby");
  const modalScanProgressContainer = document.getElementById("modalScanProgressContainer");
  const modalScanProgressFill = document.getElementById("modalScanProgressFill");
  const modalScanPercentText = document.getElementById("modalScanPercentText");
  const modalScanResultContainer = document.getElementById("modalScanResultContainer");
  const triggerModalScanBtn = document.getElementById("triggerModalScanBtn");
  const closeFaceScanModalBtn = document.getElementById("closeFaceScanModalBtn");
  const cancelFaceScanBtn = document.getElementById("cancelFaceScanBtn");
  const modalCourseTitle = document.getElementById("modalCourseTitle");
  const modalHudFacesChip = document.getElementById("modalHudFacesChip");
  const modalHudDistanceChip = document.getElementById("modalHudDistanceChip");
  const modalHudBlinkChip = document.getElementById("modalHudBlinkChip");
  const modalPauseCamBtn = document.getElementById("modalPauseCamBtn");
  const modalAutoMarkToggle = document.getElementById("modalAutoMarkToggle");

  let modalIsTracking = false;
  let modalIsCapturing = false;
  let modalTargetBoxes = [];
  let modalCurrentBoxes = [];
  let modalDetectedLandmarks = [];
  let modalPositionStatus = "SEARCHING";
  let modalFaceCount = 0;
  let modalFaceWidth = 0;
  let modalTrackPending = false;
  let modalTrackInterval = null;
  let modalFaceLockedFrames = 0;
  let modalIsCamPaused = false;

  async function openStudentFaceScanModal(sessionId, courseTitle) {
    modalScanSessionId = sessionId;
    if (modalCourseTitle) modalCourseTitle.textContent = `Course: ${courseTitle}`;
    if (modalScanResultContainer) modalScanResultContainer.innerHTML = "";
    if (modalScanProgressContainer) modalScanProgressContainer.classList.add("hidden");
    if (triggerModalScanBtn) triggerModalScanBtn.disabled = false;
    if (studentFaceScanModal) studentFaceScanModal.classList.remove("hidden");
    modalIsCapturing = false;
    modalIsTracking = false;
    modalTargetBoxes = [];
    modalCurrentBoxes = [];
    modalDetectedLandmarks = [];
    modalFaceLockedFrames = 0;
    modalIsCamPaused = false;
    if (modalPauseCamBtn) modalPauseCamBtn.textContent = "Pause Camera";

    updateModalHudChips(0, 0, "SEARCHING");

    try {
      modalScanStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false
      });
      if (modalScanVideo) {
        modalScanVideo.srcObject = modalScanStream;
        modalScanVideo.onloadedmetadata = () => {
          modalScanVideo.play();
          if (modalScanStandby) modalScanStandby.style.display = "none";
          modalIsTracking = true;
          startModalHudTracking();
        };
      }
    } catch (e) {
      if (modalScanResultContainer) {
        modalScanResultContainer.innerHTML = `<div class="alert-callout-box error">Unable to access camera: ${escapeHtml(e.message)}</div>`;
      }
    }
  }

  function closeStudentFaceScanModal() {
    modalIsTracking = false;
    if (modalTrackInterval) {
      clearInterval(modalTrackInterval);
      modalTrackInterval = null;
    }
    if (modalScanStream) {
      modalScanStream.getTracks().forEach(t => t.stop());
      modalScanStream = null;
    }
    if (studentFaceScanModal) studentFaceScanModal.classList.add("hidden");
    if (modalScanStandby) modalScanStandby.style.display = "flex";
    modalTargetBoxes = [];
    modalCurrentBoxes = [];
    modalDetectedLandmarks = [];
    updateModalHudChips(0, 0, "SEARCHING");
  }

  if (closeFaceScanModalBtn) closeFaceScanModalBtn.addEventListener("click", closeStudentFaceScanModal);
  if (cancelFaceScanBtn) cancelFaceScanBtn.addEventListener("click", closeStudentFaceScanModal);

  if (modalPauseCamBtn) {
    modalPauseCamBtn.addEventListener("click", () => {
      if (!modalScanStream) return;
      modalIsCamPaused = !modalIsCamPaused;
      modalScanStream.getVideoTracks().forEach(t => { t.enabled = !modalIsCamPaused; });
      modalPauseCamBtn.textContent = modalIsCamPaused ? "Resume Camera" : "Pause Camera";
    });
  }

  function updateModalHudChips(faceCount, faceWidth, posStatus) {
    modalFaceCount = faceCount;
    modalFaceWidth = faceWidth;
    modalPositionStatus = posStatus;

    if (modalHudFacesChip) {
      modalHudFacesChip.textContent = `Faces: ${faceCount}`;
      if (faceCount === 1) {
        modalHudFacesChip.style.color = "#10b981";
        modalHudFacesChip.style.borderColor = "rgba(16, 185, 129, 0.4)";
      } else if (faceCount > 1) {
        modalHudFacesChip.textContent = `Faces: ${faceCount} (Multiple)`;
        modalHudFacesChip.style.color = "#ef4444";
        modalHudFacesChip.style.borderColor = "rgba(239, 68, 68, 0.4)";
      } else {
        modalHudFacesChip.style.color = "#ffffff";
        modalHudFacesChip.style.borderColor = "rgba(255, 255, 255, 0.14)";
      }
    }

    if (modalHudDistanceChip) {
      if (faceCount === 0) {
        modalHudDistanceChip.textContent = "Align Face";
        modalHudDistanceChip.style.color = "var(--text-muted)";
      } else if (faceCount > 1) {
        modalHudDistanceChip.textContent = "Multiple Faces Detected";
        modalHudDistanceChip.style.color = "#ef4444";
      } else {
        const roundedW = Math.round(faceWidth);
        if (posStatus === "MOVE_CLOSER") {
          modalHudDistanceChip.textContent = `Size: ${roundedW}px (Move Closer)`;
          modalHudDistanceChip.style.color = "#f59e0b";
        } else if (posStatus === "TOO_CLOSE") {
          modalHudDistanceChip.textContent = `Size: ${roundedW}px (Too Close)`;
          modalHudDistanceChip.style.color = "#f59e0b";
        } else if (posStatus === "ALIGN_CENTER") {
          modalHudDistanceChip.textContent = `Size: ${roundedW}px (Center Face)`;
          modalHudDistanceChip.style.color = "#f59e0b";
        } else {
          modalHudDistanceChip.textContent = `Size: ${roundedW}px (Optimal)`;
          modalHudDistanceChip.style.color = "#10b981";
        }
      }
    }

    if (modalHudBlinkChip) {
      modalHudBlinkChip.textContent = "Blink Liveness: Active";
    }
  }

  async function detectModalFaceFrame() {
    if (!modalIsTracking || !modalScanVideo || !modalScanVideo.videoWidth || modalTrackPending || modalIsCapturing || modalIsCamPaused) return;

    const vw = modalScanVideo.videoWidth;
    const vh = modalScanVideo.videoHeight;

    // Fast path: Native FaceDetector if supported
    if (nativeFaceDetector) {
      try {
        const detectedFaces = await nativeFaceDetector.detect(modalScanVideo);
        if (detectedFaces && detectedFaces.length > 0) {
          const count = detectedFaces.length;
          modalTargetBoxes = detectedFaces.map(f => {
            const b = f.boundingBox;
            const mirroredX = vw - b.x - b.width;
            return {
              x: mirroredX,
              y: b.y,
              w: b.width,
              h: b.height,
              faceCount: count
            };
          });

          const primary = detectedFaces[0].boundingBox;
          const boxW = primary.width;
          const boxCx = primary.x + primary.width / 2;

          let posStatus = "OPTIMAL";
          if (count > 1) posStatus = "MULTIPLE_FACES";
          else if (boxW < 75) posStatus = "MOVE_CLOSER";
          else if (boxW > vw * 0.85) posStatus = "TOO_CLOSE";
          else if (Math.abs(boxCx - vw / 2) > vw * 0.28) posStatus = "ALIGN_CENTER";

          // Approximate landmarks from bounding box if not provided
          const bx = vw - primary.x - primary.width;
          const by = primary.y;
          modalDetectedLandmarks = [
            [bx + boxW * 0.32, by + primary.height * 0.38],
            [bx + boxW * 0.68, by + primary.height * 0.38],
            [bx + boxW * 0.50, by + primary.height * 0.55],
            [bx + boxW * 0.36, by + primary.height * 0.74],
            [bx + boxW * 0.64, by + primary.height * 0.74]
          ];

          updateModalHudChips(count, boxW, posStatus);
          checkModalAutoMark(count, posStatus);
          return;
        } else {
          modalTargetBoxes = [];
          modalDetectedLandmarks = [];
          updateModalHudChips(0, 0, "SEARCHING");
          modalFaceLockedFrames = 0;
          return;
        }
      } catch (e) {
        // Fallback to backend YuNet tracking
      }
    }

    // Backend YuNet Tracking Ping
    modalTrackPending = true;
    try {
      const snapCanvas = document.createElement("canvas");
      snapCanvas.width = 320;
      snapCanvas.height = 240;
      const ctx = snapCanvas.getContext("2d");
      ctx.drawImage(modalScanVideo, 0, 0, 320, 240);
      const b64 = snapCanvas.toDataURL("image/jpeg", 0.6);

      const { ok, data } = await safeFetchJson("/api/face/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frame: b64 })
      });

      if (ok && data && data.detected && data.box) {
        const scaleX = vw / 320;
        const scaleY = vh / 240;

        const allBoxes = data.all_boxes || [data.box];
        modalTargetBoxes = allBoxes.map(b => {
          const rawX = b[0] * scaleX;
          const rawY = b[1] * scaleY;
          const rawW = b[2] * scaleX;
          const rawH = b[3] * scaleY;
          return {
            x: vw - rawX - rawW,
            y: rawY,
            w: rawW,
            h: rawH,
            faceCount: data.face_count
          };
        });

        if (data.landmarks) {
          modalDetectedLandmarks = data.landmarks.map(pt => [
            vw - (pt[0] * scaleX),
            pt[1] * scaleY
          ]);
        }

        const primaryW = data.box[2] * scaleX;
        const posStatus = data.position_status || (data.face_count > 1 ? "MULTIPLE_FACES" : (data.usable ? "OPTIMAL" : "MOVE_CLOSER"));

        updateModalHudChips(data.face_count, primaryW, posStatus);
        checkModalAutoMark(data.face_count, posStatus);
      } else {
        modalTargetBoxes = [];
        modalDetectedLandmarks = [];
        updateModalHudChips(0, 0, "SEARCHING");
        modalFaceLockedFrames = 0;
      }
    } catch (e) {
      // Ignore
    } finally {
      modalTrackPending = false;
    }
  }

  function checkModalAutoMark(faceCount, posStatus) {
    if (!modalAutoMarkToggle || !modalAutoMarkToggle.checked || modalIsCapturing) {
      modalFaceLockedFrames = 0;
      return;
    }

    if (faceCount === 1 && posStatus === "OPTIMAL") {
      modalFaceLockedFrames++;
      if (modalFaceLockedFrames >= 7) { // Locked for ~1.1s
        modalFaceLockedFrames = 0;
        if (triggerModalScanBtn && !triggerModalScanBtn.disabled) {
          triggerModalScanBtn.click();
        }
      }
    } else {
      modalFaceLockedFrames = 0;
    }
  }

  function startModalHudTracking() {
    if (modalTrackInterval) clearInterval(modalTrackInterval);
    modalTrackInterval = setInterval(detectModalFaceFrame, 160);
    requestAnimationFrame(renderModalTrackingHUD);
  }

  function renderModalTrackingHUD() {
    if (!modalIsTracking || !modalScanHudCanvas || !modalScanVideo) return;

    const ctx = modalScanHudCanvas.getContext("2d");
    const width = modalScanHudCanvas.width;
    const height = modalScanHudCanvas.height;
    ctx.clearRect(0, 0, width, height);

    if (modalScanVideo.videoWidth && modalScanHudCanvas.width !== modalScanVideo.videoWidth) {
      modalScanHudCanvas.width = modalScanVideo.videoWidth;
      modalScanHudCanvas.height = modalScanVideo.videoHeight;
    }

    // Lerp boxes towards targets
    if (modalTargetBoxes.length > 0) {
      if (modalCurrentBoxes.length !== modalTargetBoxes.length) {
        modalCurrentBoxes = modalTargetBoxes.map(b => ({ ...b }));
      } else {
        const factor = 0.38;
        for (let i = 0; i < modalTargetBoxes.length; i++) {
          const tb = modalTargetBoxes[i];
          const cb = modalCurrentBoxes[i];
          cb.x += (tb.x - cb.x) * factor;
          cb.y += (tb.y - cb.y) * factor;
          cb.w += (tb.w - cb.w) * factor;
          cb.h += (tb.h - cb.h) * factor;
          cb.faceCount = tb.faceCount;
        }
      }
    } else {
      modalCurrentBoxes = [];
    }

    if (modalCurrentBoxes.length > 0 && !modalIsCapturing) {
      modalCurrentBoxes.forEach((box, idx) => {
        const bx = box.x;
        const by = box.y;
        const bw = box.w;
        const bh = box.h;

        let hudColor = "#10b981"; // Green (Optimal)
        if (box.faceCount > 1) {
          hudColor = "#ef4444"; // Red (Multiple faces warning)
        } else if (modalPositionStatus === "MOVE_CLOSER" || modalPositionStatus === "TOO_CLOSE" || modalPositionStatus === "ALIGN_CENTER") {
          hudColor = "#f59e0b"; // Amber (Position adjustment needed)
        }

        const cornerLen = Math.min(28, bw * 0.28);
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = hudColor;
        ctx.lineCap = "round";

        // 4 Corner Brackets
        // Top-Left
        ctx.beginPath();
        ctx.moveTo(bx, by + cornerLen);
        ctx.lineTo(bx, by);
        ctx.lineTo(bx + cornerLen, by);
        ctx.stroke();

        // Top-Right
        ctx.beginPath();
        ctx.moveTo(bx + bw - cornerLen, by);
        ctx.lineTo(bx + bw, by);
        ctx.lineTo(bx + bw, by + cornerLen);
        ctx.stroke();

        // Bottom-Right
        ctx.beginPath();
        ctx.moveTo(bx + bw, by + bh - cornerLen);
        ctx.lineTo(bx + bw, by + bh);
        ctx.lineTo(bx + bw - cornerLen, by + bh);
        ctx.stroke();

        // Bottom-Left
        ctx.beginPath();
        ctx.moveTo(bx + cornerLen, by + bh);
        ctx.lineTo(bx, by + bh);
        ctx.lineTo(bx, by + bh - cornerLen);
        ctx.stroke();

        // Animated laser scanning beam inside the primary face box
        if (idx === 0) {
          const scanY = by + (Math.sin(Date.now() / 240) * 0.5 + 0.5) * bh;
          const scanGrad = ctx.createLinearGradient(bx, scanY, bx + bw, scanY);
          scanGrad.addColorStop(0, "rgba(59, 130, 246, 0)");
          scanGrad.addColorStop(0.5, hudColor === "#ef4444" ? "rgba(239, 68, 68, 0.7)" : "rgba(6, 182, 212, 0.75)");
          scanGrad.addColorStop(1, "rgba(59, 130, 246, 0)");

          ctx.lineWidth = 2;
          ctx.strokeStyle = scanGrad;
          ctx.beginPath();
          ctx.moveTo(bx + 4, scanY);
          ctx.lineTo(bx + bw - 4, scanY);
          ctx.stroke();

          // 5 Cyan Facial Landmarks
          if (modalDetectedLandmarks.length > 0) {
            ctx.fillStyle = hudColor === "#ef4444" ? "rgba(239, 68, 68, 0.85)" : "rgba(6, 182, 212, 0.9)";
            ctx.shadowColor = hudColor === "#ef4444" ? "#ef4444" : "#06b6d4";
            ctx.shadowBlur = 4;
            modalDetectedLandmarks.forEach(pt => {
              ctx.beginPath();
              ctx.arc(pt[0], pt[1], 3.2, 0, Math.PI * 2);
              ctx.fill();
            });
            ctx.shadowBlur = 0;
          }
        }

        // Pinned Status Pill Badge above Face
        let labelText = "FACE LOCKED • READY";
        if (box.faceCount > 1) {
          labelText = `MULTIPLE FACES (${box.faceCount}) DETECTED`;
        } else if (modalPositionStatus === "MOVE_CLOSER") {
          labelText = "MOVE CLOSER";
        } else if (modalPositionStatus === "TOO_CLOSE") {
          labelText = "TOO CLOSE";
        } else if (modalPositionStatus === "ALIGN_CENTER") {
          labelText = "CENTER FACE";
        }

        ctx.font = "bold 12px 'Plus Jakarta Sans', sans-serif";
        const textWidth = ctx.measureText(labelText).width;
        const pad = 16;
        const tagH = 24;
        const tagX = bx + (bw - textWidth - pad) / 2;
        const tagY = Math.max(10, by - tagH - 8);

        ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(tagX, tagY, textWidth + pad, tagH, 6);
        else ctx.rect(tagX, tagY, textWidth + pad, tagH);
        ctx.fill();

        ctx.lineWidth = 1.5;
        ctx.strokeStyle = hudColor;
        ctx.stroke();

        ctx.fillStyle = hudColor;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(labelText, tagX + (textWidth + pad) / 2, tagY + tagH / 2);
        ctx.textAlign = "start";
      });
    } else if (!isCapturing && !modalIsCapturing) {
      // Subtle oval guide when searching
      const cx = modalScanHudCanvas.width / 2;
      const cy = modalScanHudCanvas.height / 2;
      const rx = 100, ry = 135;
      ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (modalIsTracking) {
      requestAnimationFrame(renderModalTrackingHUD);
    }
  }

  if (triggerModalScanBtn) {
    triggerModalScanBtn.addEventListener("click", async () => {
      if (!modalScanSessionId || !modalScanVideo || modalIsCapturing) return;
      modalIsCapturing = true;
      triggerModalScanBtn.disabled = true;
      if (modalScanProgressContainer) modalScanProgressContainer.classList.remove("hidden");
      if (modalScanBlinkPrompt) modalScanBlinkPrompt.classList.remove("hidden");

      // Capture 20 burst frames
      const frames = [];
      const ctx = modalScanHiddenCanvas.getContext("2d");
      const total = 20;

      for (let i = 0; i < total; i++) {
        ctx.drawImage(modalScanVideo, 0, 0, modalScanHiddenCanvas.width, modalScanHiddenCanvas.height);
        frames.push(modalScanHiddenCanvas.toDataURL("image/jpeg", 0.7));
        const pct = Math.round(((i + 1) / total) * 100);
        if (modalScanProgressFill) modalScanProgressFill.style.width = `${pct}%`;
        if (modalScanPercentText) modalScanPercentText.textContent = `${pct}%`;
        await new Promise(r => setTimeout(r, 100));
      }

      if (modalScanBlinkPrompt) modalScanBlinkPrompt.classList.add("hidden");

      const { ok, status, data } = await safeFetchJson("/api/attendance/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: modalScanSessionId,
          frames: frames
        })
      });

      if (ok && data.verdict === "ok") {
        playSound("success");
        const rec = data.record;
        modalScanResultContainer.innerHTML = `
          <div class="verdict-banner-official success" style="margin-top:14px;">
            <div class="verdict-header-row">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
              <div>
                <div style="font-size:1.05rem; font-weight:700;">Attendance Recorded: PRESENT ✓</div>
                <div style="font-size:0.82rem; opacity:0.9;">Committed to Hedera SCS Blockchain • Tx: ${shorten(rec.tx_hash, 12)}</div>
              </div>
            </div>
            <div style="margin-top:10px; font-size:0.84rem; display:flex; gap:16px;">
              <div><strong>Match Score:</strong> ${Math.round(rec.match_score * 100)}%</div>
              <div><strong>Blinks:</strong> ${rec.blink_count}</div>
              <div><a href="${rec.explorer_url}" target="_blank" style="color:#ffffff; text-decoration:underline;">View on HashScan →</a></div>
            </div>
          </div>
        `;
        modalIsCapturing = false;
        if (currentStudentData) loadStudentDashboard(currentStudentData.roll_no);
        notifySessionSync(modalScanSessionId);
        showToast("Attendance Marked: PRESENT ✓ Committed to Blockchain", "success");
      } else {
        playSound("error");
        modalIsCapturing = false;
        let explanation = data.error || 'Face verification could not be completed.';
        let headline = `Verification Failed: ${data.verdict || 'Error'}`;

        if (data.verdict === 'session_inactive') {
          headline = "Attendance Window Closed";
          explanation = "This lecture session has ended or expired. Please ask your professor to start a live attendance window.";
        } else if (data.verdict === 'not_enrolled_in_group') {
          headline = "Not Enrolled in Course Group";
          explanation = "You are not enrolled in this course group. Please join via invite code in your dashboard first.";
        } else if (data.verdict === 'already_marked') {
          headline = "Already Marked Present ✓";
          explanation = "Your attendance has already been verified and cryptographically recorded for this session.";
        }

        modalScanResultContainer.innerHTML = `
          <div class="verdict-banner-official failed" style="margin-top:14px;">
            <div class="verdict-header-row">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
              <div>
                <div style="font-size:1.05rem; font-weight:700;">${escapeHtml(headline)}</div>
                <div style="font-size:0.84rem; opacity:0.9;">${escapeHtml(explanation)}</div>
              </div>
            </div>
          </div>
        `;
        triggerModalScanBtn.disabled = false;
      }
    });
  }

  // --- Faculty & Course Groups Console ---
  async function loadFacultyConsole() {
    const email = getFacultyEmail();
    const facNameEl = document.getElementById("facultyConsoleName");
    const facDeptEl = document.getElementById("facultyConsoleDept");
    if (currentFacultyData) {
      if (facNameEl) facNameEl.textContent = currentFacultyData.name || "Dr. Alan Turing";
      if (facDeptEl) facDeptEl.textContent = currentFacultyData.department || "Dept. of Computer Science";
    }

    try {
      const { ok, data } = await safeFetchJson(`/api/faculty/groups?email=${encodeURIComponent(email)}`);
      if (ok && data) {
        renderFacultyGroups(data.groups || []);
      }
    } catch (e) {
      console.warn("Faculty groups load error:", e);
    }
  }

  function renderFacultyGroups(groups) {
    const grid = document.getElementById("facultyGroupsGrid");
    const badge = document.getElementById("facultyGroupCountBadge");
    if (badge) badge.textContent = `${groups.length} Groups Active`;
    if (!grid) return;

    if (!groups || groups.length === 0) {
      grid.innerHTML = `
        <div style="grid-column:1/-1; padding:32px; text-align:center; color:var(--text-muted); background:var(--bg-subtle); border-radius:var(--radius-lg);">
          <h4>No Subject Groups Created Yet</h4>
          <p style="margin-top:4px;">Click <strong>Create Subject Group</strong> above to create your first class and generate an invite code for students.</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = groups.map(g => {
      const hasActive = g.active_session !== null && g.active_session !== undefined;
      const borderClass = hasActive ? "border-color:var(--accent-success); box-shadow:0 0 0 1.5px var(--accent-success);" : "";

      return `
        <div class="group-card" style="${borderClass}">
          <div>
            <div class="group-card-header">
              <span class="group-subject-code">${escapeHtml(g.subject_code)}</span>
              ${hasActive ? `<span class="badge badge-success" style="animation:pulseLive 1.6s infinite;"><span class="class-live-dot" style="margin-right:4px;"></span>Attendance Active</span>` : `<span class="badge" style="background:var(--bg-subtle); color:var(--text-muted);">Inactive</span>`}
            </div>
            <div class="group-card-title">${escapeHtml(g.name)}</div>
            <div class="group-card-meta">
              <div>Department: <strong>${escapeHtml(g.department || 'Computer Science')}</strong></div>
              <div>Enrolled Students: <strong>${g.enrolled_count ?? g.enrolled_students_count ?? 0}</strong> • Total Sessions: <strong>${g.total_sessions || 0}</strong></div>
            </div>

            <!-- Student Invite Code Pill -->
            <div class="invite-code-wrap">
              <span style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Invite Code:</span>
              <span class="invite-code-text" id="inviteCode_${g.id}">${escapeHtml(g.invite_code)}</span>
              <button class="copy-invite-btn" data-code="${escapeHtml(g.invite_code)}" title="Copy Invite Code to Clipboard">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
            </div>
          </div>

          <div class="group-card-footer">
            <button class="btn-outline-action view-group-students-btn" data-group-id="${g.id}" data-group-name="${escapeHtml(g.name)}" type="button" style="width:auto; padding:0 12px; font-size:0.8rem; display:inline-flex; align-items:center; gap:6px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
              <span>Enrolled (${g.enrolled_count ?? g.enrolled_students_count ?? 0})</span>
            </button>

            ${hasActive ? `
              <div style="display:flex; gap:8px;">
                <a href="/api/sessions/${g.active_session.session_id}/attendance.csv" class="btn-secondary-action" style="width:auto; padding:0 10px; font-size:0.8rem; text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                  <span>CSV</span>
                </a>
                <button class="btn-danger-action close-group-attendance-btn" data-group-id="${g.id}" data-group-name="${escapeHtml(g.name)}" type="button" style="width:auto; padding:0 14px; font-size:0.8rem;">
                  Close
                </button>
              </div>
            ` : `
              <button class="btn-primary-action take-group-attendance-btn" data-group-id="${g.id}" data-group-name="${escapeHtml(g.name)}" type="button" style="width:auto; padding:0 16px; font-size:0.84rem; display:inline-flex; align-items:center; gap:6px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg>
                <span>Take Attendance</span>
              </button>
            `}
          </div>
        </div>
      `;
    }).join("");

    // Attach copy invite code listeners
    grid.querySelectorAll(".copy-invite-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const code = btn.dataset.code;
        navigator.clipboard.writeText(code).then(() => {
          playSound("blip");
          btn.innerHTML = `<span style="font-size:0.75rem; color:var(--accent-success); font-weight:700;">Copied!</span>`;
          setTimeout(() => {
            btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
          }, 2000);
        });
      });
    });

    // Attach "View Students" modal listeners
    grid.querySelectorAll(".view-group-students-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        openFacultyStudentsModal(btn.dataset.groupId, btn.dataset.groupName);
      });
    });

    // Attach "Take Attendance" listeners
    grid.querySelectorAll(".take-group-attendance-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const groupId = btn.dataset.groupId;
        const groupName = btn.dataset.groupName;
        const mins = prompt(`Start Attendance for ${groupName}:\nEnter duration in minutes (e.g. 15, 30, 45, 60):`, "60");
        if (!mins) return;
        const dur = parseInt(mins, 10);
        if (isNaN(dur) || dur < 1 || dur > 720) {
          showToast("Please enter a valid duration between 1 and 720 minutes.", "error");
          return;
        }

        btn.disabled = true;
        btn.style.opacity = "0.75";
        const origHtml = btn.innerHTML;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm" style="width:13px; height:13px; border:2px solid currentColor; border-top-color:transparent; border-radius:50%; display:inline-block; animation:spin 0.7s linear infinite;"></span> <span>Activating...</span>`;

        try {
          const { ok, data } = await safeFetchJson(`/api/faculty/groups/${groupId}/take-attendance`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ duration_minutes: dur })
          });

          if (ok && data.ok) {
            playSound("success");
            showToast(`Attendance window opened for ${groupName} (${dur}m)! Students can now scan face.`, "success");
            loadFacultyConsole();
            loadActiveSessions();
            notifySessionSync(groupId);
          } else {
            playSound("error");
            btn.disabled = false;
            btn.style.opacity = "1";
            btn.innerHTML = origHtml;
            showToast(data.error || "Failed to open attendance session.", "error");
          }
        } catch (err) {
          btn.disabled = false;
          btn.style.opacity = "1";
          btn.innerHTML = origHtml;
          showToast("Network error opening attendance.", "error");
        }
      });
    });

    // Attach "Close Attendance" listeners
    grid.querySelectorAll(".close-group-attendance-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const groupId = btn.dataset.groupId;
        const groupName = btn.dataset.groupName || "Course Lecture";
        if (!confirm("Are you sure you want to close and lock the attendance window for this lecture?")) return;

        btn.disabled = true;
        btn.style.opacity = "0.75";
        btn.innerHTML = `<span class="spinner-border spinner-border-sm" style="width:13px; height:13px; border:2px solid currentColor; border-top-color:transparent; border-radius:50%; display:inline-block; animation:spin 0.7s linear infinite;"></span> <span>Closing...</span>`;

        try {
          const { ok, data } = await safeFetchJson(`/api/faculty/groups/${groupId}/close-attendance`, {
            method: "POST",
            headers: { "Content-Type": "application/json" }
          });

          if (ok && data.ok) {
            playSound("success");
            showToast(`Attendance window closed and locked for ${groupName}.`, "info");
            loadFacultyConsole();
            loadActiveSessions();
            notifySessionSync(groupId);
          } else {
            showToast(data.error || "Failed to close attendance session.", "error");
            loadFacultyConsole();
          }
        } catch (err) {
          showToast("Network error closing attendance.", "error");
          loadFacultyConsole();
        }
      });
    });
  }

  // --- Faculty Create Group Modal ---
  const facultyCreateGroupModal = document.getElementById("facultyCreateGroupModal");
  const openCreateGroupModalBtn = document.getElementById("openCreateGroupModalBtn");
  const closeCreateGroupModalBtn = document.getElementById("closeCreateGroupModalBtn");
  const cancelCreateGroupBtn = document.getElementById("cancelCreateGroupBtn");
  const submitCreateGroupBtn = document.getElementById("submitCreateGroupBtn");
  const createGroupName = document.getElementById("createGroupName");
  const createGroupCode = document.getElementById("createGroupCode");
  const createGroupDept = document.getElementById("createGroupDept");
  const createGroupAlert = document.getElementById("createGroupAlert");

  if (openCreateGroupModalBtn) {
    openCreateGroupModalBtn.addEventListener("click", () => {
      if (createGroupAlert) createGroupAlert.classList.add("hidden");
      if (facultyCreateGroupModal) facultyCreateGroupModal.classList.remove("hidden");
    });
  }
  if (closeCreateGroupModalBtn) closeCreateGroupModalBtn.addEventListener("click", () => facultyCreateGroupModal.classList.add("hidden"));
  if (cancelCreateGroupBtn) cancelCreateGroupBtn.addEventListener("click", () => facultyCreateGroupModal.classList.add("hidden"));

  if (submitCreateGroupBtn) {
    submitCreateGroupBtn.addEventListener("click", async () => {
      const name = createGroupName ? createGroupName.value.trim() : "";
      const code = createGroupCode ? createGroupCode.value.trim().toUpperCase() : "";
      const dept = createGroupDept ? createGroupDept.value.trim() : "Computer Science";
      if (!name || !code) {
        alert("Please enter both Subject Title and Course Code.");
        return;
      }

      const { ok, data } = await safeFetchJson("/api/faculty/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name,
          subject_code: code,
          department: dept,
          faculty_email: getFacultyEmail()
        })
      });

      if (ok && data.ok) {
        playSound("success");
        if (createGroupAlert) {
          createGroupAlert.className = "alert-callout-box success";
          createGroupAlert.textContent = `Group created! Invite Code: ${data.group.invite_code}`;
          createGroupAlert.classList.remove("hidden");
        }
        setTimeout(() => {
          if (facultyCreateGroupModal) facultyCreateGroupModal.classList.add("hidden");
          if (createGroupName) createGroupName.value = "";
          if (createGroupCode) createGroupCode.value = "";
          loadFacultyConsole();
        }, 1200);
      } else {
        playSound("error");
        if (createGroupAlert) {
          createGroupAlert.className = "alert-callout-box error";
          createGroupAlert.textContent = data.error || "Failed to create group.";
          createGroupAlert.classList.remove("hidden");
        }
      }
    });
  }

  // --- Faculty Students Roster Modal ---
  const facultyStudentsModal = document.getElementById("facultyStudentsModal");
  const closeStudentsModalBtn = document.getElementById("closeStudentsModalBtn");
  const closeStudentsModalBtn2 = document.getElementById("closeStudentsModalBtn2");
  const studentsModalTitle = document.getElementById("studentsModalTitle");
  const studentsModalSubtitle = document.getElementById("studentsModalSubtitle");
  const studentsModalTbody = document.getElementById("studentsModalTbody");

  async function openFacultyStudentsModal(groupId, groupName) {
    if (studentsModalTitle) studentsModalTitle.textContent = `Enrolled Students — ${groupName}`;
    if (studentsModalSubtitle) studentsModalSubtitle.textContent = `Group #${groupId} • Official Course Attendance Roster`;
    if (studentsModalTbody) studentsModalTbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:20px;">Loading student roster...</td></tr>`;
    if (facultyStudentsModal) facultyStudentsModal.classList.remove("hidden");

    const { ok, data } = await safeFetchJson(`/api/faculty/groups/${groupId}/students`);
    if (ok && data) {
      const students = data.students || [];
      if (students.length === 0) {
        studentsModalTbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:24px; color:var(--text-muted);">No students have joined this course group yet. Share the invite code with your students!</td></tr>`;
        return;
      }

      studentsModalTbody.innerHTML = students.map(s => {
        const pct = s.attendance_percent || 0;
        const color = s.is_defaulter ? "var(--accent-danger)" : "var(--accent-success)";
        const status = s.is_defaulter ? `<span class="badge badge-danger">Shortage (< 75%)</span>` : `<span class="badge badge-success">Eligible ✓</span>`;
        return `
          <tr>
            <td style="font-weight:700; font-family:var(--font-mono); color:var(--primary-blue);">${escapeHtml(s.roll_no)}</td>
            <td style="font-weight:600;">${escapeHtml(s.name)}</td>
            <td>${s.attended_sessions} / ${s.total_sessions}</td>
            <td style="font-weight:700; color:${color};">${pct}%</td>
            <td>${status}</td>
          </tr>
        `;
      }).join("");
    }
  }

  if (closeStudentsModalBtn) closeStudentsModalBtn.addEventListener("click", () => facultyStudentsModal.classList.add("hidden"));
  if (closeStudentsModalBtn2) closeStudentsModalBtn2.addEventListener("click", () => facultyStudentsModal.classList.add("hidden"));

  // --- Central Organization Admin Console ---
  async function loadAdminConsole() {
    loadAdminFaceResets();
    try {
      const { ok, data } = await safeFetchJson("/api/admin/overview", {
        headers: { "X-Admin-Token": getAdminToken() }
      });
      if (ok && data) {
        const facCountEl = document.getElementById("superAdminFacCount");
        const grpCountEl = document.getElementById("superAdminGroupCount");
        const stuCountEl = document.getElementById("superAdminStudentCount");
        const txCountEl = document.getElementById("superAdminTxCount");

        if (facCountEl) facCountEl.textContent = data.total_faculties || 0;
        if (grpCountEl) grpCountEl.textContent = data.total_groups || 0;
        if (stuCountEl) stuCountEl.textContent = data.total_students || 0;
        if (txCountEl) txCountEl.textContent = data.total_attendance_records || 0;

        // Render Faculty Directory Table
        const facTbody = document.getElementById("superAdminFacultyTbody");
        if (facTbody && data.faculties) {
          facTbody.innerHTML = data.faculties.map(f => `
            <tr>
              <td style="font-weight:700;">${escapeHtml(f.name)}</td>
              <td style="font-family:var(--font-mono);">${escapeHtml(f.email)}</td>
              <td>${escapeHtml(f.department || 'Engineering')}</td>
              <td><strong>${f.total_groups || 0}</strong> Groups</td>
              <td><span class="badge badge-success">Active Faculty</span></td>
            </tr>
          `).join("");
        }

        // Render All Groups Table
        const grpTbody = document.getElementById("superAdminGroupsTbody");
        if (grpTbody && data.groups) {
          grpTbody.innerHTML = data.groups.map(g => `
            <tr>
              <td style="font-weight:700; font-family:var(--font-mono); color:var(--primary-blue);">${escapeHtml(g.subject_code)}</td>
              <td style="font-weight:600;">${escapeHtml(g.name)}</td>
              <td>${escapeHtml(g.department || 'Engineering')}</td>
              <td>${escapeHtml(g.faculty_name || g.faculty_email)}</td>
              <td><code>${escapeHtml(g.invite_code)}</code></td>
              <td><strong>${g.enrolled_count || 0}</strong> Students</td>
            </tr>
          `).join("");
        }
      }
    } catch (e) {
      console.warn("Admin console error:", e);
    }
  }

  // --- Admin Add Faculty Modal ---
  const adminAddFacultyModal = document.getElementById("adminAddFacultyModal");
  const openAddFacultyModalBtn = document.getElementById("openAddFacultyModalBtn");
  const superAdminAddFacultyBtn2 = document.getElementById("superAdminAddFacultyBtn2");
  const closeAddFacultyModalBtn = document.getElementById("closeAddFacultyModalBtn");
  const cancelAddFacultyBtn = document.getElementById("cancelAddFacultyBtn");
  const submitAddFacultyBtn = document.getElementById("submitAddFacultyBtn");
  const addFacultyName = document.getElementById("addFacultyName");
  const addFacultyEmail = document.getElementById("addFacultyEmail");
  const addFacultyDept = document.getElementById("addFacultyDept");
  const addFacultyPass = document.getElementById("addFacultyPass");
  const addFacultyAlert = document.getElementById("addFacultyAlert");

  function openAddFacModal() {
    if (addFacultyAlert) addFacultyAlert.classList.add("hidden");
    if (adminAddFacultyModal) adminAddFacultyModal.classList.remove("hidden");
  }

  if (openAddFacultyModalBtn) openAddFacultyModalBtn.addEventListener("click", openAddFacModal);
  if (superAdminAddFacultyBtn2) superAdminAddFacultyBtn2.addEventListener("click", openAddFacModal);
  if (closeAddFacultyModalBtn) closeAddFacultyModalBtn.addEventListener("click", () => adminAddFacultyModal.classList.add("hidden"));
  if (cancelAddFacultyBtn) cancelAddFacultyBtn.addEventListener("click", () => adminAddFacultyModal.classList.add("hidden"));

  if (submitAddFacultyBtn) {
    submitAddFacultyBtn.addEventListener("click", async () => {
      const name = addFacultyName ? addFacultyName.value.trim() : "";
      const email = addFacultyEmail ? addFacultyEmail.value.trim().toLowerCase() : "";
      const dept = addFacultyDept ? addFacultyDept.value.trim() : "Computer Science";
      const pass = addFacultyPass ? addFacultyPass.value.trim() : "faculty123";

      if (!name || !email) {
        alert("Please provide both name and institutional email.");
        return;
      }

      const { ok, data } = await safeFetchJson("/api/admin/faculties", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Token": getAdminToken()
        },
        body: JSON.stringify({ name, email, department: dept, password: pass })
      });

      if (ok && data.ok) {
        playSound("success");
        if (addFacultyAlert) {
          addFacultyAlert.className = "alert-callout-box success";
          addFacultyAlert.textContent = data.message || `Faculty ${name} registered successfully.`;
          addFacultyAlert.classList.remove("hidden");
        }
        setTimeout(() => {
          if (adminAddFacultyModal) adminAddFacultyModal.classList.add("hidden");
          if (addFacultyName) addFacultyName.value = "";
          if (addFacultyEmail) addFacultyEmail.value = "";
          loadAdminConsole();
        }, 1200);
      } else {
        playSound("error");
        if (addFacultyAlert) {
          addFacultyAlert.className = "alert-callout-box error";
          addFacultyAlert.textContent = data.error || "Failed to register faculty.";
          addFacultyAlert.classList.remove("hidden");
        }
      }
    });
  }

  const refreshSuperAdminBtn = document.getElementById("refreshSuperAdminBtn");
  if (refreshSuperAdminBtn) refreshSuperAdminBtn.addEventListener("click", loadAdminConsole);



  // =========================================================================
  // VIEW 2B: STUDENT PROFILE & BIOMETRIC FACE ID LIFECYCLE
  // =========================================================================

  async function loadStudentProfile() {
    if (currentUserRole !== "student" || !currentStudentData || !currentStudentData.roll_no) return;
    const roll = currentStudentData.roll_no;

    try {
      const { ok, data } = await safeFetchJson(`/api/student/${encodeURIComponent(roll)}/profile`);
      if (ok && data && data.student) {
        const stu = data.student;
        currentStudentData = stu;
        sessionStorage.setItem("attendchain_student_data", JSON.stringify(stu));

        const nameEl = document.getElementById("profilePageName");
        const rollEl = document.getElementById("profilePageRoll");
        const emailEl = document.getElementById("profilePageEmail");
        const avatarEl = document.getElementById("profilePageAvatar");
        const regDateEl = document.getElementById("profilePageRegDate");
        const idHashEl = document.getElementById("profilePageIdHash");

        if (nameEl) nameEl.textContent = stu.name || "Student";
        if (rollEl) rollEl.textContent = stu.roll_no;
        if (emailEl) emailEl.textContent = stu.email || `${stu.roll_no}@student.college.edu`;
        if (avatarEl && stu.name) {
          avatarEl.textContent = stu.name.substring(0, 2).toUpperCase();
        }
        if (regDateEl) {
          const dateStr = stu.registered_at ? new Date(stu.registered_at * 1000).toLocaleDateString() : "Registered";
          regDateEl.textContent = dateStr;
        }
        if (idHashEl) idHashEl.textContent = stu.student_id ? shorten(stu.student_id, 12) : "0x...";

        renderProfileFaceIdCard(stu);
      }
    } catch (err) {
      console.warn("loadStudentProfile error:", err);
    }
  }

  function renderProfileFaceIdCard(stu) {
    const wrap = document.getElementById("profileFaceIdStateWrap");
    if (!wrap) return;

    const isEnrolled = stu.face_enrolled;
    const resetStatus = stu.face_reset_status || "NONE";

    if (!isEnrolled && resetStatus !== "APPROVED") {
      // State 1: Unregistered Face ID
      wrap.innerHTML = `
        <div class="face-status-badge unenrolled" style="margin-bottom:12px;">Biometric Face ID Not Enrolled</div>
        <p style="font-size:0.86rem; color:var(--text-muted); margin-bottom:16px; line-height:1.45;">
          You have not enrolled your biometric Face ID yet. In accordance with university attendance regulations, you must capture and register your facial template once to unlock classroom attendance verification.
        </p>
        <button id="profileEnrollFaceBtn" class="btn-primary-action" type="button" style="background:#059669; width:100%; display:flex; align-items:center; justify-content:center; gap:8px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          <span>Enroll Biometric Face ID Now</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
        </button>
      `;
    } else if (isEnrolled && resetStatus !== "APPROVED" && resetStatus !== "PENDING") {
      // State 2: Enrolled & Locked
      wrap.innerHTML = `
        <div class="face-status-badge enrolled" style="margin-bottom:12px;">Face ID Active & Anchored on Hedera Blockchain</div>
        <p style="font-size:0.86rem; color:var(--text-muted); margin-bottom:14px; line-height:1.45;">
          Your biometric face template is cryptographically protected and securely anchored to the Hedera Smart Contract Service.
        </p>
        <div style="background:var(--bg-subtle); padding:10px 14px; border-radius:var(--radius-md); font-size:0.82rem; margin-bottom:14px; font-family:var(--font-mono); color:var(--text-main);">
          Commitment: ${shorten(stu.face_commitment, 12)}
        </div>
        <button class="btn-secondary-action" type="button" disabled style="width:100%; margin-bottom:12px; cursor:not-allowed; opacity:0.85; display:flex; align-items:center; justify-content:center; gap:8px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
          <span>Face ID Registered (Locked)</span>
        </button>
        <div style="text-align:center;">
          <button id="profileRequestResetBtn" class="link-btn" type="button" style="color:var(--primary-blue); font-weight:700; font-size:0.86rem;">
            Request Face ID Reset from Administrator →
          </button>
        </div>
      `;
    } else if (resetStatus === "PENDING") {
      // State 3: Reset Request Pending Admin Approval
      wrap.innerHTML = `
        <div class="face-status-badge pending" style="margin-bottom:12px;">Face ID Reset Request Pending</div>
        <p style="font-size:0.86rem; color:var(--text-muted); margin-bottom:12px; line-height:1.45;">
          Your request to reset your biometric template has been submitted to the Central University Administration for security review.
        </p>
        <div style="background:var(--bg-subtle); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:12px; font-size:0.82rem; margin-bottom:16px;">
          <strong style="color:var(--text-main);">Submitted Reason:</strong>
          <div style="color:var(--text-muted); margin-top:2px;">${escapeHtml(stu.face_reset_reason || 'Biometric update requested')}</div>
        </div>
        <button class="btn-secondary-action" type="button" disabled style="width:100%; cursor:not-allowed; opacity:0.75;">
          Reset Request Under Review
        </button>
      `;
    } else if (resetStatus === "APPROVED") {
      // State 4: Reset Approved by Admin!
      wrap.innerHTML = `
        <div class="face-status-badge approved" style="margin-bottom:12px;">Face ID Reset Approved by Admin</div>
        <p style="font-size:0.86rem; color:var(--text-muted); margin-bottom:16px; line-height:1.45;">
          The university administrator has verified and approved your reset request. Your previous biometric template has been unlocked. Please capture your new Face ID now.
        </p>
        <button id="profileReEnrollFaceBtn" class="btn-primary-action" type="button" style="background:#059669; width:100%; display:flex; align-items:center; justify-content:center; gap:8px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          <span>Enroll New Face ID Now</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
        </button>
      `;
    }

    // Attach listeners
    const enrollBtn = document.getElementById("profileEnrollFaceBtn");
    const reEnrollBtn = document.getElementById("profileReEnrollFaceBtn");
    const resetBtn = document.getElementById("profileRequestResetBtn");

    if (enrollBtn) enrollBtn.addEventListener("click", openFaceEnrollModal);
    if (reEnrollBtn) reEnrollBtn.addEventListener("click", openFaceEnrollModal);
    if (resetBtn) resetBtn.addEventListener("click", openFaceResetModal);
  }

  // =========================================================================
  // MODAL: STUDENT BIOMETRIC FACE ENROLLMENT
  // =========================================================================

  let enrollCameraStream = null;
  const studentFaceEnrollModal = document.getElementById("studentFaceEnrollModal");
  const closeFaceEnrollModalBtn = document.getElementById("closeFaceEnrollModalBtn");
  const cancelFaceEnrollBtn = document.getElementById("cancelFaceEnrollBtn");
  const triggerEnrollFaceBtn = document.getElementById("triggerEnrollFaceBtn");
  const enrollVideo = document.getElementById("enrollVideo");
  const enrollHudCanvas = document.getElementById("enrollHudCanvas");
  const enrollHiddenCanvas = document.getElementById("enrollHiddenCanvas");
  const enrollStandby = document.getElementById("enrollStandby");
  const enrollProgressContainer = document.getElementById("enrollProgressContainer");
  const enrollProgressFill = document.getElementById("enrollProgressFill");
  const enrollPercentText = document.getElementById("enrollPercentText");
  const enrollStatusText = document.getElementById("enrollStatusText");
  const enrollResultContainer = document.getElementById("enrollResultContainer");

  async function openFaceEnrollModal() {
    playSound("click");
    if (studentFaceEnrollModal) studentFaceEnrollModal.classList.remove("hidden");
    if (enrollProgressContainer) enrollProgressContainer.classList.add("hidden");
    if (enrollResultContainer) enrollResultContainer.innerHTML = "";
    if (triggerEnrollFaceBtn) {
      triggerEnrollFaceBtn.disabled = false;
      triggerEnrollFaceBtn.style.opacity = "1";
    }

    try {
      enrollCameraStream = await startCamera(enrollVideo, enrollStandby);
    } catch (e) {
      console.warn("Could not start camera for enrollment:", e);
    }
  }

  function closeFaceEnrollModal() {
    playSound("click");
    if (studentFaceEnrollModal) studentFaceEnrollModal.classList.add("hidden");
    if (enrollCameraStream) {
      stopCamera(enrollCameraStream, enrollVideo, enrollStandby);
      enrollCameraStream = null;
    }
  }

  if (closeFaceEnrollModalBtn) closeFaceEnrollModalBtn.addEventListener("click", closeFaceEnrollModal);
  if (cancelFaceEnrollBtn) cancelFaceEnrollBtn.addEventListener("click", closeFaceEnrollModal);

  async function triggerEnrollFaceCapture() {
    if (!currentStudentData || !currentStudentData.roll_no) {
      alert("Student profile not loaded.");
      return;
    }

    playSound("click");
    if (triggerEnrollFaceBtn) {
      triggerEnrollFaceBtn.disabled = true;
      triggerEnrollFaceBtn.style.opacity = "0.6";
    }
    if (enrollProgressContainer) enrollProgressContainer.classList.remove("hidden");
    if (enrollResultContainer) enrollResultContainer.innerHTML = "";

    // Burst capture 6 frames from canvas
    const frames = [];
    const canvas = enrollHiddenCanvas || document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 360;
    const ctx = canvas.getContext("2d");

    for (let i = 1; i <= 6; i++) {
      if (enrollStatusText) enrollStatusText.textContent = `Capturing facial biometric frame ${i} of 6...`;
      if (enrollPercentText) enrollPercentText.textContent = `${Math.round((i / 6) * 60)}%`;
      if (enrollProgressFill) enrollProgressFill.style.width = `${Math.round((i / 6) * 60)}%`;

      if (enrollVideo && enrollVideo.videoWidth) {
        ctx.drawImage(enrollVideo, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL("image/jpeg", 0.85));
      } else {
        // Fallback placeholder frame if camera offline
        ctx.fillStyle = "#1e293b";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL("image/jpeg", 0.7));
      }
      await new Promise(r => setTimeout(r, 120));
    }

    if (enrollStatusText) enrollStatusText.textContent = "Anchoring biometric commitment to Hedera blockchain...";
    if (enrollPercentText) enrollPercentText.textContent = "85%";
    if (enrollProgressFill) enrollProgressFill.style.width = "85%";

    const roll = currentStudentData.roll_no;
    const { ok, status, data } = await safeFetchJson(`/api/student/${encodeURIComponent(roll)}/enroll-face`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frames })
    });

    if (enrollPercentText) enrollPercentText.textContent = "100%";
    if (enrollProgressFill) enrollProgressFill.style.width = "100%";

    if (ok && data.ok) {
      playSound("success");
      if (enrollResultContainer) {
        enrollResultContainer.innerHTML = `
          <div style="background:rgba(16,185,129,0.15); border:1px solid #10b981; border-radius:var(--radius-md); padding:16px; color:#059669; font-weight:700; text-align:center;">
            <div style="font-size:1.2rem; margin-bottom:4px;">✓ Face ID Enrolled Successfully!</div>
            <div style="font-size:0.84rem; font-weight:500; color:var(--text-main);">Cryptographic commitment anchored to Hedera Distributed Ledger.</div>
            <div style="font-size:0.78rem; font-family:var(--font-mono); margin-top:6px; color:var(--text-muted);">Tx: ${shorten(data.tx_hash, 12)}</div>
          </div>
        `;
      }

      currentStudentData.face_enrolled = 1;
      currentStudentData.face_reset_status = "NONE";
      sessionStorage.setItem("attendchain_student_data", JSON.stringify(currentStudentData));

      setTimeout(() => {
        closeFaceEnrollModal();
        loadStudentProfile();
        loadStudentDashboard(roll);
      }, 1500);
    } else {
      playSound("error");
      if (triggerEnrollFaceBtn) {
        triggerEnrollFaceBtn.disabled = false;
        triggerEnrollFaceBtn.style.opacity = "1";
      }
      if (enrollResultContainer) {
        enrollResultContainer.innerHTML = `
          <div style="background:rgba(239,68,68,0.12); border:1px solid #ef4444; border-radius:var(--radius-md); padding:14px; color:#dc2626; font-size:0.88rem;">
            <strong>Enrollment Failed:</strong> ${escapeHtml(data.error || 'Biometric template capture failed. Please ensure good lighting and look straight at camera.')}
          </div>
        `;
      }
    }
  }

  if (triggerEnrollFaceBtn) triggerEnrollFaceBtn.addEventListener("click", triggerEnrollFaceCapture);

  // =========================================================================
  // MODAL: REQUEST FACE ID RESET
  // =========================================================================

  const requestFaceResetModal = document.getElementById("requestFaceResetModal");
  const closeFaceResetModalBtn = document.getElementById("closeFaceResetModalBtn");
  const cancelFaceResetModalBtn = document.getElementById("cancelFaceResetModalBtn");
  const submitFaceResetRequestBtn = document.getElementById("submitFaceResetRequestBtn");
  const faceResetReasonInput = document.getElementById("faceResetReasonInput");
  const faceResetModalAlert = document.getElementById("faceResetModalAlert");

  function openFaceResetModal() {
    playSound("click");
    if (requestFaceResetModal) requestFaceResetModal.classList.remove("hidden");
    if (faceResetReasonInput) faceResetReasonInput.value = "";
    if (faceResetModalAlert) faceResetModalAlert.classList.add("hidden");
  }

  function closeFaceResetModal() {
    playSound("click");
    if (requestFaceResetModal) requestFaceResetModal.classList.add("hidden");
  }

  if (closeFaceResetModalBtn) closeFaceResetModalBtn.addEventListener("click", closeFaceResetModal);
  if (cancelFaceResetModalBtn) cancelFaceResetModalBtn.addEventListener("click", closeFaceResetModal);

  async function submitFaceResetRequest() {
    if (!currentStudentData || !currentStudentData.roll_no) return;
    const reason = faceResetReasonInput ? faceResetReasonInput.value.trim() : "";
    if (!reason) {
      if (faceResetModalAlert) {
        faceResetModalAlert.classList.remove("hidden");
        faceResetModalAlert.className = "alert-callout-box error";
        faceResetModalAlert.textContent = "Please provide a reason for the reset request.";
      }
      return;
    }

    if (faceResetModalAlert) {
      faceResetModalAlert.classList.remove("hidden");
      faceResetModalAlert.className = "alert-callout-box";
      faceResetModalAlert.textContent = "Submitting request to University Administrator...";
    }

    const roll = currentStudentData.roll_no;
    const { ok, data } = await safeFetchJson(`/api/student/${encodeURIComponent(roll)}/request-face-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason })
    });

    if (ok && data.ok) {
      playSound("success");
      if (faceResetModalAlert) {
        faceResetModalAlert.className = "alert-callout-box";
        faceResetModalAlert.style.background = "rgba(16,185,129,0.12)";
        faceResetModalAlert.style.color = "#059669";
        faceResetModalAlert.textContent = "✓ Request submitted successfully. Awaiting administrator approval.";
      }
      setTimeout(() => {
        closeFaceResetModal();
        loadStudentProfile();
      }, 1200);
    } else {
      playSound("error");
      if (faceResetModalAlert) {
        faceResetModalAlert.className = "alert-callout-box error";
        faceResetModalAlert.textContent = data.error || "Failed to submit request.";
      }
    }
  }

  if (submitFaceResetRequestBtn) submitFaceResetRequestBtn.addEventListener("click", submitFaceResetRequest);

  // =========================================================================
  // VIEW 2C: STUDENT SETTINGS - CHANGE PASSWORD
  // =========================================================================

  const settingsCurrentPass = document.getElementById("settingsCurrentPass");
  const settingsNewPass = document.getElementById("settingsNewPass");
  const settingsConfirmPass = document.getElementById("settingsConfirmPass");
  const settingsUpdatePassBtn = document.getElementById("settingsUpdatePassBtn");
  const settingsPassAlert = document.getElementById("settingsPassAlert");

  if (settingsUpdatePassBtn) {
    settingsUpdatePassBtn.addEventListener("click", async () => {
      if (!currentStudentData || !currentStudentData.roll_no) return;
      const oldPass = settingsCurrentPass ? settingsCurrentPass.value.trim() : "";
      const newPass = settingsNewPass ? settingsNewPass.value.trim() : "";
      const confirmPass = settingsConfirmPass ? settingsConfirmPass.value.trim() : "";

      if (!oldPass || !newPass) {
        if (settingsPassAlert) {
          settingsPassAlert.classList.remove("hidden");
          settingsPassAlert.className = "alert-callout-box error";
          settingsPassAlert.textContent = "Please fill in all password fields.";
        }
        return;
      }
      if (newPass !== confirmPass) {
        if (settingsPassAlert) {
          settingsPassAlert.classList.remove("hidden");
          settingsPassAlert.className = "alert-callout-box error";
          settingsPassAlert.textContent = "New passwords do not match.";
        }
        return;
      }
      if (newPass.length < 6) {
        if (settingsPassAlert) {
          settingsPassAlert.classList.remove("hidden");
          settingsPassAlert.className = "alert-callout-box error";
          settingsPassAlert.textContent = "New password must be at least 6 characters.";
        }
        return;
      }

      if (settingsPassAlert) {
        settingsPassAlert.classList.remove("hidden");
        settingsPassAlert.className = "alert-callout-box";
        settingsPassAlert.textContent = "Updating password...";
      }

      const roll = currentStudentData.roll_no;
      const { ok, data } = await safeFetchJson(`/api/student/${encodeURIComponent(roll)}/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old_password: oldPass, new_password: newPass })
      });

      if (ok && data.ok) {
        playSound("success");
        if (settingsPassAlert) {
          settingsPassAlert.className = "alert-callout-box";
          settingsPassAlert.style.background = "rgba(16,185,129,0.12)";
          settingsPassAlert.style.color = "#059669";
          settingsPassAlert.textContent = "✓ Password successfully changed.";
        }
        if (settingsCurrentPass) settingsCurrentPass.value = "";
        if (settingsNewPass) settingsNewPass.value = "";
        if (settingsConfirmPass) settingsConfirmPass.value = "";
      } else {
        playSound("error");
        if (settingsPassAlert) {
          settingsPassAlert.className = "alert-callout-box error";
          settingsPassAlert.textContent = data.error || "Password change failed. Verify your current password.";
        }
      }
    });
  }

  // =========================================================================
  // ADMIN CONSOLE: BIOMETRIC FACE ID RESET APPROVALS
  // =========================================================================

  async function loadAdminFaceResets() {
    const tbody = document.getElementById("adminFaceResetsTbody");
    const badge = document.getElementById("adminResetCountBadge");
    if (!tbody) return;

    try {
      const { ok, data } = await safeFetchJson("/api/admin/face-resets", {
        headers: { "X-Admin-Token": getAdminToken() }
      });
      if (ok && data) {
        const requests = data.requests || [];
        if (badge) badge.textContent = `${requests.length} Pending`;

        if (requests.length === 0) {
          tbody.innerHTML = `
            <tr>
              <td colspan="5" style="text-align:center; color:var(--text-muted); padding:20px;">
                No pending Face ID reset requests.
              </td>
            </tr>
          `;
          return;
        }

        tbody.innerHTML = requests.map(r => `
          <tr>
            <td style="font-weight:700; color:var(--text-main);">${escapeHtml(r.name)}</td>
            <td style="font-family:var(--font-mono); font-weight:700; color:var(--primary-blue);">${escapeHtml(r.roll_no)}</td>
            <td style="color:var(--text-muted); font-size:0.86rem;">${escapeHtml(r.email || '-')}</td>
            <td style="font-size:0.86rem; color:var(--text-main);">${escapeHtml(r.face_reset_reason || 'Student requested reset')}</td>
            <td style="white-space:nowrap;">
              <button class="btn-primary-action admin-approve-reset-btn" data-roll="${escapeHtml(r.roll_no)}" type="button" style="padding:4px 12px; font-size:0.78rem; background:#059669; display:inline-flex; width:auto; margin-right:6px;">
                ✓ Approve
              </button>
              <button class="btn-secondary-action admin-reject-reset-btn" data-roll="${escapeHtml(r.roll_no)}" type="button" style="padding:4px 12px; font-size:0.78rem; color:#dc2626; border-color:#dc2626; display:inline-flex; width:auto;">
                ✕ Reject
              </button>
            </td>
          </tr>
        `).join("");

        tbody.querySelectorAll(".admin-approve-reset-btn").forEach(btn => {
          btn.addEventListener("click", () => approveFaceReset(btn.dataset.roll));
        });
        tbody.querySelectorAll(".admin-reject-reset-btn").forEach(btn => {
          btn.addEventListener("click", () => rejectFaceReset(btn.dataset.roll));
        });
      }
    } catch (err) {
      console.warn("loadAdminFaceResets error:", err);
    }
  }

  async function approveFaceReset(roll) {
    if (!confirm(`Are you sure you want to APPROVE Face ID reset for student ${roll}? This will unlock their account to register a new face.`)) return;
    playSound("click");

    const { ok, data } = await safeFetchJson(`/api/admin/face-resets/${encodeURIComponent(roll)}/approve`, {
      method: "POST",
      headers: { "X-Admin-Token": getAdminToken() }
    });

    if (ok && data.ok) {
      playSound("success");
      loadAdminFaceResets();
    } else {
      playSound("error");
      alert(data.error || "Approval failed.");
    }
  }

  async function rejectFaceReset(roll) {
    if (!confirm(`Reject Face ID reset request for student ${roll}?`)) return;
    playSound("click");

    const { ok, data } = await safeFetchJson(`/api/admin/face-resets/${encodeURIComponent(roll)}/reject`, {
      method: "POST",
      headers: { "X-Admin-Token": getAdminToken() }
    });

    if (ok && data.ok) {
      playSound("success");
      loadAdminFaceResets();
    } else {
      playSound("error");
      alert(data.error || "Rejection failed.");
    }
  }

  // --- Initial Launch ---
  updateAuthUI();
  fetchHealth();
  setInterval(fetchHealth, 15000);
  loadActiveSessions();

  // Fast Live Background Polling: updates active student and faculty boards in real-time
  setInterval(() => {
    if (document.hidden) return;
    if (currentUserRole === "student" && currentStudentData) {
      loadStudentDashboard(currentStudentData.roll_no);
    } else if (currentUserRole === "faculty") {
      loadFacultyConsole();
      loadActiveSessions();
    }
  }, 2000);

  if (currentUserRole === "student" && currentStudentData) {
    loadStudentDashboard(currentStudentData.roll_no);
    switchTab("tab-portal");
  } else if (currentUserRole === "faculty") {
    switchTab("tab-admin");
  } else if (currentUserRole === "admin") {
    switchTab("tab-superadmin");
  } else {
    switchTab("tab-gateway");
  }

})();
