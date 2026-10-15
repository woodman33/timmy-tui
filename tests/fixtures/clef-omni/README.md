# Clef-Omni fixtures: FAKE

Every file here is FAKE: handwritten for Timmy's offline decision tests (tests/decision-*.test.ts). None was recorded from
Cloudflare Workers AI, a SystemOne deployment or any other service, and no model was asked to make them. The numbers in
them are not scores of anything.

They follow the published answer shape of `@cf/cloudflare/clef-omni` (its model page's schema-output.json), as Timmy's
request asks it: a `route` choice question over the offered options plus `needs_review` (the abstain option, "A person
should decide"), and a `human_review` noul question ("should a person review this before anything runs?").

| file | what it is for |
|---|---|
| response-route-ok.json | a clear leader: codex 71%, ahead by 54% |
| envelope-route-ok.json | the same answer inside Cloudflare's REST envelope `{success, result, errors, messages}` |
| envelope-error.json | the envelope with `success: false` |
| response-route-tie.json | codex and pi tied at 45% (abstain: a person decides) |
| response-route-low.json | the highest option at 38%, under the 60% threshold (abstain) |
| response-route-needs-review.json | `needs_review` ranked first (abstain) |
| malformed-*.json | one schema problem each: not the highest probability, a missing answer, missing probabilities, a negative probability, probabilities that do not sum to 1, an option Timmy never offered, the wrong answer type |

`fake.ts` builds more FAKE answers in tests (a batch of queued tasks, two-option routes) and a temporary git project; it
is test code, never shipped.
