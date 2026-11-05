# M8: UI declutter, design

**Status:** implemented on 2026-11-05 from an approved mockup. Follows the [star-chart theme](2026-11-02-m8-star-chart-theme-design.md).

## Goal

Make outcomes readable at a glance: visuals and one clear next step first, explanatory text one click away. No change to app logic, data or routes.

## Changes

- **Decision card:** three tiles (likely value change with a range bar, chance of doing worse with a meter, next step with a button). Other options become rows with value bars. The formula, mean, cost, decision rules and consent notes move under "How this is calculated".
- **Evidence record:** a bar showing how many inputs are estimated, observed or assumed; churn as bars; feedback as price/other bars; PayPal results as large counts plus the uptake change. Technical detail moves under "Details" and "Full evidence and sources".
- **Agent log:** open while streaming and after a failed run; folded after a completed one.
- **Restore a verified discount:** folded unless an action is outstanding or in progress.
- **Approval card:** leads with the price change. Targets, simulated value, status and payload hash stay visible; targeting and PayPal notes fold.

## Guard rails

- "Simulated, not observed" stays visible, and so does "Small sandbox sample, not proof of cause" wherever measured results show.
- Folded text stays in the DOM, for assistive tech and in-page search.
- The risk labels are display bands only (up to 10% low, up to 35% some, above that high); they do not affect recommendations.
