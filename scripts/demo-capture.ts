// Records the submission-video footage: drives the site through the scenes in docs/runbooks/demo.md
// with a drawn cursor (Playwright never moves the real pointer, and its video has none) and writes
// scene start times for lining up the voiceover in docs/runbooks/voiceover.md.
//
// Safe by default: it stops at the approval checkbox unless --execute is passed, and it never
// prints the administrator password. Usage and options: `npm run demo:capture -- --help`.
import { spawnSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

const HELP = `Usage: npm run demo:capture -- [options]

  --url <url>        Site to record (default https://aurrery.onrender.com)
  --scenes <list>    Scenes to record, e.g. 1,2,3 (default 1,2,3,4,5,6)
  --execute          Click "Approve & execute" in scene 5 (changes Pilots A and B in PayPal Sandbox)
  --manual           Scene 2 uses "Simulate strategies" instead of the agent (no AI quota)
  --allow-incomplete Keep recording if the agent stops early but has made a comparison (previews only)
  --reset-after      After an executed take, run the administrator demo reset off camera
  --headed           Show the browser window (for recording with OBS instead of the built-in video)
  --pace <factor>    Multiply every pause (default 1; 1.2 gives the narration more room)
  --out <dir>        Output folder (default demo-capture/<timestamp>)

The administrator password is read from AURRERY_ADMIN_PASSWORD and used only in an
unrecorded browser context. Without it, a hosted site shows scene 5 signed out.`;

type Options = { url: string; scenes: Set<number>; execute: boolean; manual: boolean; allowIncomplete: boolean; resetAfter: boolean; headed: boolean; pace: number; out: string };
type Mark = { scene: number; title: string; atSeconds: number };

const VIEWPORT = { width: 1600, height: 900 };

function parseArgs(argv: string[]): Options | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const options: Options = { url: "https://aurrery.onrender.com", scenes: new Set([1, 2, 3, 4, 5, 6]), execute: false, manual: false, allowIncomplete: false, resetAfter: false, headed: false, pace: 1, out: join("demo-capture", stamp) };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${arg} needs a value`); return next; };
    if (arg === "--help" || arg === "-h") return null;
    else if (arg === "--url") options.url = value().replace(/\/$/, "");
    else if (arg === "--scenes") options.scenes = new Set(value().split(",").map(Number).filter((n) => n >= 1 && n <= 6));
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--manual") options.manual = true;
    else if (arg === "--allow-incomplete") options.allowIncomplete = true;
    else if (arg === "--reset-after") options.resetAfter = true;
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--pace") options.pace = Math.max(0.3, Number(value()) || 1);
    else if (arg === "--out") options.out = value();
    else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}

/** Runs in the page: an arrow cursor that follows mouse events, and a gold ripple on each press. */
function installCursor() {
  const mount = () => {
    if (document.getElementById("__demo-cursor")) return;
    const style = document.createElement("style");
    style.textContent = `
      #__demo-cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483647; pointer-events: none;
        transform: translate(-100px, -100px); filter: drop-shadow(0 2px 3px rgba(0,0,0,.55)); transition: scale .12s ease; }
      #__demo-cursor.down { scale: .86; }
      .__demo-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 44px; height: 44px; margin: -22px 0 0 -22px;
        border-radius: 50%; border: 3px solid #e2bd6a; background: rgba(226,189,106,.22); animation: __demo-ripple .6s ease-out forwards; }
      @keyframes __demo-ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }`;
    const cursor = document.createElement("div");
    cursor.id = "__demo-cursor";
    cursor.innerHTML = `<svg viewBox="0 0 26 26" width="26" height="26"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15 L18.5 15 Z" fill="#ffffff" stroke="#0a1a40" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    document.documentElement.append(style, cursor);
    // The arrow's tip is at (3, 2) in its box.
    window.addEventListener("mousemove", (e) => { cursor.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`; }, true);
    window.addEventListener("mousedown", (e) => {
      cursor.classList.add("down");
      const ripple = document.createElement("div");
      ripple.className = "__demo-ripple";
      ripple.style.left = `${e.clientX}px`;
      ripple.style.top = `${e.clientY}px`;
      document.documentElement.append(ripple);
      setTimeout(() => ripple.remove(), 700);
    }, true);
    window.addEventListener("mouseup", () => cursor.classList.remove("down"), true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
}

/** Runs in the page: hides the admin-only draft messages, which contain customers' private PayPal approval links. */
function hideApprovalLinks() {
  const style = document.createElement("style");
  style.textContent = `section[aria-labelledby="annual-offers-title"] div:has(> h3), textarea[aria-label^="Draft message"] { display: none !important; }`;
  document.documentElement.append(style);
}

/** Human-paced pointer and scrolling for one page. */
class Director {
  private x = VIEWPORT.width / 2;
  private y = VIEWPORT.height / 2;
  constructor(private page: Page, private pace: number) {}

  hold(ms: number) { return this.page.waitForTimeout(ms * this.pace); }

  async glide(x: number, y: number) {
    const distance = Math.hypot(x - this.x, y - this.y);
    await this.page.mouse.move(x, y, { steps: Math.round(Math.min(60, Math.max(12, distance / 14))) });
    this.x = x; this.y = y;
  }

  /** Eased scroll that puts the element near the top ("start") or the middle of the viewport. */
  async scrollTo(target: Locator, block: "start" | "center" = "start") {
    await target.first().waitFor({ state: "attached", timeout: 30_000 });
    await target.first().evaluate((el, where) => new Promise<void>((done) => {
      const rect = el.getBoundingClientRect();
      const offset = where === "start" ? 72 : Math.max(72, (innerHeight - rect.height) / 2);
      const max = document.documentElement.scrollHeight - innerHeight;
      const from = scrollY;
      const to = Math.max(0, Math.min(max, from + rect.top - offset));
      const duration = Math.min(1400, Math.max(450, Math.abs(to - from) * 0.6));
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        scrollTo({ top: from + (to - from) * (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2), behavior: "instant" });
        if (t < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    }), block);
    await this.hold(250);
  }

  private async centre(target: Locator) {
    const element = target.first();
    await element.waitFor({ state: "visible", timeout: 30_000 });
    const box = await element.boundingBox();
    if (!box) throw new Error("Element has no box");
    if (box.y < 0 || box.y + box.height > VIEWPORT.height) {
      await this.scrollTo(element, "center");
      return (await element.boundingBox())!;
    }
    return box;
  }

  async point(target: Locator, ms = 0) {
    const box = await this.centre(target);
    await this.glide(box.x + Math.min(box.width / 2, 60), box.y + box.height / 2);
    if (ms) await this.hold(ms);
  }

  async click(target: Locator) {
    const box = await this.centre(target);
    await this.glide(box.x + box.width / 2, box.y + box.height / 2);
    await this.hold(220);
    await this.page.mouse.down();
    await this.page.waitForTimeout(90);
    await this.page.mouse.up();
    await this.hold(350);
  }
}

async function exists(locator: Locator) { return (await locator.count()) > 0 && await locator.first().isVisible(); }

async function signInOffCamera(browser: Browser, url: string) {
  const password = process.env.AURRERY_ADMIN_PASSWORD;
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  // Also wakes a sleeping Render service (it serves a holding page until the app is up) before the recorded take starts.
  for (let attempt = 1; ; attempt++) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
    if (await page.locator("#decision-title").waitFor({ timeout: 20_000 }).then(() => true, () => false)) break;
    if (attempt === 12) throw new Error("The site did not come up within about 5 minutes.");
    console.log("Waiting for the site to wake…");
    await page.waitForTimeout(5_000);
  }
  const session = await (await context.request.get(`${url}/api/admin/session`)).json() as { authenticated?: boolean };
  const access = page.getByRole("region", { name: "Administrator access" });
  if (session.authenticated) {
    console.log("Administrator access is already granted.");
  } else if (password) {
    await access.getByLabel("Administrator password").fill(password);
    await access.getByRole("button", { name: "Sign in" }).click();
    await access.getByText("Signed in for merchant decisions").waitFor({ timeout: 30_000 });
    console.log("Signed in off camera.");
  } else {
    console.log("AURRERY_ADMIN_PASSWORD is not set: scene 5 will be recorded signed out.");
  }
  const state = await context.storageState();
  await context.close();
  return state;
}

async function waitForAgent(page: Page, allowIncomplete: boolean) {
  const agent = page.locator('[aria-label="Agent activity"]');
  const stop = page.getByRole("button", { name: "Stop agent" });
  await stop.waitFor({ state: "visible", timeout: 15_000 });
  await stop.waitFor({ state: "detached", timeout: 240_000 });
  const status = (await agent.first().getByRole("status").textContent())?.trim() ?? "";
  if (status.startsWith("Investigation complete")) return;
  if (!allowIncomplete || !await page.getByRole("heading", { name: "Scenario comparison" }).isVisible()) throw new Error(`Agent run did not complete: ${status || "no status"}`);
  console.log(`Continuing after an incomplete agent run: ${status}`);
}

async function record(options: Options) {
  const out = resolve(options.out);
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: !options.headed });
  const marks: Mark[] = [];
  let context: BrowserContext | null = null;
  try {
    const storageState = await signInOffCamera(browser, options.url);
    context = await browser.newContext({ viewport: VIEWPORT, storageState, colorScheme: "dark", recordVideo: options.headed ? undefined : { dir: out, size: VIEWPORT } });
    // tsx (esbuild keepNames) wraps named functions in __name(), which page-side code needs too.
    await context.addInitScript({ content: "globalThis.__name = (fn) => fn;" });
    await context.addInitScript(installCursor);
    await context.addInitScript(hideApprovalLinks);
    const page = await context.newPage();
    const started = Date.now();
    const d = new Director(page, options.pace);
    const scene = async (n: number, title: string, run: () => Promise<void>) => {
      if (!options.scenes.has(n)) return;
      marks.push({ scene: n, title, atSeconds: Math.round((Date.now() - started) / 100) / 10 });
      console.log(`Scene ${n}: ${title}`);
      await run();
    };

    try {
      await page.goto(options.url, { waitUntil: "networkidle", timeout: 120_000 });
      await page.locator("#decision-title").waitFor();
      await page.mouse.move(VIEWPORT.width * 0.62, VIEWPORT.height * 0.55);
      await d.hold(800);

      await scene(1, "Hook", async () => {
        await d.point(page.locator("#decision-title"), 2500);
        await d.scrollTo(page.locator("#merchant-overview-title"));
        await d.point(page.locator("svg.planisphere"), 3500);
        await d.point(page.getByRole("list", { name: "Subscriber segments and estimated churn" }), 3000);
      });

      await scene(2, "The agent reads the signals", async () => {
        await d.scrollTo(page.locator("#objective-title"));
        await d.point(page.locator("#objective"), 1800);
        if (options.manual) {
          await d.click(page.getByRole("button", { name: "Simulate strategies" }));
          await page.getByRole("button", { name: /^Simulating/ }).waitFor({ state: "detached", timeout: 120_000 }).catch(() => undefined);
        } else {
          await d.click(page.getByRole("button", { name: /Run agent/ }));
          await d.point(page.getByRole("log", { name: "Agent public activity" }));
          await waitForAgent(page, options.allowIncomplete);
        }
        await d.hold(1500);
      });

      await scene(3, "The twin corrects the obvious move", async () => {
        await d.scrollTo(page.locator("#decision-title"));
        const headline = await page.locator("#decision-title").textContent();
        if (!/Price-driven cancel save/.test(headline ?? "")) console.log(`Check the narration: the agent's headline is "${headline}", and scene 3 describes the price-driven save.`);
        await d.point(page.locator("#decision-title"), 3000);
        await d.point(page.getByText(/^Likely value change/), 4000);
        await d.point(page.getByText("Chance of doing worse"), 4000);
        const stress = page.getByText(/^Adverse stress/);
        if (await exists(stress)) await d.point(stress, 4000);
      });

      await scene(4, "Trade-offs", async () => {
        const grid = page.getByRole("heading", { name: "Scenario comparison" });
        await d.scrollTo(grid);
        await d.point(page.locator(".ag-row", { hasText: /At-risk/ }).first(), 3000);
        await d.point(page.locator(".ag-row", { hasText: /Annual prepay/ }).first(), 3500);
        await d.click(page.locator(".ag-row", { hasText: /Price-driven cancel save/ }).first());
        await d.hold(1000);
        await d.scrollTo(page.locator('svg[role="img"][aria-label^="Active subscribers"]'), "center");
        await d.point(page.locator('svg[role="img"][aria-label^="Active subscribers"]'), 3000);
        await d.point(page.locator("#evidence-title"), 3500);
      });

      await scene(5, "Approval and PayPal", async () => {
        await d.scrollTo(page.locator("#approval"));
        const prepare = page.getByRole("button", { name: "Prepare PayPal action" });
        const confirm = page.getByRole("checkbox", { name: /I approve changing the price/ });
        // The panel re-renders after the grid selection; wait for whichever state it settles in.
        await prepare.or(confirm).first().waitFor({ timeout: 30_000 });
        if (await exists(prepare)) await d.click(prepare);
        await confirm.waitFor({ timeout: 60_000 });
        await d.point(page.getByText("Price change", { exact: true }), 2500);
        await d.point(page.getByText("Payload hash", { exact: true }), 2500);
        if (await confirm.isDisabled()) {
          console.log("The approval checkbox is disabled (signed out); the take stops at the approval card.");
          await d.hold(2000);
        } else {
          await d.click(confirm);
          const approve = page.getByRole("button", { name: "Approve & execute" });
          if (options.execute) {
            await d.click(approve);
            const report = page.getByRole("heading", { name: /PayPal execution:/ });
            await report.waitFor({ timeout: 120_000 });
            await d.scrollTo(report);
            await d.hold(4500);
            await d.scrollTo(page.getByRole("heading", { name: "Pilot cohort in PayPal Sandbox" }));
            await d.hold(3500);
          } else {
            await d.point(approve, 3000);
            console.log("Rehearsal: Approve & execute was not clicked (pass --execute for the real take).");
          }
        }
        // A private approval link must never reach the footage: stop the take rather than record one.
        if (await page.locator('textarea[aria-label^="Draft message"]').first().isVisible().catch(() => false)) throw new Error("A draft message with an approval link is visible; stopping the take.");
        // Shown only when the ledger has annual offers (the hosted demo does; a fresh local ledger does not).
        if (await exists(page.locator("#annual-offers-title"))) {
          await d.scrollTo(page.locator("#annual-offers-title"));
          await d.hold(4000);
        } else console.log("No Annual offers panel on this site; skipped.");
        if (await exists(page.locator("#annual-evidence-title"))) {
          await d.scrollTo(page.locator("#annual-evidence-title"), "center");
          await d.point(page.locator("#annual-evidence-title"), 4000);
        }
      });

      await scene(6, "Generality and close", async () => {
        const summary = page.locator("summary", { hasText: "Use your own data" });
        await d.scrollTo(summary);
        await d.click(summary);
        await d.click(page.getByRole("button", { name: "Load sample merchant" }));
        await page.getByText(/^Using .+\.csv/).first().waitFor({ timeout: 30_000 });
        await d.click(page.getByRole("button", { name: "Build twin" }));
        const banner = page.getByRole("region", { name: "Imported merchant" });
        await banner.waitFor({ timeout: 60_000 });
        await d.scrollTo(banner);
        await d.point(banner, 2500);
        const simulate = page.getByRole("button", { name: "Simulate strategies" });
        await d.click(simulate);
        await page.getByRole("button", { name: /^Simulating/ }).waitFor({ state: "detached", timeout: 120_000 }).catch(() => undefined);
        await d.scrollTo(page.locator("#decision-title"));
        await d.point(page.locator("#decision-title"), 5000);
        await d.click(page.getByRole("button", { name: "Back to Ridgeline" }));
        await banner.waitFor({ state: "detached", timeout: 30_000 });
        await d.scrollTo(page.locator("#decision-title"));
        await d.point(page.locator("#decision-title"), 3500);
      });

    } finally {
      // A failed take still saves its footage and marks, so the good scenes can be reused.
      const video = page.video();
      await context.close();
      context = null;
      await writeFile(join(out, "marks.json"), JSON.stringify(marks, null, 2) + "\n");
      if (video) {
        const webm = join(out, "demo.webm");
        await rename(await video.path(), webm);
        if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0) {
          const mp4 = join(out, "demo.mp4");
          const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-vf", "scale=1920:1080:flags=lanczos", "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p", mp4], { stdio: "inherit" });
          console.log(result.status === 0 ? `Saved ${mp4}` : "ffmpeg conversion failed; the .webm is still there.");
        }
        console.log(`Saved ${webm}`);
    }
    console.log(`Scene marks: ${join(out, "marks.json")}`);
    }

    if (options.execute && options.resetAfter) await resetOffCamera(browser, options.url, storageState);
  } finally {
    await context?.close().catch(() => undefined);
    await browser.close();
  }
}

/** Administrator demo reset (preview, confirm) in an unrecorded context, to put Pilots A and B back at $24. */
async function resetOffCamera(browser: Browser, url: string, storageState: Awaited<ReturnType<BrowserContext["storageState"]>>) {
  const context = await browser.newContext({ viewport: VIEWPORT, storageState });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 120_000 });
    // The recovery panel is folded unless something is outstanding.
    const preview = page.getByRole("button", { name: "Preview demo reset" });
    const fold = page.locator("summary", { has: page.locator("#recovery-title") });
    await fold.waitFor({ timeout: 30_000 });
    if (!await preview.isVisible()) await fold.click();
    await preview.waitFor({ timeout: 30_000 });
    await preview.click();
    const confirm = page.getByRole("checkbox", { name: /I confirm resetting/ });
    const nothing = page.getByText("No active off-list registered pilots require a reset.");
    await confirm.or(nothing).first().waitFor({ timeout: 60_000 });
    if (await exists(nothing)) { console.log("Reset: no pilots needed a reset."); return; }
    await confirm.check();
    await page.getByRole("button", { name: "Confirm & reset" }).click();
    await page.getByRole("button", { name: "Confirm & reset" }).waitFor({ state: "detached", timeout: 120_000 });
    const recovery = page.locator("section", { has: page.locator("#recovery-title") });
    console.log(`Reset: ${(await recovery.locator("p").last().textContent())?.trim()}`);
    console.log("Check the pilot table with Refresh from PayPal: A and B should read back at $24.0/mo.");
  } finally {
    await context.close();
  }
}

const options = parseArgs(process.argv.slice(2));
if (!options) console.log(HELP);
else record(options).catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
