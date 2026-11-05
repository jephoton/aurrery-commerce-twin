# Demo runbook

A step-by-step script for a live demo or the submission video of Aurrery on https://aurrery.onrender.com. Target length about 2:40 (hard limit 3:00). Everything runs in PayPal **Sandbox** with synthetic merchant data.

## Before you start (10 minutes ahead)

1. **Check the deploy.** The Render service should be on the latest `main`. If a new build is pending, deploy it from the Render dashboard (Manual Deploy → Deploy latest commit) and wait for "Deploy succeeded".
2. **Wake the service.** Render Free sleeps after 15 idle minutes and takes about 35–60 s to wake. Open the site once a few minutes before you start, then reload.
3. **Have these ready (never on screen or in the recording):**
   - the administrator password (`ADMIN_PASSWORD` in your private `data/render-runtime.env`);
   - the PayPal Sandbox personal (buyer) account login, in a separate private browser window.
4. **Check the pilots.** Scroll to "Pilot cohort in PayPal Sandbox" and choose **Refresh from PayPal** once. Expected: A, B, C and D ACTIVE at `$24.0/mo`; E on `$244.8/yr`. If A or B is not at $24, run **Administrator demo reset** first (see Recovery).
5. **AI budget.** Each agent run uses about 7 Gemini requests; the hosted limits are 10 runs an hour and 30 a day across the whole site. Avoid test runs on demo day, and refresh from PayPal sparingly (60 status reads an hour site-wide).
6. **Sample files.** The import panel loads the Hollowbrook sample itself; no files to prepare.

## The run

### 1. Hook (0:00–0:20)

- Show the landing page: Ridgeline Roasters, 2,297 active subscribers, the planisphere of segments.
- Line: "Churn is up. The obvious move is a discount. Is it worth it? Aurrery simulates before you transact."

### 2. The agent reads the signals (0:20–0:45)

- Keep the default objective (at-risk churn) and choose **Run agent**.
- Narrate the timeline as it streams: it classifies the synthetic cancel-survey and support messages into intent and reason, and finds price-driven cancel-intent subscribers. A run takes about 15–30 s.

### 3. First instinct, then correction (0:45–1:25)

- The agent tests the broad at-risk discount: it loses value most of the time.
- It lands on two moves:
  - **Tactical:** the price-driven cancel save (25% off for 3 months), cheap and more likely to help than hurt.
  - **Strategic:** annual prepay at 15% off, the big lever, now "Recommended now".
- Point out "Bigger simulated levers": the price rise looks large but rests on an assumption about price response and touches every subscriber, so it is not recommended.

### 4. Trade-offs (1:25–1:50)

- Scenario comparison grid: median value, 80% interval, chance of worse than doing nothing, discount given, PayPal column.
- Click a row to see its trajectory fan chart.
- Evidence record ("What this rests on"): which numbers are estimated, observed (sandbox) or assumptions.

### 5. Approval and PayPal (1:50–2:20)

Sign in through **Administrator access** first (password off screen).

**Save offer (live):**
1. Select "Price-driven cancel save" (in the grid or the "Also executable" list) and choose **Prepare PayPal action** in Approval.
2. The card shows the exact action: $24.00 → $18.00 for 3 months, targets Pilot A and Pilot B, the payload hash.
3. Tick the confirmation box and choose **Approve & execute**.
4. Expected: the execution report shows both targets with the price read back from PayPal and verified; the pilot table shows A and B at the discounted price.

**Annual plan (show the recorded result):** the live annual offer cannot be repeated with the current pilots: Pilot E already switched to the annual plan on 2026-11-01, and Pilot D's offer is still open until its window closes (2026-11-08 10:05 UTC, then a confirming read six hours later). So for the demo:
- Scroll to **Annual offers**: E "Switched (verified by PayPal)", D "Pending customer decision".
- In the pilot table, E shows `$244.8/yr`.
- In the evidence record, "Annual offers": core 1 accepted, and annual uptake for core moved from 12% to about 15% (observed).
- Line: "Each customer has to accept the annual plan in PayPal. Pilot E did, and the twin learned from it."

To show a fresh annual offer live instead, see "Repeating the annual offer" below.

### 6. Generality and close (2:20–2:40)

1. Open **Use your own data**, choose **Load sample merchant**, then **Build twin** (with or without the feedback file; without it there is no AI call).
2. Expected: the banner "Imported: Hollowbrook Treat Box · simulate only"; PayPal actions are hidden.
3. Choose **Simulate strategies**. Expected headline: "At-risk: 20% off for 3 months" as "Best within your rules · simulate only" (about +$2,163 median at 400 futures), beating annual prepay. Same engine, different business, different answer.
4. Choose **Back to Ridgeline**.
5. Close: "Simulate before you transact."

## After the demo

1. **Restore Pilots A and B to $24:** either **Restore a verified discount** (a separate proposal: prepare, review, approve) or **Administrator demo reset** (preview, then confirm). Then **Refresh from PayPal** and check A and B read back at `$24.0/mo`.
2. Sign out of administrator access.

## Recovery

| Problem | What to do |
| --- | --- |
| Blank or slow first load | The service is waking; wait up to a minute and reload. |
| "An agent run or feedback classification is active" | Another run holds the lease; wait for it to finish (up to a few minutes). |
| "Try again later" on Run agent or Simulate | An hourly or daily limit was reached (agent 10/hour, 30/day site-wide). Use the manual **Simulate strategies** path instead; it needs no AI. |
| Gemini quota or provider error | Use **Simulate strategies** for the comparison and narrate the agent from a recorded run. |
| "Offer status unavailable" or pilots show "—" | The status poll is rate limited (60/hour site-wide); wait a minute before refreshing again. |
| A or B not at $24 before the demo | **Administrator demo reset** → preview → confirm, then refresh. |
| A proposal is stuck "executing" | See the "Annual offers: unresolved targets and links" section of `docs/runbooks/render-turso.md`; don't retry blindly. |

## Automated capture

`npm run demo:capture` ([scripts/demo-capture.ts](../../scripts/demo-capture.ts)) records the six scenes above in Chromium with Playwright at 1600×900. Narration to lay over it: [voiceover.md](voiceover.md).

- **Cursor.** Playwright neither moves the real pointer nor records one, so the script draws its own arrow, glides it between targets and shows a gold ripple on each click. Scrolling is eased, so viewers can follow.
- **Output.** `demo-capture/<timestamp>/` (git-ignored): `demo.webm`, `demo.mp4` (1920×1080 H.264, when ffmpeg is on `PATH`) and `marks.json` with each scene's start time in seconds. A take that fails part-way still saves its footage and marks.
- **Admin sign-in stays off camera.** The script reads the password from `AURRERY_ADMIN_PASSWORD` and signs in from a separate, unrecorded browser context, then records with that session. Nothing prints the password. That first context also wakes a sleeping Render service.
- **Private links stay out.** The take hides the admin-only draft messages, which contain customers' PayPal approval links, and stops if one is visible. Takes recorded before 2026-11-06 show Pilot D's link at about 2:02 and must not be published.
- **Safe by default.** Without `--execute` the take ticks the approval box and points at **Approve & execute**, but does not click it. Nothing changes in PayPal.

Rehearsal (no PayPal change; the agent runs, about 7 Gemini requests):

```bash
npm run demo:capture
```

The real take (bash; type the password at the prompt so it stays out of your shell history):

```bash
read -rs AURRERY_ADMIN_PASSWORD && export AURRERY_ADMIN_PASSWORD && npm run demo:capture -- --execute --reset-after
```

`--execute` approves the save offer for Pilots A and B on camera. `--reset-after` then runs **Administrator demo reset** off camera to put them back at $24; afterwards, check the pilot table with **Refresh from PayPal**.

Other options:
- `--scenes 4,5` re-records particular scenes.
- `--manual` uses **Simulate strategies** instead of the agent in scene 2 (no AI quota).
- `--pace 1.2` lengthens every pause to fit the narration.
- `--headed` shows the window, for recording with OBS instead; move the real mouse off the window.
- `--url http://localhost:3001` rehearses against the dev server. Note that headings there fall back to Times, because the dev server cannot fetch Google Fonts.

The agent wait in scene 2 (about 15–30 s hosted) is real time; trim it in the edit. Scene 5 shows the Annual offers panel only when the ledger has offers, as the hosted one does.

## Repeating the annual offer

Options, in order of effort:
1. **Wait for Pilot D's window** to close and be confirmed declined (after 2026-11-08 16:05 UTC and one status refresh). D then becomes eligible again, and a new annual offer can target D alone. The sandbox buyer then approves D's link on camera.
2. **Add another pilot** (as was done for Pilot E: `paypal-setup.ts setup` against the hosted ledger after a private backup, plus one buyer approval). This needs a code change to the pilot cohort and a deploy.

Never rehearse `revise` against the real pilots from a local ledger: each call mints a new approval link and invalidates the previous one, and a switched customer is never moved back.
