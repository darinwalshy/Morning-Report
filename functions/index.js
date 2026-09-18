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

// Hardcoded Location: Entebbe International Airport, Uganda
const LATITUDE = 0.0436;
const LONGITUDE = 32.4418;

// WMO Weather Code Translator Helper
function getWeatherCondition(code) {
  const weatherMap = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snow fall",
    73: "Moderate snow fall",
    75: "Heavy snow fall",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail"
  };
  return weatherMap[code] || "Unknown weather conditions";
}

// Moon Phase Translator Helper (0 to 1 float mapping)
function getMoonPhaseName(phase) {
  if (phase === undefined || phase === null) return "Unknown";
  if (phase === 0 || phase === 1) return "New Moon";
  if (phase > 0 && phase < 0.25) return "Waxing Crescent";
  if (phase === 0.25) return "First Quarter";
  if (phase > 0.25 && phase < 0.5) return "Waxing Gibbous";
  if (phase === 0.5) return "Full Moon";
  if (phase > 0.5 && phase < 0.75) return "Waning Gibbous";
  if (phase === 0.75) return "Last Quarter";
  if (phase > 0.75 && phase < 1) return "Waning Crescent";
  return "Unknown";
}

// Local 12-hour Time Formatter Helper
function formatLocalTime(isoString) {
  if (!isoString) return "N/A";
  try {
    const date = new Date(isoString);
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Africa/Kampala"
    }).format(date);
  } catch (e) {
    return isoString;
  }
}

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

      // 5. Fetch Weather Data from Open-Meteo
      let weatherContext = "";
      try {
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current=temperature_2m,relative_humidity_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset,moonrise,moonset,moon_phase&temperature_unit=celsius&timezone=Africa%2FKampala`;
        
        const weatherResponse = await fetch(weatherUrl);
        if (!weatherResponse.ok) {
          throw new Error(`Open-Meteo returned status ${weatherResponse.status}`);
        }

        const weatherData = await weatherResponse.json();

        const currentTemp = weatherData.current?.temperature_2m;
        const currentHumidity = weatherData.current?.relative_humidity_2m;
        const weatherCode = weatherData.current?.weather_code;

        const tempMax = weatherData.daily?.temperature_2m_max?.[0];
        const tempMin = weatherData.daily?.temperature_2m_min?.[0];
        const precipProb = weatherData.daily?.precipitation_probability_max?.[0];
        const windSpeed = weatherData.daily?.wind_speed_10m_max?.[0];

        const sunrise = formatLocalTime(weatherData.daily?.sunrise?.[0]);
        const sunset = formatLocalTime(weatherData.daily?.sunset?.[0]);
        const moonrise = formatLocalTime(weatherData.daily?.moonrise?.[0]);
        const moonset = formatLocalTime(weatherData.daily?.moonset?.[0]);
        const moonPhaseVal = weatherData.daily?.moon_phase?.[0];
        const moonPhaseName = getMoonPhaseName(moonPhaseVal);

        const conditionText = getWeatherCondition(weatherCode);

        weatherContext = `
Current Temperature: ${currentTemp}°C
Humidity: ${currentHumidity}%
Condition: ${conditionText}
High Temp Today: ${tempMax}°C
Low Temp Today: ${tempMin}°C
Max Rain Probability: ${precipProb}%
Max Wind Speed: ${windSpeed} km/h
Sunrise: ${sunrise}
Sunset: ${sunset}
Moonrise: ${moonrise}
Moonset: ${moonset}
Moon Phase: ${moonPhaseName}
        `.trim();

      } catch (weatherErr) {
        console.error("Weather fetch failed:", weatherErr);
        res.status(502).json({ error: "Unable to generate morning report because weather data is currently unavailable." });
        return;
      }

      // 6. Fetch Financial Data via yahoo-finance2
      let financeContext = "";
      try {
        const { default: yahooFinance } = await import("yahoo-finance2");

        const tickers = ["^GSPC", "^IXIC", "SPCX", "RKLB"];
        const quotes = await Promise.all(
          tickers.map(ticker => yahooFinance.quote(ticker).catch(err => {
            console.error(`Error fetching ticker ${ticker}:`, err);
            return null;
          }))
        );

        const tickerNames = {
          "^GSPC": "S&P 500",
          "^IXIC": "NASDAQ",
          "SPCX": "SPCX (Space ETF)",
          "RKLB": "Rocket Lab"
        };

        const financeLines = quotes.filter(q => q !== null).map(q => {
          const name = tickerNames[q.symbol] || q.symbol;
          const price = q.regularMarketPrice?.toFixed(2) || "N/A";
          const change = q.regularMarketChange?.toFixed(2) || "N/A";
          const changePercent = q.regularMarketChangePercent?.toFixed(2) || "N/A";
          const sign = q.regularMarketChange >= 0 ? "+" : "";
          return `${name} (${q.symbol}): $${price} (${sign}${change}, ${sign}${changePercent}%)`;
        });

        if (financeLines.length > 0) {
          financeContext = financeLines.join("\n");
        } else {
          financeContext = "Financial market data currently unavailable.";
        }
      } catch (finErr) {
        console.error("Yahoo Finance fetch failed:", finErr);
        financeContext = "Financial market data currently unavailable.";
      }

      // 7. Generate Content via Gemini API with Google Search Grounding
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY environment variable is missing.");
      }

      const ai = new GoogleGenAI({ apiKey });
      const prompt = `
You are a warm, helpful personal morning assistant.

Below is today's raw weather data for Entebbe Airport:
${weatherContext}

Below is recent market data for key tracked assets:
${financeContext}

Search live news outlets for top current stories out of Uganda (or major regional East African / global news strongly impacting Uganda).

Generate a daily morning report structured into exactly four distinct sections:

1. **Weather Overview**: Synthesize the weather data into a friendly, natural narrative. Cover current temperature, humidity, high/low range, rain odds, wind speed, sunrise/sunset times, and astronomical highlights (moonrise/moonset and phase). Use Celsius for all temperatures.

2. **Market & Financial Summary**: Synthesize the provided asset metrics into a conversational overview detailing the latest prices and daily price changes for the S&P 500, NASDAQ, SPCX, and Rocket Lab. Conclude this section with 2–3 sentences explaining overall broader macro market dynamics driving these movements.

3. **Key News Highlights**: Search for up to 5 of the top pertinent news items originating from or strongly affecting Uganda today. For each story, provide a thorough 4 to 5 sentence summary explaining what happened and why it matters. If fewer than 5 major stories are available on a light news day, provide as many as are relevant (down to 1). If live news search yields no results or fails, output: "News highlights are currently unavailable."

4. **Daily Briefing**: A concise, encouraging 3-sentence morning briefing focused on productivity, clarity, and starting the day strong.
      `.trim();

      const response = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }]
        }
      });

      const rawText = response.text || "";

      // 8. Synthesize Audio via Google Cloud Text-to-Speech (en-US-Studio-O)
      let audioBase64 = null;
      try {
        const { TextToSpeechClient } = await import("@google-cloud/text-to-speech");
        const ttsClient = new TextToSpeechClient();

        // Strip Markdown symbols and sanitize string
        let spokenText = rawText
          .replace(/[#*_`~]/g, "")
          .replace(/\s+/g, " ")
          .trim();

        // Hard cap at 4500 characters to stay safely under the 5000-byte limit
        if (spokenText.length > 4500) {
          spokenText = spokenText.slice(0, 4500);
        }

        const ttsRequest = {
          input: { text: spokenText },
          voice: {
            languageCode: "en-US",
            name: "en-US-Studio-O"
          },
          audioConfig: {
            audioEncoding: "MP3",
            speakingRate: 1.0
          }
        };

        const [ttsResponse] = await ttsClient.synthesizeSpeech(ttsRequest);
        if (ttsResponse.audioContent) {
          audioBase64 = Buffer.from(ttsResponse.audioContent).toString("base64");
        }
      } catch (ttsErr) {
        console.error("CRITICAL TTS ERROR:", ttsErr.message, ttsErr.stack);
      }

      res.status(200).json({
        success: true,
        text: rawText,
        audioBase64: audioBase64
      });

    } catch (error) {
      console.error("Error in generateBriefing function:", error);
      res.status(500).json({ error: "Failed to generate briefing." });
    }
  }
);