importScripts("firebase-config.js");

const DEFAULT_STATE = {
  enabled: false,
  licensed: false,
  licenseCode: "",
  sitePattern: "",
  expiresAt: "",
  debugStatus: null,
};

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function getEndOfDayTimestamp(value) {
  if (!value) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T23:59:59`).getTime();
  }

  return new Date(value).getTime();
}

function isExpired(expiresAt) {
  const expiresAtTimestamp = getEndOfDayTimestamp(expiresAt);
  return Number.isFinite(expiresAtTimestamp) && Date.now() > expiresAtTimestamp;
}

function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i");
}

function normalizeSitePattern(rawValue) {
  const value = (rawValue || "").trim();
  if (!value) return "";

  if (value.includes("*")) {
    return value;
  }

  try {
    const url = new URL(value);
    return `${url.origin}/*`;
  } catch (error) {
    return value;
  }
}

function isSiteAllowed(sitePattern, allowedSites) {
  if (!Array.isArray(allowedSites) || allowedSites.length === 0) {
    return true;
  }

  return allowedSites.some((allowedSite) => {
    if (allowedSite === "*") return true;
    return wildcardToRegex(allowedSite).test(sitePattern);
  });
}

function readFirestoreValue(field) {
  if (!field || typeof field !== "object") return null;
  if ("stringValue" in field) return field.stringValue;
  if ("booleanValue" in field) return field.booleanValue;
  if ("timestampValue" in field) return field.timestampValue;
  if ("integerValue" in field) return field.integerValue;
  if ("doubleValue" in field) return field.doubleValue;

  if (field.arrayValue?.values) {
    return field.arrayValue.values.map((item) => readFirestoreValue(item));
  }

  return null;
}

async function validateLicenseWithFirebase(licenseCode, sitePattern) {
  if (!FIREBASE_CONFIG.apiKey || !FIREBASE_CONFIG.projectId) {
    return {
      ok: false,
      reason: "config",
      message: "Set your Firebase API key and project ID in firebase-config.js.",
    };
  }

  const documentUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    FIREBASE_CONFIG.projectId
  )}/databases/(default)/documents/${encodeURIComponent(
    FIREBASE_CONFIG.collection
  )}/${encodeURIComponent(licenseCode)}?key=${encodeURIComponent(FIREBASE_CONFIG.apiKey)}`;

  const response = await fetch(documentUrl);

  if (response.status === 404) {
    return { ok: false, reason: "not_found", message: "License was not found." };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: "firebase",
      message: `Firebase returned ${response.status}.`,
    };
  }

  const data = await response.json();
  const fields = data.fields || {};
  const active = readFirestoreValue(fields.active);
  const expiresAt = readFirestoreValue(fields.expiresAt) || "";
  const allowedSites = readFirestoreValue(fields.allowedSites) || [];

  if (active === false) {
    return { ok: false, reason: "inactive", message: "License is disabled." };
  }

  if (isExpired(expiresAt)) {
    return { ok: false, reason: "expired", message: "License has expired.", expiresAt };
  }

  if (!isSiteAllowed(sitePattern, allowedSites)) {
    return {
      ok: false,
      reason: "site_not_allowed",
      message: "This license is not allowed for that site.",
    };
  }

  return { ok: true, expiresAt };
}

async function syncBadge() {
  const state = await chrome.storage.local.get(DEFAULT_STATE);

  if (!state.licensed) {
    setBadge("LOCK", "#555");
    return;
  }

  if (isExpired(state.expiresAt)) {
    await chrome.storage.local.set({ enabled: false, licensed: false });
    setBadge("EXP", "#800");
    return;
  }

  setBadge(state.enabled ? "ON" : "OFF", state.enabled ? "#0A0" : "#A00");
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set(DEFAULT_STATE);
  await syncBadge();
});

chrome.runtime.onStartup.addListener(syncBadge);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && ("enabled" in changes || "licensed" in changes || "expiresAt" in changes)) {
    syncBadge();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "GET_STATE") {
    chrome.storage.local.get(DEFAULT_STATE).then((state) => sendResponse(state));
    return true;
  }

  if (msg?.type === "ACTIVATE_LICENSE") {
    const licenseCode = (msg.code || "").trim();
    const sitePattern = normalizeSitePattern(msg.sitePattern);

    if (!licenseCode || !sitePattern) {
      sendResponse({
        ok: false,
        reason: "missing_fields",
        message: "Enter both a license code and a site URL/pattern.",
      });
      return true;
    }

    validateLicenseWithFirebase(licenseCode, sitePattern)
      .then(async (result) => {
        if (!result.ok) {
          sendResponse(result);
          return;
        }

        await chrome.storage.local.set({
          enabled: true,
          licensed: true,
          licenseCode,
          sitePattern,
          expiresAt: result.expiresAt || "",
        });

        sendResponse({ ok: true, expiresAt: result.expiresAt || "" });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          reason: "network",
          message: error?.message || "Could not reach Firebase.",
        });
      });

    return true;
  }

  if (msg?.type === "TOGGLE_ENABLED") {
    chrome.storage.local.get(DEFAULT_STATE).then(async (state) => {
      if (!state.licensed) {
        sendResponse({ ok: false, reason: "not_licensed", message: "Activate first." });
        return;
      }

      if (isExpired(state.expiresAt)) {
        await chrome.storage.local.set({ enabled: false, licensed: false });
        sendResponse({ ok: false, reason: "expired", message: "License has expired." });
        return;
      }

      const enabled = !state.enabled;
      await chrome.storage.local.set({ enabled });
      sendResponse({ ok: true, enabled });
    });

    return true;
  }
});
