const FUNCTION_URL = "https://darinwalshy.github.io/Morning-Report/";

// 1. Handle Login Form Submission
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("email-input").value.trim();
  const password = document.getElementById("password-input").value;
  const errorElement = document.getElementById("login-error");

  try {
    errorElement.style.display = "none";
    await window.signInWithEmailAndPassword(window.auth, email, password);
  } catch (err) {
    errorElement.textContent = "Invalid email or password.";
    errorElement.style.display = "block";
  }
});

// 2. Track Auth State Changes (Auto-login & Session Management)
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

// 3. Handle Logout
document.getElementById("logout-btn").addEventListener("click", () => {
  window.signOut(window.auth);
});

// 4. Authenticated Request to Cloud Function
document.getElementById("generate-briefing-btn").addEventListener("click", async () => {
  const user = window.auth.currentUser;
  if (!user) return;

  try {
    // Retrieve active Firebase ID Token
    const idToken = await user.getIdToken();

    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${idToken}`
      },
      body: JSON.stringify({ action: "generate" })
    });

    const data = await response.json();
    document.getElementById("briefing-output").textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    console.error("Failed to generate briefing:", error);
  }
});