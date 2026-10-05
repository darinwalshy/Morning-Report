// functions/appeears.js

const APPEEARS_API_URL = "https://appeears.earthdatacloud.nasa.gov/api";

const LOCATIONS = [
  { id: "mubende", name: "Mubende", latitude: 0.5585, longitude: 31.3949 },
  { id: "iganga", name: "Iganga", latitude: 0.6150, longitude: 33.4686 },
  { id: "masindi", name: "Masindi", latitude: 1.6744, longitude: 31.7150 }
];

const DATASET = "SPL4SMGP.008";
const LAYERS = ["sm_surface", "sm_rootzone"];

/**
 * Format a JavaScript Date object (or date string) to MM-DD-YYYY for AppEEARS
 */
function formatDateForAppEEARS(dateInput) {
  const dateObj = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
  const dd = String(dateObj.getDate()).padStart(2, "0");
  const yyyy = dateObj.getFullYear();
  return `${mm}-${dd}-${yyyy}`;
}

/**
 * Authenticate with NASA AppEEARS API
 */
async function loginAppEEARS(username, password) {
  const credentials = Buffer.from(`${username}:${password}`).toString("base64");
  const response = await fetch(`${APPEEARS_API_URL}/login`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`AppEEARS authentication failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.token;
}

/**
 * Submit an asynchronous Point Extraction Task to AppEEARS
 */
async function submitPointTask(token, startDateStr, endDateStr, taskName = "morning_report_smap") {
  const coordinates = LOCATIONS.map((loc) => ({
    id: loc.id,
    category: "Uganda_Locations",
    latitude: loc.latitude,
    longitude: loc.longitude
  }));

  const payload = {
    task_type: "point",
    task_name: `${taskName}_${Date.now()}`,
    params: {
      dates: [{ startDate: startDateStr, endDate: endDateStr }],
      layers: LAYERS.map((layer) => ({ product: DATASET, layer: layer })),
      coordinates: coordinates
    }
  };

  const response = await fetch(`${APPEEARS_API_URL}/task`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Failed to submit AppEEARS task (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.task_id;
}

/**
 * Poll task status until complete
 */
async function pollTaskCompletion(token, taskId, pollIntervalMs = 12000, maxTimeoutMs = 840000) {
  const startTime = Date.now();

  while (Date.now() - startTime < maxTimeoutMs) {
    const response = await fetch(`${APPEEARS_API_URL}/status/${taskId}`, {
      headers: { "Authorization": `Bearer ${token}` }
    });

    if (response.ok) {
      const data = await response.json();
      const status = data.status;

      if (status === "done") {
        return true;
      }
      if (status === "error") {
        throw new Error(`AppEEARS task ${taskId} failed on NASA servers.`);
      }
      console.log(`AppEEARS task ${taskId} status: ${status}. Retrying in ${pollIntervalMs / 1000}s...`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`AppEEARS task ${taskId} timed out after ${maxTimeoutMs / 1000}s.`);
}

/**
 * Download task bundle details and retrieve the output CSV file content
 */
async function fetchTaskCsvData(token, taskId) {
  const bundleResponse = await fetch(`${APPEEARS_API_URL}/bundle/${taskId}`, {
    headers: { "Authorization": `Bearer ${token}` }
  });

  if (!bundleResponse.ok) {
    throw new Error(`Failed to fetch bundle for task ${taskId}`);
  }

  const bundleData = await bundleResponse.json();
  const csvFile = bundleData.files?.find((f) => f.file_type === "csv" || f.file_name?.endsWith(".csv"));

  if (!csvFile) {
    throw new Error(`No output CSV file found in bundle for task ${taskId}`);
  }

  const downloadResponse = await fetch(`${APPEEARS_API_URL}/bundle/${taskId}/${csvFile.file_id}`, {
    headers: { "Authorization": `Bearer ${token}` }
  });

  if (!downloadResponse.ok) {
    throw new Error(`Failed to download CSV file ${csvFile.file_id}`);
  }

  return await downloadResponse.text();
}

/**
 * Basic CSV Parser to turn AppEEARS point CSV output into normalized records
 */
function parseAppEEARSCsv(csvText) {
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  
  // Find column indexes (handling AppEEARS CSV headers)
  const idIdx = headers.findIndex((h) => h.toLowerCase() === "id" || h.toLowerCase() === "location_id");
  const dateIdx = headers.findIndex((h) => h.toLowerCase() === "date" || h.toLowerCase() === "date/time");
  const layerIdx = headers.findIndex((h) => h.toLowerCase() === "layer" || h.toLowerCase() === "variable");
  const valueIdx = headers.findIndex((h) => h.toLowerCase() === "value" || h.toLowerCase() === "data_value");

  const recordsMap = {}; // Key: `${locationId}_${YYYY-MM-DD}`

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));

    const locId = cols[idIdx]?.toLowerCase();
    const rawDate = cols[dateIdx];
    const layer = cols[layerIdx];
    const rawVal = parseFloat(cols[valueIdx]);

    if (!locId || !rawDate || !layer || isNaN(rawVal)) continue;

    // Standardize date to YYYY-MM-DD for Firestore
    let dateStr = rawDate.split("T")[0].split(" ")[0];
    if (dateStr.includes("-") && dateStr.split("-")[0].length === 2) {
      // If returned as MM-DD-YYYY, convert to YYYY-MM-DD
      const [m, d, y] = dateStr.split("-");
      dateStr = `${y}-${m}-${d}`;
    }

    const key = `${locId}_${dateStr}`;

    if (!recordsMap[key]) {
      recordsMap[key] = {
        locationId: locId,
        date: dateStr,
        sm_surface: null,
        sm_rootzone: null
      };
    }

    if (layer.includes("sm_surface")) {
      recordsMap[key].sm_surface = rawVal;
    } else if (layer.includes("sm_rootzone")) {
      recordsMap[key].sm_rootzone = rawVal;
    }
  }

  return Object.values(recordsMap);
}

/**
 * Orchestrate complete sync pipeline for a given date range
 */
export async function executeAppEEARSSync(username, password, startDateStr, endDateStr, taskName) {
  // Ensure dates sent to AppEEARS use MM-DD-YYYY
  const formattedStartDate = formatDateForAppEEARS(startDateStr);
  const formattedEndDate = formatDateForAppEEARS(endDateStr);

  console.log(`Logging into AppEEARS...`);
  const token = await loginAppEEARS(username, password);

  console.log(`Submitting point task for range ${formattedStartDate} to ${formattedEndDate}...`);
  const taskId = await submitPointTask(token, formattedStartDate, formattedEndDate, taskName);

  console.log(`Polling task ${taskId}...`);
  await pollTaskCompletion(token, taskId);

  console.log(`Downloading CSV output for task ${taskId}...`);
  const csvText = await fetchTaskCsvData(token, taskId);

  console.log(`Parsing CSV data...`);
  return parseAppEEARSCsv(csvText);
}

export { LOCATIONS, formatDateForAppEEARS };