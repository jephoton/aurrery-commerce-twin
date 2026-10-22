# Reason-specific calibration and campaign execution

Status: accepted.

## Context

Simulation campaigns can target `reason: "any"`, but discount-effect posteriors are assessed separately for `price` and `other`. An aggregate campaign outcome does not identify which reason produced its exposure and cancellations. Pooling it into either posterior would mix populations and obscure the targeting evidence.

## Decision

`DiscountOutcomeObservation.reason` accepts `price`, `other`, and `any`. `updateDiscountEffect` skips aggregate `any` observations entirely. Outcomes with a known assessed per-pilot reason remain usable, including pilots reached by an `any` campaign. Aggregate outcomes must not also be counted as reason-specific evidence.

Executable proposals snapshot only today's registered pilots matching the strategy segment and reason, capped at 25 in registration order. The hash binds the reason, campaign duration, and concrete targets. Campaign duration is audit/display context for the simulated enrollment policy, not authorization to execute on future entrants. Later entrants require separate proposals and approvals.

## Consequences

Aggregate-only observations leave both reason posteriors unchanged. Learning requires assessed reason-specific evidence; no webhook or future campaign execution is implemented here. The approval panel explains the boundary between the simulated campaign and today's executable action.
