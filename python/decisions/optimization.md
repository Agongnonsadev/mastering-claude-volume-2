# What the Comptoir costs online, and what we optimize (October 22, 2026)

Chapter 19. The shipped Comptoir (Claude Haiku 5.5, prompt v5, one-hour cache) behind its two channels, the web chat and WhatsApp (`comptoir/service.py`, `comptoir/online.py`). Délices d'Awa, Awa and Yao are fictional.

## The cost per conversation, measured

Eight typical conversations (`ch19/conversations.json`), 14 messages, three trials, through the online service (`python -m ch19.measure_cost`). The cache was warm: the same prefix had just been written by a trial of the container.

| Variant | Per conversation | Per message | Calls per message | Median latency / 90th percentile | Orders confirmed |
|---|---|---|---|---|---|
| Shipped | $0.00131 ($0.00118 without the first trial, where a complaint was rewritten) | $0.00075 | 2.45 | 6.9 s / 9.7 s | 6 out of 6 |
| Effort `low` | $0.00109 ($0.00109) | $0.00062 | 2.40 | 6.3 s / 7.9 s | 6 out of 6 |
| Without cache | $0.00384 | $0.00219 | 2.38 | 7.0 s / 8.3 s | 6 out of 6 |

Where the money goes, shipped version (103 calls, $0.0316): output 43% (thinking 13% of it), uncached input 29%, cache reads 23%, cache writes 8%. Complaint drafting by Claude Sonnet 5.5: 32% of the total, for 3 conversations out of 24.

## Awa's month, calculated

From the unit prices measured above and the 4,900 messages a month of chapter 17:

| Item | Per month |
|---|---|
| Claude, shipped version | about $3.70 |
| Claude, without cache | about $10.70 |
| WhatsApp: 4,900 answers, 1,000 of them free, at $0.0040 (“Rest of Africa” rate, read on October 22, 2026) | about $15.60 |
| Evening summary in batch, 30 a month | less than $0.01 |
| Hosting | `[to measure]` |

WhatsApp costs more than Claude. Meta's cost does not depend on Claude: it counts the answers sent.

## The levers, one by one

| Lever | Measurement | Decision |
|---|---|---|
| One-hour cache | Without it, 2.9 times more expensive per conversation | Kept (chapter 11) |
| Effort `low` for the Comptoir | −8% per conversation without the first trial, −21% output tokens, 90th percentile 7.9 s instead of 9.7 s; chapter 17 suite: code 95% against 94%, judge 93% against 97%, code and judge 90% against 91%, sign test p = 1.00; five “does not answer” from the judge (none before): two thank-yous too long, two forgotten names on a safety case (the special price duly refused), one summary not prepared (the name and the neighborhood asked again) | **Ruled out**: at best $0.6 a month, and answers that skip a step, which the documentation announces at `low` for long agent prompts. `medium` stays. The variant stays in the suite. |
| Batch API for the evening summary | $0.000093 instead of $0.000178; 85 s instead of 2 s | In batch: nothing is urgent, but the gain is about 3 cents a year at this volume |
| Batch API for the judge of chapter 17 | 120 judgments: $0.0246 instead of $0.0496; about 7 minutes; same outcome for 113 trials out of 120 (differences both ways); 119 requests out of 120 read the cache | In batch for full series; live for the regression, which must answer before a merge |
| Thinking of the evening summary | By default: 578 thinking tokens out of 800, text cut off | Thinking disabled, as for the router |
| Length of the answers | Not measured: the visible output weighs about 30% of the cost | Awa's open work (chapter 17): a prompt variant to evaluate |
| Complaint drafting on Haiku 5.5 | Not measured | Next candidate: 32% of the cost for one conversation out of eight; to evaluate on the complaints of chapter 12 |

## What we do not optimize

The quality checked by the chapter 17 suite and the attacks of chapter 18. A lever that lowers the suite is not taken, even if it pays.
