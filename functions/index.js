// index.js

import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getAppCheck } from "firebase-admin/app-check";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as functions from "firebase-functions";

initializeApp();

const db = getFirestore("morningreport");
const ALLOWED_ORIGIN = "https://darinwalshy.github.io";
const MAX_DAILY_REQUESTS = 50;

// Default Settings
const DEFAULT_LATITUDE = 0.0436;
const DEFAULT_LONGITUDE = 32.4418;
const DEFAULT_MODEL = "gemini-3.6-flash";
const DEFAULT_VOICE = "en-US-Studio-O";

// Hardened Allowlists
const ALLOWED_MODELS = new Set([
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite"
]);

const ALLOWED_VOICES = new Set([
  // Studio Tier
  "en-US-Studio-O", "en-US-Studio-Q", "en-GB-Studio-B", "en-GB-Studio-C",
  // Neural2 Tier
  "en-US-Neural2-F", "en-US-Neural2-J", "en-US-Neural2-D",
  "en-GB-Neural2-A", "en-GB-Neural2-B", "en-GB-Neural2-C", "en-GB-Neural2-D", "en-GB-Neural2-F",
  // Standard Tier
  "en-US-Standard-C", "en-US-Standard-D",
  "en-GB-Standard-A", "en-GB-Standard-B", "en-GB-Standard-C", "en-GB-Standard-D"
]);

// Helper function to fetch with explicit timeout and retry logic
async function fetchWithRetryAndTimeout(url, options = {}, retries = 3, timeoutMs = 8000) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.ok) {
        return response;
      }
      console.warn(`Attempt ${i + 1} for ${url} failed with status:${response.status}`);
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn(`Attempt ${i + 1} for ${url} timed out after${timeoutMs}ms`);
      } else {
        console.warn(`Attempt ${i + 1} for${url} encountered network error:`, err.message);
      }
    }

    if (i < retries - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return null;
}

// WMO Weather Code Translator Helper
function getWeatherCondition(code) {
  const weatherMap = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Depositing rime fog", 51: "Light drizzle", 53: "Moderate drizzle",
    55: "Dense drizzle", 56: "Light freezing drizzle", 57: "Dense freezing drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain", 66: "Light freezing rain",
    67: "Heavy freezing rain", 71: "Slight snow fall", 73: "Moderate snow fall",
    75: "Heavy snow fall", 77: "Snow grains", 80: "Slight rain showers",
    81: "Moderate rain showers", 82: "Violent rain showers", 85: "Slight snow showers",
    86: "Heavy snow showers", 95: "Thunderstorm", 96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail"
  };
  return weatherMap[code] || "Unknown weather conditions";
}

// Moon Phase Translator Helper
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

// Moon Illumination Percentage Helper
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

// Helper to format a number to 3 significant figures
function formatToThreeSigFigs(num) {
  if (typeof num !== "number" || isNaN(num)) return "N/A";
  const roundedVal = Number(num.toPrecision(3));
  return new Intl.NumberFormat("en-US").format(roundedVal);
}

// Helper to format a number rounded to the nearest whole integer
function formatToWholeInteger(num) {
  if (typeof num !== "number" || isNaN(num)) return "N/A";
  const roundedVal = Math.round(num);
  return new Intl.NumberFormat("en-US").format(roundedVal);
}

export const generateBriefing = functions.https.onRequest(
  { 
    secrets: ["GEMINI_API_KEY"],
    timeoutSeconds: 120,
    memory: "512MiB"
  },
  async (req, res) => {
    // 1. CORS Setup
    const origin = req.headers.origin;
    if (origin === ALLOWED_ORIGIN) {
      res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    }
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Firebase-AppCheck");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");

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

      // 4. Sanitize and Validate Request Payload
      const userSettings = req.body.settings || {};
      
      const userName = typeof userSettings.userName === "string" 
        ? userSettings.userName.trim().replace(/[\r\n\t]/g, " ").slice(0, 50) 
        : "";

      const rawLat = Number(userSettings.latitude);
      const rawLng = Number(userSettings.longitude);

      const latitude = (Number.isFinite(rawLat) && rawLat >= -90 && rawLat <= 90) 
        ? rawLat 
        : DEFAULT_LATITUDE;

      const longitude = (Number.isFinite(rawLng) && rawLng >= -180 && rawLng <= 180) 
        ? rawLng 
        : DEFAULT_LONGITUDE;

      const requestedModel = ALLOWED_MODELS.has(userSettings.model) 
        ? userSettings.model 
        : DEFAULT_MODEL;

      const requestedVoice = ALLOWED_VOICES.has(userSettings.voice) 
        ? userSettings.voice 
        : DEFAULT_VOICE;

      // 5. Atomic Rate Limiting via Firestore Transaction
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

      // 6. Fetch Open-Meteo Forecast Weather Data
      let weatherContext = "";
      try {
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset,moonrise,moonset,moon_phase&temperature_unit=celsius&timeformat=unixtime&timezone=Africa%2FKampala`;
        
        const weatherResponse = await fetchWithRetryAndTimeout(weatherUrl, {}, 3, 6000);
        if (!weatherResponse) {
          throw new Error("Open-Meteo request failed after retries.");
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

      // 7. Fetch Observed Station Weather (NOAA METAR)
      let metarContext = "";
      const fetchHeaders = {
        "User-Agent": "MorningReportPWA/1.22 (https://darinwalshy.github.io/Morning-Report/)"
      };

      try {
        const metarPrimaryUrl = "https://tgftp.nws.noaa.gov/data/observations/metar/stations/HUEN.TXT";
        const primaryResponse = await fetchWithRetryAndTimeout(metarPrimaryUrl, { headers: fetchHeaders }, 3, 6000);

        if (primaryResponse) {
          const metarRaw = await primaryResponse.text();
          metarContext = metarRaw.trim();
        } else {
          const metarFallbackUrl = "https://aviationweather.gov/api/data/metar?ids=HUEN&format=raw";
          const fallbackResponse = await fetchWithRetryAndTimeout(metarFallbackUrl, { headers: fetchHeaders }, 2, 6000);

          if (fallbackResponse) {
            const metarFallbackRaw = await fallbackResponse.text();
            metarContext = metarFallbackRaw ? metarFallbackRaw.trim() : "NOAA METAR station data currently unavailable.";
          } else {
            metarContext = "NOAA METAR station data currently unavailable.";
          }
        }
      } catch (metarErr) {
        console.error("NOAA METAR fetch failed:", metarErr);
        metarContext = "NOAA METAR station data currently unavailable.";
      }

      // 8. Fetch Financial Data via yahoo-finance2
      let financeContext = "";
      try {
        const { default: YahooFinance } = await import("yahoo-finance2");
        const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

        const tickers = ["^GSPC", "^IXIC", "BTC-USD", "SPCX", "RKLB"];
        const quotes = await Promise.all(
          tickers.map(ticker => yahooFinance.quote(ticker).catch(err => {
            console.error(`Error fetching ticker ${ticker}:`, err);
            return null;
          }))
        );

        const tickerNames = {
          "^GSPC": "S&P 500",
          "^IXIC": "NASDAQ",
          "BTC-USD": "Bitcoin",
          "SPCX": "SPCX (Space ETF)",
          "RKLB": "Rocket Lab"
        };

        const financeLines = quotes.filter(q => q !== null).map(q => {
          const name = tickerNames[q.symbol] || q.symbol;
          const priceVal = q.regularMarketPrice ?? q.postMarketPrice ?? q.preMarketPrice ?? q.previousClose;
          const changeVal = q.regularMarketChange ?? 0;
          const changePercentVal = q.regularMarketChangePercent ?? 0;

          if (typeof priceVal !== "number") {
            return `${name} (${q.symbol}): N/A`;
          }

          const threshold = (q.symbol === "^GSPC" || q.symbol === "^IXIC") ? 1.0 : 2.0;
          const isSignificantMove = Math.abs(changePercentVal) >= threshold;
          const sign = changeVal >= 0 ? "+" : "";
          const formattedPercent = `${sign}${changePercentVal.toFixed(2)}%`;

          if (q.symbol === "^GSPC" || q.symbol === "^IXIC") {
            const formattedPrice = formatToThreeSigFigs(priceVal);
            return isSignificantMove 
              ? `${name} (${q.symbol}): ${formattedPrice} (${formattedPercent}).`
              : `${name} (${q.symbol}):${formattedPrice}.`;
          }

          if (q.symbol === "BTC-USD") {
            const formattedPrice = formatToThreeSigFigs(priceVal);
            if (!isSignificantMove) return `${name} (${q.symbol}):$${formattedPrice}.`;
            const formattedRawChange = `${sign}$${formatToThreeSigFigs(Math.abs(changeVal))}`;
            return `${name} (${q.symbol}):$${formattedPrice} (${formattedPercent},${formattedRawChange}).`;
          }

          const formattedPrice = formatToWholeInteger(priceVal);
          if (!isSignificantMove) return `${name} (${q.symbol}):$${formattedPrice}.`;
          const formattedRawChange = `${sign}$${formatToWholeInteger(Math.abs(changeVal))}`;
          return `${name} (${q.symbol}):$${formattedPrice} (${formattedPercent},${formattedRawChange}).`;
        });

        financeContext = financeLines.length > 0 ? financeLines.join("\n") : "Financial market data currently unavailable.";
      } catch (finErr) {
        console.error("Yahoo Finance fetch failed:", finErr);
        financeContext = "Financial market data currently unavailable.";
      }

      // 9. Generate Content via Gemini API
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY environment variable is missing.");
      }

      const { GoogleGenAI } = await import("@google/genai");
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

2. **Actual Station Measurements:** Parse and translate whatever valid fields are present in the provided HUEN METAR station text into clear, readable surface measurements. Detail the actual measured surface temperature, dew point, relative wind speed and direction, barometric sea-level pressure (QNH in hPa/mbar), cloud cover, horizontal visibility, and state the exact observation timestamp converted into local East Africa Time (EAT). Only state "Actual station observations are currently unavailable." if the raw METAR text is entirely empty or explicitly missing.

3. **Market & Financial Summary:** Present the latest levels and price changes for the S&P 500, NASDAQ, Bitcoin, SPCX, and Rocket Lab using the provided context.
- Format each item using ONLY its full plain-text name (e.g., "S&P 500" or "Bitcoin"), completely omitting ticker symbols, parentheses, or caret symbols like "^GSPC" or "BTC-USD".
- Ensure every single list item ends cleanly with a full stop period (.) to ensure proper text-to-speech cadence.
- If a ticker is listed without daily percentage changes in the context, report its level directly without adding commentary.
- For tickers where daily percentage changes ARE provided (indicating a significant move exceeding the threshold), provide a concise 1–2 sentence explanation detailing the primary news event, earnings report, or catalyst driving that specific price movement.
- DO NOT include general macro market commentary unless tied directly to one of the significant ticker movements above.

4. **Key News Highlights:** Search for up to 5 of the top pertinent news items originating from or strongly affecting Uganda today.

CRITICAL FORMATTING REQUIREMENT FOR NEWS ITEMS:
Each news item MUST strictly start on a new line with a bullet point, followed by "News Item X:" where X is the item number, followed by the headline in bold and a colon.
Format example:
* **News Item 1: Headline Title Here:** Thorough 4 to 5 sentence summary explaining what happened and why it matters.

* **News Item 2: Headline Title Here:** Thorough 4 to 5 sentence summary explaining what happened and why it matters.

* **News Item 3: Headline Title Here:** Thorough 4 to 5 sentence summary explaining what happened and why it matters.
If fewer than 5 major stories are available on a light news day, provide as many as are relevant (down to 1). If live news search yields no results or fails, output: "News highlights are currently unavailable."

5. **Verse of the Day:** Present an inspiring Bible verse along with its full Scripture reference (book, chapter, and verse). Follow the verse with a brief 2-sentence practical reflection on applying its message of faith, stewardship, or wisdom to the day ahead.
`.trim();

      let rawText = "";
      let actualModelUsed = requestedModel;
      let modelFallbackOccurred = false;

      try {
        const response = await ai.models.generateContent({
          model: requestedModel,
          contents: prompt,
          config: { tools: [{ googleSearch: {} }] }
        });
        rawText = response.text || "";
      } catch (geminiErr) {
        console.error(`Requested model ${requestedModel} failed, falling back to${DEFAULT_MODEL}:`, geminiErr);
        modelFallbackOccurred = true;
        actualModelUsed = `${DEFAULT_MODEL} (fallback)`;

        const fallbackResponse = await ai.models.generateContent({
          model: DEFAULT_MODEL,
          contents: prompt,
          config: { tools: [{ googleSearch: {} }] }
        });
        rawText = fallbackResponse.text || "";
      }

      rawText = rawText.replace(/^#+\s*/gm, "");

      // 10. Synthesize Audio via Google Cloud TTS
      let audioBase64 = null;
      let actualVoiceUsed = requestedVoice;
      let voiceFallbackOccurred = false;

      try {
        const { TextToSpeechClient } = await import("@google-cloud/text-to-speech");
        const ttsClient = new TextToSpeechClient();

        let cleanText = rawText.replace(/[#*_`~]/g, "").trim();

        // Inject SSML pauses
        let ssmlBody = cleanText.replace(/\n\n(?=Weather Overview|Actual Station Measurements|Market & Financial Summary|Key News Highlights|Verse of the Day)/g, '<break time="1500ms"/>\n\n');
        
        const firstBlankLineIndex = ssmlBody.indexOf("\n\n");
        if (firstBlankLineIndex !== -1) {
          ssmlBody = ssmlBody.slice(0, firstBlankLineIndex) + '<break time="750ms"/>' + ssmlBody.slice(firstBlankLineIndex);
        }

        ssmlBody = ssmlBody.replace(/(- (?:S&P 500|NASDAQ|Bitcoin|SPCX|Rocket Lab):[^\n]+)/g, '$1 <break time="500ms"/>');
        ssmlBody = ssmlBody.replace(/(\*\s*\*\*[^*]+:\*\*)/g, '$1 <break time="600ms"/>');

        ssmlBody = ssmlBody
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/&lt;break time="(\d+ms)"\/&gt;/g, '<break time="$1"/>');

        let ssmlText = `<speak><break time="500ms"/>${ssmlBody}</speak>`;
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