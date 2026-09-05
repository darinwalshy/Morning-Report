import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import * as functions from "firebase-functions";

// Initialize Firebase Admin SDK
initializeApp();

export const generateBriefing = functions.https.onRequest(async (req, res) => {
  // 1. Enable CORS for PWA request handling
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    // 2. Extract Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized: Missing or invalid token format." });
      return;
    }

    const idToken = authHeader.split("Bearer ")[1];

    // 3. Verify ID Token using Firebase Admin Auth
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const userId = decodedToken.uid;

    // 4. Your existing briefing logic goes here
    
    res.status(200).json({
      success: true,
      message: "Briefing generated successfully.",
      user: userId
    });

  } catch (error) {
    console.error("Token verification failed:", error);
    res.status(403).json({ error: "Unauthorized: Invalid or expired token." });
  }
});