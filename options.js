"use strict";

const emailInput = document.getElementById("email");
const saveBtn    = document.getElementById("save");
const statusEl   = document.getElementById("status");

(async () => {
  const { email } = await browser.storage.sync.get("email");
  if (email) emailInput.value = email;
})();

saveBtn.addEventListener("click", async () => {
  const email = emailInput.value.trim();
  if (email && !/^[^@]+@[^@]+$/.test(email)) {
    show("Please enter a valid email address.", "error");
    return;
  }
  try {
    await browser.storage.sync.set({ email });
    show(email ? "Saved." : "Cleared.", "ok");
  } catch (err) {
    show(`Error: ${err.message}`, "error");
  }
});

document.getElementById("flush").addEventListener("click", async () => {
  try {
    // Remove all storage.local keys (hg rev cache + author push stores).
    await browser.storage.local.clear();
    // Ask the background to drop its in-memory caches too.
    await browser.runtime.sendMessage({ type: "flushCaches" });
    show("Caches flushed.", "ok");
  } catch (err) {
    show(`Error: ${err.message}`, "error");
  }
});

const STATUS_CLEAR_MS = 2_000;

function show(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className   = cls;
  if (cls === "ok") setTimeout(() => { statusEl.textContent = ""; }, STATUS_CLEAR_MS);
}
