/**
 * Welcome / tutorial page. Multi-step walkthrough that opens on first install.
 * Re-openable from the popup.
 */

const STORAGE_KEY = "statshelpr.welcomeShown";

const steps = document.querySelectorAll<HTMLElement>(".step");

function goTo(n: number) {
  steps.forEach((step) => {
    const id = Number(step.dataset["step"]);
    step.classList.toggle("hidden", id !== n);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const n = Number(btn.dataset["go"]);
    if (n) goTo(n);
  });
});

document.getElementById("skip-btn")?.addEventListener("click", finish);
document.getElementById("finish-btn")?.addEventListener("click", finish);

document.getElementById("copy-api-url")?.addEventListener("click", async () => {
  const codeEl = document.getElementById("api-url-sample");
  const text = codeEl?.textContent?.trim() ?? "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for older Chrome
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* ignore */
    }
    document.body.removeChild(ta);
  }
  const btn = document.getElementById("copy-api-url");
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = "copied";
    setTimeout(() => {
      btn.textContent = orig;
    }, 1200);
  }
});

function finish() {
  void chrome.storage.sync.set({ [STORAGE_KEY]: true }).then(() => {
    window.close();
  });
}

// On first load, mark seen on STEP 5 reveal too (in case user closes mid-tour)
const observer = new MutationObserver(() => {
  const lastStep = document.querySelector<HTMLElement>('[data-step="5"]');
  if (lastStep && !lastStep.classList.contains("hidden")) {
    void chrome.storage.sync.set({ [STORAGE_KEY]: true });
  }
});
observer.observe(document.body, {
  attributes: true,
  attributeFilter: ["class"],
  subtree: true,
});
