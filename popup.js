const activateButton = document.getElementById("activate");
const toggleButton = document.getElementById("toggle");
const licenseInput = document.getElementById("license");
const sitePatternInput = document.getElementById("sitePattern");
const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const debugEl = document.createElement("div");
debugEl.className = "meta";
metaEl.insertAdjacentElement("afterend", debugEl);

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b91c1c" : "#15803d";
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response);
    });
  });
}

function formatExpiry(expiresAt) {
  if (!expiresAt) return "";

  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) {
    return `Expires: ${expiresAt}`;
  }

  return `Expires: ${date.toLocaleDateString()}`;
}

async function refreshState() {
  const state = await sendMessage({ type: "GET_STATE" });

  licenseInput.value = state.licenseCode || "";
  sitePatternInput.value = state.sitePattern || "";
  toggleButton.textContent = state.enabled ? "Turn Off" : "Turn On";
  metaEl.textContent = [
    state.sitePattern ? `Site: ${state.sitePattern}` : "Site: not set",
    state.expiresAt ? formatExpiry(state.expiresAt) : "",
  ]
    .filter(Boolean)
    .join(" | ");
  debugEl.textContent = state.debugStatus
    ? `Debug: ${state.debugStatus.state}${state.debugStatus.matchedText ? ` | ${state.debugStatus.matchedText}` : ""}`
    : "Debug: no page status yet";

  if (state.licensed) {
    setStatus(state.enabled ? "Activated and running." : "Activated, currently paused.");
  } else {
    setStatus("Enter your site and license code to activate.", false);
  }
}

activateButton.addEventListener("click", async () => {
  const response = await sendMessage({
    type: "ACTIVATE_LICENSE",
    code: licenseInput.value.trim(),
    sitePattern: sitePatternInput.value.trim(),
  });

  if (!response?.ok) {
    setStatus(response?.message || "Activation failed.", true);
    return;
  }

  setStatus("Activated successfully.");
  await refreshState();
});

toggleButton.addEventListener("click", async () => {
  const response = await sendMessage({ type: "TOGGLE_ENABLED" });

  if (!response?.ok) {
    setStatus(response?.message || "Could not change state.", true);
    return;
  }

  setStatus(response.enabled ? "Extension turned on." : "Extension turned off.");
  await refreshState();
});

refreshState();
