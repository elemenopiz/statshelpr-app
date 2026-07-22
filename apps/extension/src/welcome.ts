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
// extension state — mirrors the real on-page button's perceptual dimming
// curve (see applyButtonOpacity() in content.ts): the button dims uniformly
// (label + outline together) along a gamma curve, so equal slider movement is
// roughly equal perceived change and the faint end has fine resolution. Keep
// DIM_GAMMA in sync with content.ts.
const DIM_GAMMA = 2.0;
const discreetSlider = document.getElementById("discreet-slider") as HTMLInputElement | null;
const discreetBtn = document.getElementById("discreet-demo-btn");
const discreetText = document.getElementById("discreet-demo-text");
const discreetValue = document.getElementById("discreet-slider-value");

if (discreetSlider && discreetBtn && discreetText && discreetValue) {
  const applyOpacity = () => {
    const dial = Math.min(1, Math.max(0, Number(discreetSlider.value) / 100));
    const op = Math.pow(dial, DIM_GAMMA).toFixed(4);
    discreetText.style.opacity = op;
    discreetBtn.style.borderColor = `rgba(39, 66, 200, ${op})`;
    discreetBtn.style.backgroundColor = `rgba(255, 255, 255, ${op})`;
    discreetValue.textContent = `${discreetSlider.value}%`;
  };
  discreetSlider.addEventListener("input", applyOpacity);
  applyOpacity();
}

function finish() {
  void chrome.storage.sync.set({ [STORAGE_KEY]: true }).then(() => {
    window.close();
  });
}

// On first load, mark seen on the last step's reveal too (in case the user
// closes mid-tour instead of clicking "Open Canvas").
const observer = new MutationObserver(() => {
  const lastStep = document.querySelector<HTMLElement>('[data-step="4"]');
  if (lastStep && !lastStep.classList.contains("hidden")) {
    void chrome.storage.sync.set({ [STORAGE_KEY]: true });
  }
});
observer.observe(document.body, {
  attributes: true,
  attributeFilter: ["class"],
  subtree: true,
});
