const FUNCTION_URL = "https://us-central1-morning-report-3afe0.cloudfunctions.net/generateBriefing";

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
  window.signOut(window.auth);
});

// 4. Authenticated Request to Cloud Function
async function fetchBriefing() {
  const user = window.auth.currentUser;
  if (!user) {
    console.warn("Cannot generate briefing: No user authenticated.");
    return;
  }

  const reportText = document.getElementById("reportText");
  if (reportText) {
    reportText.classList.add("loading-text");
    reportText.textContent = "Fetching your briefing from Gemini...";
  }

  try {
    const idToken = await user.getIdToken(true);

    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${idToken}`
      },
      body: JSON.stringify({ action: "generate" })
    });

    if (!response.ok) {
      throw new Error(`Server status: ${response.status}`);
    }

    const data = await response.json();
    if (reportText) {
      reportText.classList.remove("loading-text");
      reportText.textContent = data.message || data.text || JSON.stringify(data, null, 2);
    }
  } catch (error) {
    console.error("Failed to generate briefing:", error);
    if (reportText) {
      reportText.classList.remove("loading-text");
      reportText.textContent = `Unable to connect to briefing service (${error.message}).`;
    }
  }
}

// Attach listener to Refresh button
document.getElementById("refreshBtn")?.addEventListener("click", fetchBriefing);

// 5. Speech Synthesis Setup
const readBtn = document.getElementById("readBtn");
const btnText = document.getElementById("btnText");
let availableVoices = [];

function loadVoices() {
  if ("speechSynthesis" in window) {
    availableVoices = window.speechSynthesis.getVoices();
  }
}

loadVoices();
if ("speechSynthesis" in window && window.speechSynthesis.onvoiceschanged !== undefined) {
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function getBestVoice() {
  if (!availableVoices.length) return null;

  let chosenVoice = availableVoices.find(
    (v) =>
      v.lang.startsWith("en") &&
      v.name.includes("Google") &&
      (v.name.includes("network") || v.name.includes("Online") || v.name.includes("Natural"))
  );

  if (!chosenVoice) {
    chosenVoice = availableVoices.find((v) => v.name.includes("Google") && v.lang.startsWith("en"));
  }

  if (!chosenVoice) {
    chosenVoice = availableVoices.find((v) => v.lang.startsWith("en"));
  }

  return chosenVoice || availableVoices[0];
}

function resetButtonUI() {
  if (btnText && readBtn) {
    btnText.textContent = "Read Aloud";
    readBtn.firstElementChild.textContent = "🔊";
    readBtn.classList.remove("speaking");
  }
}

readBtn?.addEventListener("click", () => {
  const reportText = document.getElementById("reportText");
  if (!("speechSynthesis" in window)) {
    alert("Text-to-speech is not supported in this browser.");
    return;
  }

  if (window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    resetButtonUI();
    return;
  }

  const textToRead = reportText?.innerText || "";
  if (!textToRead) return;

  const textChunks = textToRead.match(/[^.!?]+[.!?]+/g) || [textToRead];
  const chosenVoice = getBestVoice();

  textChunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk.trim());

    if (chosenVoice) {
      utterance.voice = chosenVoice;
    }

    utterance.rate = 0.92;
    utterance.pitch = 0.95;

    if (index === 0) {
      utterance.onstart = () => {
        btnText.textContent = "Stop Reading";
        readBtn.firstElementChild.textContent = "⏹️";
        readBtn.classList.add("speaking");
      };
    }

    if (index === textChunks.length - 1) {
      utterance.onend = resetButtonUI;
      utterance.onerror = resetButtonUI;
    }

    window.speechSynthesis.speak(utterance);
  });
});