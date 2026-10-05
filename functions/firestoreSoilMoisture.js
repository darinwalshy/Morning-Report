// functions/firestoreSoilMoisture.js

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { LOCATIONS } from "./appeears.js";

// Ensure Firebase Admin App is initialized
if (getApps().length === 0) {
  initializeApp();
}

const db = getFirestore("morningreport");

/**
 * Batch store daily soil moisture records in Firestore
 */
export async function saveSoilMoistureRecords(parsedRecords) {
  if (!parsedRecords || parsedRecords.length === 0) return 0;

  const batch = db.batch();
  let count = 0;

  for (const record of parsedRecords) {
    if (!record.locationId || !record.date) continue;

    const docRef = db
      .collection("soil_moisture")
      .doc(record.locationId)
      .collection("daily_records")
      .doc(record.date);

    batch.set(
      docRef,
      {
        date: record.date,
        sm_surface: record.sm_surface,
        sm_rootzone: record.sm_rootzone,
        updatedAt: new Date()
      },
      { merge: true }
    );

    count++;
  }

  await batch.commit();
  return count;
}

/**
 * Fetch record near target date (+/- 2 days fallback)
 */
async function fetchSnapshotNearDate(locationId, targetDateStr) {
  const targetDate = new Date(targetDateStr);
  const minDateStr = new Date(targetDate.getTime() - 2 * 86400000).toISOString().split("T")[0];
  const maxDateStr = new Date(targetDate.getTime() + 2 * 86400000).toISOString().split("T")[0];

  const snapshot = await db
    .collection("soil_moisture")
    .doc(locationId)
    .collection("daily_records")
    .where("date", ">=", minDateStr)
    .where("date", "<=", maxDateStr)
    .orderBy("date", "desc")
    .limit(1)
    .get();

  if (snapshot.empty) return null;
  return snapshot.docs[0].data();
}

/**
 * Fetch absolute latest record
 */
async function fetchLatestSnapshot(locationId) {
  const snapshot = await db
    .collection("soil_moisture")
    .doc(locationId)
    .collection("daily_records")
    .orderBy("date", "desc")
    .limit(1)
    .get();

  if (snapshot.empty) return null;
  return snapshot.docs[0].data();
}

/**
 * Retrieve T0, T-7d, T-30d, T-365d comparative readings for all locations
 */
export async function getSoilMoistureBriefingContext() {
  const summaryLines = [];

  for (const loc of LOCATIONS) {
    const t0Doc = await fetchLatestSnapshot(loc.id);

    if (!t0Doc) {
      summaryLines.push(`${loc.name}: Soil moisture observations currently unavailable.`);
      continue;
    }

    const t0Date = new Date(t0Doc.date);
    const date7dStr = new Date(t0Date.getTime() - 7 * 86400000).toISOString().split("T")[0];
    const date30dStr = new Date(t0Date.getTime() - 30 * 86400000).toISOString().split("T")[0];
    const date365dStr = new Date(t0Date.getTime() - 365 * 86400000).toISOString().split("T")[0];

    const [doc7d, doc30d, doc365d] = await Promise.all([
      fetchSnapshotNearDate(loc.id, date7dStr),
      fetchSnapshotNearDate(loc.id, date30dStr),
      fetchSnapshotNearDate(loc.id, date365dStr)
    ]);

    const surfPct = t0Doc.sm_surface !== null ? (t0Doc.sm_surface * 100).toFixed(1) + "%" : "N/A";
    const rootPct = t0Doc.sm_rootzone !== null ? (t0Doc.sm_rootzone * 100).toFixed(1) + "%" : "N/A";

    const calcDelta = (current, previous) => {
      if (current === null || previous === null || current === undefined || previous === undefined) return "N/A";
      const diff = current - previous;
      const sign = diff >= 0 ? "+" : "";
      return `${sign}${(diff * 100).toFixed(1)}%`;
    };

    const surfDelta7d = calcDelta(t0Doc.sm_surface, doc7d?.sm_surface);
    const surfDelta30d = calcDelta(t0Doc.sm_surface, doc30d?.sm_surface);
    const surfDelta365d = calcDelta(t0Doc.sm_surface, doc365d?.sm_surface);

    const rootDelta7d = calcDelta(t0Doc.sm_rootzone, doc7d?.sm_rootzone);
    const rootDelta30d = calcDelta(t0Doc.sm_rootzone, doc30d?.sm_rootzone);
    const rootDelta365d = calcDelta(t0Doc.sm_rootzone, doc365d?.sm_rootzone);

    summaryLines.push(`
Location: ${loc.name}
- Latest Observation Date: ${t0Doc.date}
- Surface Soil Moisture (0-5cm): ${surfPct} (7d change: ${surfDelta7d}, 30d change: ${surfDelta30d}, 1yr change: ${surfDelta365d})
- Root Zone Soil Moisture (0-100cm): ${rootPct} (7d change: ${rootDelta7d}, 30d change: ${rootDelta30d}, 1yr change: ${rootDelta365d})
    `.trim());
  }

  return summaryLines.join("\n\n");
}