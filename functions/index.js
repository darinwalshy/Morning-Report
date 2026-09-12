// index.js

import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getAppCheck } from "firebase-admin/app-check";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { GoogleGenAI } from "@google/genai";

initializeApp();

const db = getFirestore("morningreport");
const ALLOWED_ORIGIN = "https://darinwalshy.github.io";
const MAX_DAILY_REQUESTS = 50;

export const generateBriefing = functions.https.onRequest(
  { secrets: ["GEMINI_API_KEY"] },
  async (req, res) => {
  // 1. CORS Setup
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Firebase-AppCheck");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  // Enforce HTTP POST
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
    // 2. Verify App Check Token
    const appCheckToken = req.headers["x-firebase-appcheck"];

    if (!appCheckToken || appCheckToken === "undefined" || appCheckToken === "null") {
      res.status(401).json({ error: "Unauthorized: Missing or invalid App Check token." });
      return;
    }

    try {
      await getAppCheck().verifyToken(appCheckToken);
    } catch (appCheckErr) {
      console.error("App Check verification failed:", appCheckErr);
      res.status(401).json({ error: "Unauthorized: Invalid App Check token." });
      return;
    }

    // 3. Verify Auth Token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized: Missing or invalid token format." });
      return;
    }

    const idToken = authHeader.split("Bearer ")[1];
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const userId = decodedToken.uid;

    // 4. Atomic Rate Limiting via Firestore Transaction
    const todayStr = new Date().toISOString().split("T")[0];
    const rateLimitRef = db.collection("rate_limits").doc(`${userId}_${todayStr}`);

    try {
      await db.runTransaction(async (transaction) => {
        const rateLimitDoc = await transaction.get(rateLimitRef);
        const currentCount = rateLimitDoc.exists ? (rateLimitDoc.data().count || 0) : 0;

        if (currentCount >= MAX_DAILY_REQUESTS) {
          const limitError = new Error("RATE_LIMIT_EXCEEDED");
          limitError.code = "LIMIT_EXCEEDED";
          throw limitError;
        }

        transaction.set(rateLimitRef, {
          count: currentCount + 1,
          userId: userId,
          date: todayStr,
          lastRequestTime: FieldValue.serverTimestamp()
        }, { merge: true });
      });
    } catch (transactionErr) {
      if (transactionErr.code === "LIMIT_EXCEEDED") {
        res.status(429).json({ error: "Daily briefing request limit reached. Try again tomorrow." });
        return;
      }
      throw transactionErr;
    }

    // 5. Generate Content
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is missing.");
    }

    const ai = new GoogleGenAI({ apiKey });
    const prompt = "Provide a concise, encouraging 3-sentence morning briefing focused on productivity, clarity, and starting the day strong.";
    
    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: prompt,
    });

    res.status(200).json({
      success: true,
      text: response.text
    });

  } catch (error) {
    console.error("Error in generateBriefing function:", error);
    res.status(500).json({ error: "Failed to generate briefing." });
  }
});