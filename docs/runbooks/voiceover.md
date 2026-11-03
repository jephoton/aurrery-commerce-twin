# Voiceover script

Narration for the submission video, matched to the scenes in [demo.md](demo.md) and to the automated capture (`npm run demo:capture`, see "Recording" below). About 400 words: roughly 2:40 at a relaxed 150 words a minute, under the 3:00 limit.

Each scene is a separate take. Record them one at a time, then lay each clip over its scene in the footage (the capture writes the scene start times to `marks.json`). Words in **bold** carry the stress; `/` is a short breath.

## 1. Hook (0:00–0:18, about 45 words)

**On screen:** Ridgeline overview, the planisphere of segments.

> This is Ridgeline Roasters, a coffee subscription with about twenty-three hundred subscribers, / all of them modelled in a **digital twin**. Churn is creeping up, and the obvious fix is a discount. / But discounts cost money. Aurrery's rule is simple: / **simulate before you transact.**

## 2. The agent reads the signals (0:18–0:42, about 55 words)

**On screen:** Run agent; the live activity log streams. The wait is trimmed in the edit.

> I give the agent one objective: cut at-risk churn without wasting margin. / It starts with the evidence: cancel surveys and support messages, which Gemini classifies by intent and reason. / It finds a group who want to leave **because of price**. / Then it simulates hundreds of possible futures for every idea.

## 3. First instinct, then correction (0:42–1:22, about 95 words)

**On screen:** the headline, "Also executable within your rules", "Bigger simulated levers".

> Its first instinct is the obvious one: a broad discount for everyone at risk. / The twin says **no**: in most futures that loses money, because you end up paying people who were staying anyway. / So the agent changes course. / Tactically, a targeted save: twenty-five percent off for three months, only for subscribers cancelling over price. / Strategically, the bigger lever is **annual prepay** at fifteen percent off, and that's what it recommends. / A price rise looks even bigger on paper, but it rests on an **assumption** about how customers respond, so the agent flags it instead of recommending it.

## 4. Trade-offs (1:22–1:46, about 60 words)

**On screen:** the scenario grid, a row selected, the fan chart, "What this rests on".

> Every option sits in one grid: the median value, an eighty-percent range, the chance it does **worse than doing nothing**, and the discount it gives away. / Pick a row and the fan chart shows how the subscriber base could move. / And the evidence panel is honest about what's estimated, what's **observed in PayPal**, and what's just an assumption.

## 5. Approval and PayPal (1:46–2:22, about 85 words)

**On screen:** the approval card, Approve & execute, the execution report, Annual offers, the pilot table.

> Nothing touches PayPal until the **merchant approves**. / The approval card shows the exact action: twenty-four dollars down to eighteen for three months, on two pilot subscribers, sealed with a hash of the payload. / I approve, / and Aurrery changes both subscriptions in the PayPal Sandbox, then **reads the prices back** to verify them. / The annual plan works differently: each customer has to accept it in PayPal. / Pilot E did, and the twin **learned from it**: annual uptake moved from twelve to about fifteen percent.

## 6. Generality and close (2:22–2:45, about 60 words)

**On screen:** Use your own data → Hollowbrook → Simulate strategies → Back to Ridgeline.

> And it isn't built only for coffee. Here's a different business, a dog-treat box, loaded from a CSV. / Same engine, **different answer**: here a targeted discount wins, and imported merchants stay simulate-only. / Aurrery: an agent that thinks in futures, and a merchant who stays in control. / **Simulate before you transact.**

## If you run long

Cut in this order, about 5 seconds each:
1. Scene 4: "and the discount it gives away".
2. Scene 3: "because you end up paying people who were staying anyway".
3. Scene 6: "and imported merchants stay simulate-only".

## Recording tips

- A quiet, soft room (a wardrobe of clothes works); a phone or headset mic 15–20 cm away, slightly off to the side.
- Record each scene two or three times and keep the best take. Leave a second of silence at each end for trimming.
- Speak a touch slower than feels natural; the screen needs time to change.
- If you'd rather not use your own voice, the same text works with a text-to-speech service. Check the hackathon rules on AI-generated media first.

## Recording the footage

`npm run demo:capture` drives the hosted site through these scenes in Chromium with a visible cursor and click ripples, and saves `demo-capture/<timestamp>/demo.webm` (plus `demo.mp4` when ffmpeg is on `PATH`) and `marks.json` with each scene's start time. Options, the safety switches and the reset step are in [demo.md](demo.md#automated-capture).
