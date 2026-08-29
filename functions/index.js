import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { GoogleGenAI } from "@google/genai";

// Bind the secret configured in Google Secret Manager
const geminiApiKey = defineSecret("GEMINI_API_KEY");

export const generateBriefing = onRequest(
  {
    secrets: [geminiApiKey],
    cors: true, // Allows fetch requests directly from your GitHub Pages PWA domain
    region: "us-central1"
  },
  async (req, res) => {
    // Basic HTTP method guard
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed. Use POST." });
    }

    try {
      const { userPrompt } = req.body || {};

      if (!userPrompt) {
        return res.status(400).json({ error: "Missing required parameter: userPrompt" });
      }

      // Initialize Gen AI client using secret value at runtime
      const ai = new GoogleGenAI({ apiKey: geminiApiKey.value() });

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: userPrompt,
      });

      return res.status(200).json({
        success: true,
        text: response.text,
      });
    } catch (error) {
      console.error("Error generating briefing:", error);
      return res.status(500).json({
        error: "Internal Server Error",
        details: error.message,
      });
    }
  }
);