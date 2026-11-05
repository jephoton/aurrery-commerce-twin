# Voiceover script

Narration for the submission video, matched to the scenes in [demo.md](demo.md) and to the automated capture. About 2:40 at a relaxed pace, under the 3:00 limit. `scripts/demo-narrate.py` reads this file directly: each `> ` line is spoken, `/` is a short breath, and `**` marks stress for a human reader. Keep the numbers in step with what the footage shows.

## 1. Hook

**On screen:** Ridgeline overview, the planisphere of segments.

> This is Ridgeline Roasters, a synthetic coffee subscription with about twenty-three hundred subscribers, / all modelled in a **digital twin**. Churn is creeping up, and the obvious fix is a discount. / But discounts cost money. Aurrery's rule is simple: / **simulate before you transact.**

## 2. The agent reads the signals

**On screen:** Run agent; the live activity log streams.

> The agent gets one objective: keep at-risk subscribers without giving away margin. / It starts with the evidence: cancel surveys and support messages, which Gemini classifies by intent and reason. / It finds a group who want to leave **because of price**. / Then it simulates hundreds of possible futures for each idea.

## 3. The twin corrects the obvious move

**On screen:** the proposal headline, the value and risk tiles, the stress line.

> The obvious move is a broad discount for everyone at risk. / The twin says **no**: in about three of every four futures, that does worse than doing nothing. / So the agent proposes something narrower: twenty-five percent off for three months, only for subscribers cancelling over price. / And it's honest about the odds: a small likely gain, a real chance of doing worse, and under stress, **the gain disappears**.

## 4. Trade-offs

**On screen:** the scenario grid, the fan chart, "What this rests on".

> Every option sits in one grid: likely value, an eighty-percent range, and the chance it does **worse than doing nothing**. / Annual prepay stands out as the bigger lever, though customers have to opt in. / Pick a row, and the chart shows how the subscriber base could move. / And the evidence panel shows what's estimated, what's **observed in PayPal**, and what's just an assumption.

## 5. Approval and PayPal

**On screen:** the approval card, Approve & execute, the execution report, Annual offers, the evidence record.

> Nothing touches PayPal until the **merchant approves**. / The approval card shows the exact action: twenty-four dollars down to eighteen for three months, on two pilot subscribers, sealed with a hash of the payload. / On approval, Aurrery changes both subscriptions in the PayPal Sandbox, then **reads the prices back** to verify them. / The annual plan works differently: each customer has to accept it in PayPal. / Pilot E did, and the twin **learned from it**: annual uptake moved from twelve to about fifteen percent.

## 6. Generality and close

**On screen:** Use your own data → Hollowbrook → Simulate strategies → Back to Ridgeline.

> And it isn't built only for coffee. Here's a different business, a dog-treat box, loaded from a CSV. / Same engine, **different answer**: here the at-risk discount wins, and imported merchants stay simulate-only. / Aurrery: an agent that thinks in futures, and a merchant who stays in control. / **Simulate before you transact.**

## Recording tips

- A quiet, soft room (a wardrobe of clothes works); a phone or headset mic 15–20 cm away, slightly off to the side.
- Record each scene two or three times and keep the best take. Leave a second of silence at each end for trimming.
- Speak a touch slower than feels natural; the screen needs time to change.
- If you'd rather not use your own voice, the same text works with a text-to-speech service. Check the hackathon rules on AI-generated media first.

## Making the video

Record with `npm run demo:capture` ([options](demo.md#automated-capture)), then generate the voice and fit the footage to it:

```bash
uv run scripts/demo-narrate.py demo-capture/<timestamp>
```

This writes `narrated.mp4` to the take's folder, plus `voice-<scene>.wav` clips for use in an editor. It uses Kokoro, a free model that runs locally; pass `--voice` to change the voice (for example `am_michael` or `bf_emma`) and `--speed` to change the pace.
