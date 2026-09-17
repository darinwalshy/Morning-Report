const FUNCTION_URL = "https://us-central1-morning-report-3afe0.cloudfunctions.net/generateBriefing";

let currentAudio = null;
let currentAudioBase64 = null;

// 1. Handle Login Form Submission
document.getElementById("login-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("email-input").value.trim();
  const password = document.getElementById("password-input").value;
  const errorElement = document.getElementById("login-error");

  try {
    errorElement.style.display = "none";
    await window.signInWithEmailAndPassword(window.auth, email, password);
  } catch (err) {
    console.error("Login error:", err);
    errorElement.textContent = "Invalid email or password.";
    errorElement.style.display = "block";
  }
});

// 2. Track Auth State Changes
window.onAuthStateChanged(window.auth, (user) => {
  const loginView = document.getElementById("login-container");
  const appView = document.getElementById("app-container");

  if (user) {
    loginView.style.display = "none";
    appView.style.display = "block";
    fetchBriefing();
  } else {
    loginView.style.display = "block";
    appView.style.display = "none";
  }
});

// 3. Handle Logout
document.getElementById("logout-btn")?.addEventListener("click", () => {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  window.signOut(window.auth);
});

// Helper: Reset Read Aloud Button State
function resetButtonUI() {
  const readBtn = document.getElementById("readBtn");
  const btnText = document.getElementById("btnText");
  if (btnText && readBtn) {
    btnText.textContent = "Read Aloud";
    readBtn.firstElementChild.textContent = "🔊";
    readBtn.classList.remove("speaking");
  }
}

// 4. Authenticated & AppCheck-Protected Request to Cloud Function
async function fetchBriefing() {
  const user = window.auth.currentUser;
  if (!user) {
    console.warn("Cannot generate briefing: No user authenticated.");
    return;
  }

  // Reset audio playback if running
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  currentAudioBase64 = null;
  resetButtonUI();

  const reportText = document.getElementById("reportText");
  if (reportText) {
    reportText.classList.add("loading-text");
    reportText.textContent = "Fetching your briefing from Gemini...";
  }

  try {
    const idToken = await user.getIdToken(true);
    
    // Fetch App Check Token via global helper initialized in index.html
    let appCheckTokenResult = null;
    if (window.appCheck && window.getAppCheckToken) {
      appCheckTokenResult = await window.getAppCheckToken(window.appCheck, /* forceRefresh= */ false);
    }

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${idToken}`
    };

    if (appCheckTokenResult && appCheckTokenResult.token) {
      headers["X-Firebase-AppCheck"] = appCheckTokenResult.token;
    }

    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ action: "generate" })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Server status: ${response.status}`);
    }

    if (reportText) {
      reportText.classList.remove("loading-text");
      const rawText = data.text || data.message || "";
      reportText.textContent = rawText.replace(/\*\*/g, "");
    }

    if (data.audioBase64) {
      currentAudioBase64 = data.audioBase64;
    }

  } catch (error) {
    console.error("Failed to generate briefing:", error);
    if (reportText) {
      reportText.classList.remove("loading-text");
      reportText.textContent = `⚠️ Warning: ${error.message}`;
    }
  }
}

// Attach listener to Refresh button
document.getElementById("refreshBtn")?.addEventListener("click", fetchBriefing);

// 5. Audio Playback via Google Cloud TTS MP3 Data
const readBtn = document.getElementById("readBtn");

readBtn?.addEventListener("click", () => {
  const btnText = document.getElementById("btnText");

  // If already playing, stop playback
  if (currentAudio && !currentAudio.paused) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    resetButtonUI();
    return;
  }

  if (!currentAudioBase64) {
    alert("Audio generation is not available for this report.");
    return;
  }

  // Initialize Audio instance if needed
  if (!currentAudio) {
    currentAudio = new Audio(`data:audio/mp3;base64,${currentAudioBase64}`);

    currentAudio.onended = () => {
      resetButtonUI();
    };

    currentAudio.onerror = (e) => {
      console.error("Audio playback error:", e);
      resetButtonUI();
    };
  }

  currentAudio.play().then(() => {
    if (btnText && readBtn) {
      btnText.textContent = "Stop Reading";
      readBtn.firstElementChild.textContent = "⏹️";
      readBtn.classList.add("speaking");
    }
  }).catch((err) => {
    console.error("Failed to play audio:", err);
    resetButtonUI();
  });
});