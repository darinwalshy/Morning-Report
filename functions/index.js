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

// Default Coordinates: Entebbe International Airport, Uganda
const DEFAULT_LATITUDE = 0.0436;
const DEFAULT_LONGITUDE = 32.4418;
const DEFAULT_MODEL = "gemini-3.6-flash";
const DEFAULT_VOICE = "en-US-Studio-O";

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

// Moon Phase Translator Helper with Buffer Windows
function getMoonPhaseName(phase) {
  if (phase === undefined || phase === null) return "Unknown";
  if (phase <= 0.02 || phase >= 0.98) return "New Moon";
  if (phase < 0.23) return "Waxing Crescent";
  if (phase <= 0.27) return "First Quarter";
  if (phase < 0.48) return "Waxing Gibbous";
  if (phase <= 0.52) return "Full Moon";
  if (phase < 0.73) return "Waning Gibbous";
  if (phase <= 0.77) return "Last Quarter";
  return "Waning Crescent";
}

// Absolute Humidity Calculation Helper (g/m³)
function calculateAbsoluteHumidity(tempC, relativeHumidity) {
  if (tempC === undefined || relativeHumidity === undefined) return "N/A";
  const vaporPressure = 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5)) * (relativeHumidity / 100);
  const absoluteHumidity = (vaporPressure * 216.7) / (273.15 + tempC);
  return `${absoluteHumidity.toFixed(2)} g/m³`;
}

// Moon Illumination Percentage Calculation Helper
function getMoonIllumination(phase) {
  if (phase === undefined || phase === null) return "N/A";
  const illumination = ((1 - Math.cos(2 * Math.PI * phase)) / 2) * 100;
  return `${Math.round(illumination)}%`;
}

// Local 12-hour Time Formatter Helper
function formatLocalTime(timestamp) {
  if (!timestamp) return "N/A";
  try {
    const date = typeof timestamp === "number" ? new Date(timestamp * 1000) : new Date(timestamp);
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Africa/Kampala"
    }).format(date);
  } catch (e) {
    return "N/A";
  }
}

export const generateBriefing = functions.https.onRequest(
  { 
    secrets: ["GEMINI_API_KEY"],
    timeoutSeconds: 120, // Increases Cloud Function timeout limit to 2 minutes
    memory: "512MiB"     // Provides extra compute resources for faster TTS processing
  },
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

      // Parse user settings from client payload
      const userSettings = req.body.settings || {};
      const userName = userSettings.userName ? userSettings.userName.trim() : "";
      const latitude = typeof userSettings.latitude === "number" ? userSettings.latitude : DEFAULT_LATITUDE;
      const longitude = typeof userSettings.longitude === "number" ? userSettings.longitude : DEFAULT_LONGITUDE;
      const requestedModel = userSettings.model || DEFAULT_MODEL;
      const requestedVoice = userSettings.voice || DEFAULT_VOICE;

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

      // 5. Fetch Open-Meteo Forecast Weather Data
      let weatherContext = "";
      try {
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset,moonrise,moonset,moon_phase&temperature_unit=celsius&timeformat=unixtime&timezone=Africa%2FKampala`;
        
        const weatherResponse = await fetch(weatherUrl);
        if (!weatherResponse.ok) {
          throw new Error(`Open-Meteo returned status ${weatherResponse.status}`);
        }

        const weatherData = await weatherResponse.json();

        const currentTemp = weatherData.current?.temperature_2m;
        const currentHumidity = weatherData.current?.relative_humidity_2m;
        const absoluteHumidity = calculateAbsoluteHumidity(currentTemp, currentHumidity);
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
        const moonIllumination = getMoonIllumination(moonPhaseVal);

        const conditionText = getWeatherCondition(weatherCode);

        weatherContext = `
Location Coordinates: ${latitude},${longitude}
Current Temperature: ${currentTemp}°C
Relative Humidity: ${currentHumidity}%
Absolute Humidity: ${absoluteHumidity}
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
Moon Illumination: ${moonIllumination}
        `.trim();

      } catch (weatherErr) {
        console.error("Weather fetch failed:", weatherErr);
        res.status(502).json({ error: "Unable to generate morning report because weather data is currently unavailable." });
        return;
      }

      // 6. Fetch Observed Station Weather (NOAA METAR for HUEN - Entebbe Airport)
      let metarContext = "";
      try {
        const metarUrl = "https://tgftp.nws.noaa.gov/data/observations/metar/stations/HUEN.TXT";
        const metarResponse = await fetch(metarUrl);
        if (metarResponse.ok) {
          const metarRaw = await metarResponse.text();
          metarContext = metarRaw.trim();
        } else {
          console.warn(`NOAA METAR returned status: ${metarResponse.status}`);
          metarContext = "NOAA METAR station data currently unavailable.";
        }
      } catch (metarErr) {
        console.error("NOAA METAR fetch failed:", metarErr);
        metarContext = "NOAA METAR station data currently unavailable.";
      }

      // 7. Fetch Financial Data via yahoo-finance2
      let financeContext = "";
      try {
        const { default: YahooFinance } = await import("yahoo-finance2");
        const yahooFinance = new YahooFinance();

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
          const priceVal = q.regularMarketPrice ?? q.postMarketPrice ?? q.preMarketPrice ?? q.previousClose;
          const price = typeof priceVal === "number" ? priceVal.toFixed(2) : "N/A";
          const change = typeof q.regularMarketChange === "number" ? q.regularMarketChange.toFixed(2) : "N/A";
          const changePercent = typeof q.regularMarketChangePercent === "number" ? q.regularMarketChangePercent.toFixed(2) : "N/A";
          const sign = (q.regularMarketChange || 0) >= 0 ? "+" : "";

          if (q.symbol === "^GSPC" || q.symbol === "^IXIC") {
            return `${name} (${q.symbol}):$${price} (${sign}${changePercent}%)`;
          }

          return `${name} (${q.symbol}):$${price} (${sign}${change}, ${sign}${changePercent}%)`;
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

      // 8. Generate Content via Gemini API with Fallback Handling
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY environment variable is missing.");
      }

      const ai = new GoogleGenAI({ apiKey });
      const nameInstruction = userName 
        ? `The user's name is ${userName}. Incorporate their name naturally into your opening greeting.` 
        : "Address the user in a warm, welcoming opening greeting.";

      const prompt = `
You are a warm, helpful personal morning assistant. ${nameInstruction}

Below is today's raw model/forecast weather data for the specified coordinates:
${weatherContext}

Below is the latest raw physical METAR observation string from Entebbe International Airport weather station (HUEN):
${metarContext}

Below is recent market data for key tracked assets:
${financeContext}

Search live news outlets for top current stories out of Uganda (or major regional East African / global news strongly impacting Uganda).

Generate a daily morning report structured into exactly FIVE distinct sections. DO NOT use markdown headers (such as # or ###). Use bold section titles followed by a colon (e.g., **Weather Overview:**).

Format Rules for Opening & Greeting:
- Begin the daily briefing with 1 to 2 creative, warm, and engaging opening sentences at the very top.
- Feel free to vary the phrasing every day (e.g., cheerful, reflective, inspiring, or atmospheric).
- You MUST address the user by name in this opening sentence if a name is provided above.
- Follow this opening greeting with a blank line before starting Section 1.
- DO NOT repeat any greeting, pleasantries, or user name inside any of the five sections below.

Structure the rest of the output with a blank line before each section title:

1. **Weather Overview:** Synthesize the model forecast data into a friendly, natural narrative starting immediately with the current weather conditions. Cover current temperature, relative humidity, absolute humidity (g/m³), high/low range, rain odds, wind speed, sunrise/sunset times, and astronomical highlights (moonrise/moonset, moon phase, and illumination percentage). Use Celsius for all temperatures.

2. **Actual Station Measurements:** Parse and translate the provided HUEN METAR station text into clear, readable surface measurements. Detail the actual measured surface temperature, dew point, relative wind speed and direction, barometric sea-level pressure (QNH in hPa/mbar), cloud cover, horizontal visibility, and state the exact observation timestamp converted into local East Africa Time (EAT). If METAR data is unavailable, state: "Actual station observations are currently unavailable."

3. **Market & Financial Summary:** Synthesize the provided asset metrics into a conversational overview detailing the latest prices and daily price changes for the S&P 500, NASDAQ, SPCX, and Rocket Lab. Note that S&P 500 and NASDAQ should focus on index level and percentage change. Conclude this section with 2–3 sentences explaining overall broader macro market dynamics driving these movements.

4. **Key News Highlights:** Search for up to 5 of the top pertinent news items originating from or strongly affecting Uganda today.

CRITICAL FORMATTING REQUIREMENT FOR NEWS ITEMS:
Each news item MUST strictly start on a new line with a bullet point, followed by "News Item X:" where X is the item number, followed by the headline in bold and a colon.
Format example:
* **News Item 1: Headline Title Here:** Thorough 4 to 5 sentence summary explaining what happened and why it matters.
* **News Item 2: Headline Title Here:** Thorough 4 to 5 sentence summary explaining what happened and why it matters.

If fewer than 5 major stories are available on a light news day, provide as many as are relevant (down to 1). If live news search yields no results or fails, output: "News highlights are currently unavailable."

5. **Daily Briefing:** A concise, encouraging 3-sentence morning briefing focused on productivity, clarity, and starting the day strong.
`.trim();

      let rawText = "";
      let actualModelUsed = requestedModel;
      let modelFallbackOccurred = false;

      try {
        const response = await ai.models.generateContent({
          model: requestedModel,
          contents: prompt,
          config: {
            tools: [{ googleSearch: {} }]
          }
        });
        rawText = response.text || "";
      } catch (geminiErr) {
        console.error(`Requested model ${requestedModel} failed, falling back to${DEFAULT_MODEL}:`, geminiErr);
        modelFallbackOccurred = true;
        actualModelUsed = `${DEFAULT_MODEL} (fallback)`;

        const fallbackResponse = await ai.models.generateContent({
          model: DEFAULT_MODEL,
          contents: prompt,
          config: {
            tools: [{ googleSearch: {} }]
          }
        });
        rawText = fallbackResponse.text || "";
      }

      rawText = rawText.replace(/^#+\s*/gm, "");

      // 9. Synthesize Audio via Google Cloud TTS with SSML Pauses
      let audioBase64 = null;
      let actualVoiceUsed = requestedVoice;
      let voiceFallbackOccurred = false;

      try {
        const { TextToSpeechClient } = await import("@google-cloud/text-to-speech");
        const ttsClient = new TextToSpeechClient();

        // Strip raw markdown formatting
        let cleanText = rawText.replace(/[#*_`~]/g, "").trim();

        // Inject SSML pauses into speech stream
        // 1. Add 1.5s break before section titles
        let ssmlBody = cleanText.replace(/\n\n(?=Weather Overview|Actual Station Measurements|Market & Financial Summary|Key News Highlights|Daily Briefing)/g, '<break time="1500ms"/>\n\n');
        
        // 2. Add 1.2s break after opening greeting
        const firstBlankLineIndex = ssmlBody.indexOf("\n\n");
        if (firstBlankLineIndex !== -1) {
          ssmlBody = ssmlBody.slice(0, firstBlankLineIndex) + '<break time="1200ms"/>' + ssmlBody.slice(firstBlankLineIndex);
        }

        // 3. Add 600ms break after news item headlines (matches both "News Item X:" and any bold bullet title)
        ssmlBody = ssmlBody.replace(/(\*\s*\*\*[^*]+:\*\*)/g, '$1 <break time="600ms"/>');

        // Escape XML characters safely
        ssmlBody = ssmlBody
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/&lt;break time="(\d+ms)"\/&gt;/g, '<break time="$1"/>');

        let ssmlText = `<speak>${ssmlBody}</speak>`;

        if (ssmlText.length > 4900) {
          ssmlText = ssmlText.slice(0, 4900) + "</speak>";
        }

        const generateAudio = async (voiceName) => {
          const langCode = voiceName.substring(0, 5);
          const ttsRequest = {
            input: { ssml: ssmlText },
            voice: { languageCode: langCode, name: voiceName },
            audioConfig: { audioEncoding: "MP3", speakingRate: 1.0 }
          };
          const [ttsResponse] = await ttsClient.synthesizeSpeech(ttsRequest);
          return ttsResponse.audioContent ? Buffer.from(ttsResponse.audioContent).toString("base64") : null;
        };

        try {
          audioBase64 = await generateAudio(requestedVoice);
        } catch (requestedVoiceErr) {
          console.error(`Requested TTS Voice ${requestedVoice} failed, falling back to ${DEFAULT_VOICE}:`, requestedVoiceErr);
          voiceFallbackOccurred = true;
          actualVoiceUsed = `${DEFAULT_VOICE} (fallback)`;
          audioBase64 = await generateAudio(DEFAULT_VOICE);
        }

      } catch (ttsErr) {
        console.error("CRITICAL TTS ERROR:", ttsErr.message, ttsErr.stack);
      }

      res.status(200).json({
        success: true,
        text: rawText,
        audioBase64: audioBase64,
        meta: {
          modelUsed: actualModelUsed,
          voiceUsed: actualVoiceUsed,
          modelFallback: modelFallbackOccurred,
          voiceFallback: voiceFallbackOccurred
        }
      });

    } catch (error) {
      console.error("Error in generateBriefing function:", error);
      res.status(500).json({ error: "Failed to generate briefing." });
    }
  }
);