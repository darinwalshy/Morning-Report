const FUNCTION_URL = "https://us-central1-morning-report-3afe0.cloudfunctions.net/generateBriefing";

let currentAudio = null;
let currentAudioBase64 = null;

// LocalStorage Keys
const SETTINGS_KEYS = {
  userName: "mr_user_name",
  latitude: "mr_latitude",
  longitude: "mr_longitude",
  model: "mr_gemini_model",
  voice: "mr_tts_voice"
};

// Default Values
const DEFAULTS = {
  latitude: 0.0436,
  longitude: 32.4418,
  model: "gemini-3.6-flash",
  voice: "en-US-Studio-O"
};

// Load Settings from Local Storage into Form
function loadSettingsToForm() {
  document.getElementById("setting-user-name").value = localStorage.getItem(SETTINGS_KEYS.userName) || "";
  document.getElementById("setting-latitude").value = localStorage.getItem(SETTINGS_KEYS.latitude) || DEFAULTS.latitude;
  document.getElementById("setting-longitude").value = localStorage.getItem(SETTINGS_KEYS.longitude) || DEFAULTS.longitude;
  document.getElementById("setting-gemini-model").value = localStorage.getItem(SETTINGS_KEYS.model) || DEFAULTS.model;
  document.getElementById("setting-tts-voice").value = localStorage.getItem(SETTINGS_KEYS.voice) || DEFAULTS.voice;
}

// Save Settings from Form to Local Storage
document.getElementById("settings-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  localStorage.setItem(SETTINGS_KEYS.userName, document.getElementById("setting-user-name").value.trim());
  localStorage.setItem(SETTINGS_KEYS.latitude, document.getElementById("setting-latitude").value.trim() || DEFAULTS.latitude);
  localStorage.setItem(SETTINGS_KEYS.longitude, document.getElementById("setting-longitude").value.trim() || DEFAULTS.longitude);
  localStorage.setItem(SETTINGS_KEYS.model, document.getElementById("setting-gemini-model").value);
  localStorage.setItem(SETTINGS_KEYS.voice, document.getElementById("setting-tts-voice").value);

  const saveStatus = document.getElementById("save-status");
  if (saveStatus) {
    saveStatus.style.display = "inline";
    setTimeout(() => { saveStatus.style.display = "none"; }, 2000);
  }
});

// View Navigation Helpers
const settingsToggleBtn = document.getElementById("settings-toggle-btn");
const closeSettingsBtn = document.getElementById("close-settings-btn");
const appContainer = document.getElementById("app-container");
const settingsContainer = document.getElementById("settings-container");

function showSettingsView() {
  loadSettingsToForm();
  appContainer.style.display = "none";
  settingsContainer.style.display = "block";
}

function hideSettingsView() {
  settingsContainer.style.display = "none";
  appContainer.style.display = "block";
}

settingsToggleBtn?.addEventListener("click", () => {
  if (settingsContainer.style.display === "block") {
    hideSettingsView();
  } else {
    showSettingsView();
  }
});

closeSettingsBtn?.addEventListener("click", hideSettingsView);

// Detect Browser Geolocation
document.getElementById("detect-location-btn")?.addEventListener("click", () => {
  if ("geolocation" in navigator) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        document.getElementById("setting-latitude").value = position.coords.latitude.toFixed(4);
        document.getElementById("setting-longitude").value = position.coords.longitude.toFixed(4);
      },
      (err) => {
        alert("Unable to retrieve location: " + err.message);
      }
    );
  } else {
    alert("Geolocation is not supported by your browser.");
  }
});

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

  if (user) {
    loginView.style.display = "none";
    appContainer.style.display = "block";
    settingsToggleBtn.style.display = "inline-block";
    fetchBriefing();
  } else {
    loginView.style.display = "block";
    appContainer.style.display = "none";
    settingsContainer.style.display = "none";
    settingsToggleBtn.style.display = "none";
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
  const metaContainer = document.getElementById("briefingMeta");
  const metaModel = document.getElementById("metaModel");
  const metaVoice = document.getElementById("metaVoice");

  if (reportText) {
    reportText.classList.add("loading-text");
    reportText.textContent = "Fetching your briefing from Gemini...";
  }
  if (metaContainer) metaContainer.style.display = "none";

  try {
    const idToken = await user.getIdToken(true);
    
    let appCheckTokenResult = null;
    if (window.appCheck && window.getAppCheckToken) {
      appCheckTokenResult = await window.getAppCheckToken(window.appCheck, false);
    }

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${idToken}`
    };

    if (appCheckTokenResult && appCheckTokenResult.token) {
      headers["X-Firebase-AppCheck"] = appCheckTokenResult.token;
    }

    // Retrieve settings payload from localStorage
    const settingsPayload = {
      userName: localStorage.getItem(SETTINGS_KEYS.userName) || "",
      latitude: parseFloat(localStorage.getItem(SETTINGS_KEYS.latitude)) || DEFAULTS.latitude,
      longitude: parseFloat(localStorage.getItem(SETTINGS_KEYS.longitude)) || DEFAULTS.longitude,
      model: localStorage.getItem(SETTINGS_KEYS.model) || DEFAULTS.model,
      voice: localStorage.getItem(SETTINGS_KEYS.voice) || DEFAULTS.voice
    };

    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        action: "generate",
        settings: settingsPayload
      })
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

    // Display execution metadata badges
    if (data.meta && metaContainer && metaModel && metaVoice) {
      metaModel.textContent = `Model: ${data.meta.modelUsed}`;
      metaVoice.textContent = `Voice: ${data.meta.voiceUsed}`;

      metaModel.classList.toggle("fallback", Boolean(data.meta.modelFallback));
      metaVoice.classList.toggle("fallback", Boolean(data.meta.voiceFallback));

      metaContainer.style.display = "flex";
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