import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import * as functions from "firebase-functions";
import { GoogleGenAI } from "@google/genai";

// Initialize Firebase Admin SDK
initializeApp();

// Initialize Gemini Client (uses GEMINI_API_KEY environment variable by default)
const ai = new GoogleGenAI();

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

    // 4. Call Gemini to generate the morning briefing
    const prompt = "Provide a concise, encouraging 3-sentence morning briefing focused on productivity, clarity, and starting the day strong.";
    
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    // 5. Send generated text back to the PWA
    res.status(200).json({
      success: true,
      text: response.text,
      user: userId
    });

  } catch (error) {
    console.error("Error running briefing endpoint:", error);
    res.status(500).json({ error: "Failed to generate briefing." });
  }
});