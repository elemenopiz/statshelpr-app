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

// Discreet mode demo (step 3): purely local preview, not wired to any real
// extension state — just fades the mock solve button as the slider moves.
const discreetSlider = document.getElementById(
  "discreet-slider",
) as HTMLInputElement | null;
const discreetBtn = document.getElementById("discreet-demo-btn");
const discreetValue = document.getElementById("discreet-slider-value");
if (discreetSlider && discreetBtn && discreetValue) {
  const applyOpacity = () => {
    const pct = Number(discreetSlider.value);
    discreetBtn.style.opacity = String(pct / 100);
    discreetValue.textContent = `${pct}%`;
  };
  discreetSlider.addEventListener("input", applyOpacity);
  applyOpacity();
}

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
