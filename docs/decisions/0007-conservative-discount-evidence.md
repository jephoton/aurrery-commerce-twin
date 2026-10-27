# 0007: Qualify measured discount evidence conservatively

<!-- Generated handoff: M5 measured outcome policy. -->

Status: accepted for M5 implementation; independent review pending.

Record an episode only alongside a successful price-verified execution and its read-back, snapshotting the registered pilot's assessed segment and reason at that time. Never reconstruct historical reasons. One subscriber-month is 30 elapsed days; the approved duration, current time and the next verified episode bound each interval. Matched-price ACTIVE read-backs extend exposure; an override alone contributes zero. Repeated readings and delivery order cannot create additional elapsed time.

Unknown price/status, payment failure, suspension, expiration and verified price restoration stop exposure at the last qualified endpoint, without counting time to an unknown endpoint. Payment completion is a non-state fact and does not extend exposure. At simultaneous conflicting observations, cancellation wins, then uncertain/nonmatching state, then matching ACTIVE state. Subsequent matched reads cannot bridge a stopped interval.

Current PayPal cancellation observations prove neither discounted recurring price nor voluntary intent/initiator. Report at most one factual cancellation per open episode, but exclude its entire episode (including prior survival) from calibration. A cancellation following an uncertain boundary still censors the preceding survival. A verified different-price restore, expiration, subsequent episode or approved end closes attribution; later cancellations cannot censor that closed interval. No qualified voluntary cancellation channel is manufactured, so current posterior cancellation counts remain zero.

Rebuild the posterior once per request from the canonical synthetic twin and the complete qualified aggregate using the existing Gamma–Poisson update. Classifier evidence changes reason estimates while preserving measured effects. Keep factual months/cancellations, posterior-eligible months, censored episodes, parameter changes and limitations separately visible. Carry those aggregates and provenance with each manual comparison and in the initial agent stream event; a page-load snapshot cannot explain a later run. Classifier revisions update that same run snapshot, and stopped generations cannot overwrite newer snapshots. This remains observational evidence under an assumed counterfactual with selection/censoring limitations; it supports no causal retention claim.
