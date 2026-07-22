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
// extension state — mirrors the real on-page button's single dial (see
// applyButtonOpacity() in content.ts): from 100% down to 20%, only the
// "solve" label fades while the outline (border + white fill) stays put;
// below 20%, the label is already gone and the outline itself fades the
// rest of the way to nothing.
const OUTLINE_FADE_START = 0.2;
const discreetSlider = document.getElementById("discreet-slider") as HTMLInputElement | null;
const discreetBtn = document.getElementById("discreet-demo-btn");
const discreetText = document.getElementById("discreet-demo-text");
const discreetValue = document.getElementById("discreet-slider-value");

if (discreetSlider && discreetBtn && discreetText && discreetValue) {
  const applyOpacity = () => {
    const dial = Number(discreetSlider.value) / 100;
    const textOpacity =
      dial >= OUTLINE_FADE_START ? (dial - OUTLINE_FADE_START) / (1 - OUTLINE_FADE_START) : 0;
    const outlineOpacity = dial >= OUTLINE_FADE_START ? 1 : dial / OUTLINE_FADE_START;
    discreetText.style.opacity = String(textOpacity);
    discreetBtn.style.borderColor = `rgba(39, 66, 200, ${outlineOpacity})`;
    discreetBtn.style.backgroundColor = `rgba(255, 255, 255, ${outlineOpacity})`;
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
