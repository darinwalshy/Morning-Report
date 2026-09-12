import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getAppCheck } from "firebase-admin/app-check";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { GoogleGenAI } from "@google/genai";

initializeApp();

const db = getFirestore("morningreport");

// Configuration
const ALLOWED_ORIGIN = "https://darinwalshy.github.io"; // REPLACE with your actual GitHub Pages URL
const MAX_DAILY_REQUESTS = 50;

export const generateBriefing = functions.https.onRequest(async (req, res) => {
  // 1. Hardened CORS
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Firebase-AppCheck");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    // 2. Verify App Check Token
    const appCheckToken = req.headers["x-firebase-appcheck"];
    if (!appCheckToken) {
      res.status(401).json({ error: "Unauthorized: Missing App Check token." });
      return;
    }

    try {
      await getAppCheck().verifyToken(appCheckToken);
    } catch (appCheckErr) {
      console.error("App Check verification failed:", appCheckErr);
      res.status(401).json({ error: "Unauthorized: Invalid App Check token." });
      return;
    }

    // 3. Verify Firebase Auth ID Token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized: Missing or invalid token format." });
      return;
    }

    const idToken = authHeader.split("Bearer ")[1];
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const userId = decodedToken.uid;

    // 4. Firestore Daily Rate Limiting
    const todayStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const rateLimitRef = db.collection("rate_limits").doc(`${userId}_${todayStr}`);
    
    const rateLimitDoc = await rateLimitRef.get();
    let currentCount = 0;

    if (rateLimitDoc.exists) {
      currentCount = rateLimitDoc.data().count || 0;
    }

    if (currentCount >= MAX_DAILY_REQUESTS) {
      res.status(429).json({ error: "Daily briefing request limit reached. Try again tomorrow." });
      return;
    }

    // Update or increment request count
    await rateLimitRef.set({
      count: FieldValue.increment(1),
      userId: userId,
      date: todayStr,
      lastRequestTime: FieldValue.serverTimestamp()
    }, { merge: true });

    // 5. Initialize Gemini SDK inside handler and execute call
    const apiKey = process.env.GEMINI_API_KEY;
    const ai = new GoogleGenAI(apiKey ? { apiKey } : {});

    const prompt = "Provide a concise, encouraging 3-sentence morning briefing focused on productivity, clarity, and starting the day strong.";
    
    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: prompt,
    });

    // 6. Return Briefing
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