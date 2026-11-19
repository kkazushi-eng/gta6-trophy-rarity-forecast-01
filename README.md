# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/kkazushi-eng/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/kkazushi-eng/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts each Grand Theft Auto VI PlayStation 5 trophy's Exophase earn rate one week after launch, as five quantiles per trophy. The program reads one case file (the house's Exophase reads before the case checkpoint) and writes `/output/<id>.out` with the forecast quantiles.

## Run it

```sh
node main.ts /input/<id>.in
```

(Or `MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts` for a local run.)

## Model

A trophy's earn rate is a ratio — earners over players tracked — and the two sides
move for different reasons, so `main.ts` forecasts them separately and divides:

- **Snapshots.** Consecutive reads with identical players/rates are one Exophase
  snapshot; only snapshots carry information.
- **Players tracked N(t).** Least-squares line of ln N against ln(1 + hours since
  release), read at the target, damped (growth decelerates) and capped at 4x the
  last value.
- **Earners E_i(t).** Per trophy, a least-squares line of ln(E_i + 0.5) against the
  same log-time, shrunk toward the pooled slope across trophies and the trophy's
  tier median (single-trophy counts are small and noisy), slopes floored at 0.
  Median rate = 100 · E_i(target) / N(target).
- **Flat history.** When the whole history is one unchanged snapshot (the practice
  cases), no trend can be fitted, so a launch-day refresh prior applies: the next
  refresh multiplies players tracked by ~5–6x (the practice refresh went
  638 → 3,868) while earner counts grow only slightly, fastest for trophies that
  already had many earners. A trophy held by 100% of tracked players stays at 100%.
- **Spread.** Quantiles are normal on the logit scale around the median, with
  sigma from a 0.30 floor, a horizon random-walk term, and the trend fit's
  prediction error — wide enough to be honest about a refresh the history has
  not seen yet (the baseline's narrow band covered none of the refreshed rates).

## Practice results (local scoring)

The practice answers were recovered from the live Exophase page (still showing the
04:30Z refresh snapshot: 3,868 players tracked, 4,276 trophies earned — every rate
reproduces exactly at N = 3,868, and the 05:00Z read is unchanged per the rules),
scored with the pinball loss exactly as specified in RULES.txt:

| case | loss | typical miss | 90% coverage |
|------|------|--------------|--------------|
| p00  | 0.101 | 0.03 pp | 0.95 |
| p01  | 0.099 | 0.03 pp | 0.95 |
| mean | **0.100** | 0.03 pp | 0.95 |

House persistence baseline on the same answers: loss 1.51, typical miss 0.68 pp,
coverage 0. Runs offline, deterministic (byte-identical outputs on repeat runs),
~0.4 s for both practice cases (cap is 8 s per case).

---

<sub>Entered on [make.fun](https://make.fun/?ref=witty-gecko-66&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)</sub>
