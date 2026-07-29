/**
 * Welcome page. A single screen that opens on first install and is
 * re-openable from the popup. Nothing to advance through — the only
 * interaction is the discreet-mode slider.
 */

const STORAGE_KEY = "statshelpr.welcomeShown";

// Solve demo: a self-contained rehearsal of the real thing — click, a beat of
// thinking, then the answer is selected. Nothing here talks to the solver;
// the point is that the button is a button. Clicking again replays it.
const THINK_MS = 1000;

const solveBtn = document.getElementById("demo-solve");
const solveLabel = document.getElementById("demo-solve-label");
const answerRow = document.getElementById("mock-answer");
const tryHint = document.getElementById("try-hint");
let solving = false;

solveBtn?.addEventListener("click", () => {
  if (solving) return;
  solving = true;

  solveBtn.classList.add("used"); // stops the idle pulse for good
  tryHint?.classList.add("gone");
  answerRow?.classList.remove("picked"); // clear the previous run
  solveBtn.classList.remove("done");
  solveBtn.classList.add("thinking");
  if (solveLabel) solveLabel.textContent = "thinking";

  window.setTimeout(() => {
    solveBtn.classList.remove("thinking");
    solveBtn.classList.add("done");
    if (solveLabel) solveLabel.textContent = "done";
    answerRow?.classList.add("picked");
    solving = false;
  }, THINK_MS);
});

// Discreet mode demo: purely local preview, not wired to any real extension
// state — mirrors the real on-page button's perceptual dimming curve (see
// applyButtonOpacity() in content.ts): the button dims uniformly (label +
// outline together) along a gamma curve, so equal slider movement is roughly
// equal perceived change and the faint end has fine resolution. Keep
// DIM_GAMMA in sync with content.ts.
const DIM_GAMMA = 2.2;
const discreetSlider = document.getElementById("discreet-slider") as HTMLInputElement | null;
const discreetBtn = document.getElementById("discreet-demo-btn");
const discreetText = document.getElementById("discreet-demo-text");
const discreetValue = document.getElementById("discreet-slider-value");
const dial = document.querySelector<HTMLElement>(".dial");
const dialCaption = document.getElementById("dial-caption");

function captionFor(dialPct: number): string {
  if (dialPct === 0) return "invisible — still clickable";
  if (dialPct < 30) return "barely there";
  if (dialPct < 70) return "subtle";
  return "impossible to miss";
}

if (discreetSlider && discreetBtn && discreetText && discreetValue) {
  const apply = () => {
    const pct = Math.min(100, Math.max(0, Number(discreetSlider.value)));
    const op = Math.pow(pct / 100, DIM_GAMMA).toFixed(4);
    discreetText.style.opacity = op;
    discreetBtn.style.borderColor = `rgba(39, 66, 200, ${op})`;
    discreetBtn.style.backgroundColor = `rgba(255, 255, 255, ${op})`;
    discreetValue.textContent = String(pct);
    if (dialCaption) dialCaption.textContent = captionFor(pct);
    // paint the travelled part of the track blue
    discreetSlider.style.background =
      `linear-gradient(90deg, var(--blue) 0 ${pct}%, var(--line) ${pct}% 100%)`;
  };
  discreetSlider.addEventListener("input", () => {
    dial?.classList.add("touched");
    apply();
  });
  apply();
}

// One page, so there is nothing left to advance through: mark it seen on
// arrival. Last, so the page still works if the extension APIs are absent.
void chrome.storage.sync.set({ [STORAGE_KEY]: true });
