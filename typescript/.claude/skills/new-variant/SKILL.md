---
name: new-variant
description: Prepares a Comptoir variant to evaluate (chapter 17) - a single change, its test, the free estimate. Never runs the paid series.
disable-model-invocation: true
argument-hint: "[what changes, for example: shorter prompt v6]"
---

# Preparing a variant

The requested change: $ARGUMENTS

1. A variant changes only one thing compared with the shipped version (`VARIANTS.shipped` in `ch17/suite.ts`). If the request changes two, stop and propose two variants.
2. If the change is a prompt, write the next version in `../python/comptoir/prompts/`, shared by the two versions; never modify an existing version.
3. Add the variant to `VARIANTS`, with a short lowercase name, and complete the variants test in `tests/ch17.test.ts`.
4. Run `npm test`.
5. Give Yao the estimate command, which is free: `npx tsx ch17/evaluate.ts estimate --set improvement --trials 3`, then the command for the series, **without running it**: `npx tsx ch17/evaluate.ts run --variant <name> --set improvement --trials 3 --max-budget 0.3`.
