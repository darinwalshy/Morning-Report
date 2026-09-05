// 1. Target your actual deployed Cloud Function, not the GitHub Pages site URL
const FUNCTION_URL = "https://us-central1-morning-report-3afe0.cloudfunctions.net/generateBriefing";

// 2. Handle Login Form Submission
document.getElementById("login-form").addEventListener("submit", async (e) => {
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

// 3. Track Auth State Changes (Auto-login & Session Management)
window.onAuthStateChanged(window.auth, (user) => {
  const loginView = document.getElementById("login-container");
  const appView = document.getElementById("app-container");

  if (user) {
    loginView.style.display = "none";
    appView.style.display = "block";
  } else {
    loginView.style.display = "block";
    appView.style.display = "none";
  }
});

// 4. Handle Logout
document.getElementById("logout-btn").addEventListener("click", () => {
  window.signOut(window.auth);
});

// 5. Authenticated Request to Cloud Function
async function fetchBriefing() {
  const user = window.auth.currentUser;
  if (!user) {
    console.warn("Cannot generate briefing: No user authenticated.");
    return;
  }

  const outputElement = document.getElementById("briefing-output");
  outputElement.textContent = "Loading briefing...";

  try {
    // Retrieve fresh active Firebase ID Token
    const idToken = await user.getIdToken(/* forceRefresh */ true);

    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${idToken}`
      },
      body: JSON.stringify({ action: "generate" })
    });

    if (!response.ok) {
      throw new Error(`Server returned status ${response.status}`);
    }

    const data = await response.json();
    outputElement.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    console.error("Failed to generate briefing:", error);
    outputElement.textContent = `Error: ${error.message}`;
  }
}

// Attach listener to button
document.getElementById("generate-briefing-btn").addEventListener("click", fetchBriefing);