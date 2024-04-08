# LLM Cost Ledger

Audit exported token usage against a dated price table you supply. It computes
input, output and cache-read charges with integer decimal arithmetic, groups
them by workflow and reports budget overruns. It is a local estimate from two
documents, **not** a verified provider bill. Nothing contacts a model, account
or pricing service, and nothing writes an output file.

## Quick start

Node 22 or newer; no installation dependencies.

```sh
node bin/llm-cost-ledger.mjs --root examples/clean --usage usage.json --prices prices.json --json
node bin/llm-cost-ledger.mjs --root examples/over-budget --usage usage.json --prices prices.json --json
node bin/llm-cost-ledger.mjs --root examples/unresolved --usage usage.json --prices prices.json --json
npm run check
```

The first exits 0, the second exits 1 (`budget-exceeded`), and the third exits
2 (`price-unresolved`). Omit `--json` for a short human summary on stderr;
stdout is always a JSON report except on invalid usage. `--help` lists every
flag. Library callers use `auditCosts({ root, usage, prices, limits, now })` and
`exitCodeFor(report)` from `src/index.mjs`; `now` is an injected millisecond
clock, defaulting to `Date.now`.

## Inputs and arithmetic

Both files are UTF-8 JSON within `--root`; relative names are required, and
symlinks resolving outside the real root are refused. Unknown fields and
duplicate IDs are not silently dropped. An unreadable or invalid document
produces an incomplete report, not a partial calculation.

`usage.json` has `schemaVersion: "1"`, `workflows`, and `usages`. A workflow
has a unique `id`, an `outcome` label and optional `budget` (dollars as a
decimal string, up to six fractional digits). A usage has a unique `id`,
`workflowId`, `model`, `date` (`YYYY-MM-DD`), and nonnegative integer
`inputTokens`, `outputTokens`, `cacheReadTokens`. All three counts are required;
missing cache evidence is not zero. `prices.json` has `schemaVersion: "1"` and
`prices`; each row has unique `model` + `effectiveDate` and decimal strings
`inputPerMillion`, `outputPerMillion`, `cacheReadPerMillion` (dollars per million
tokens, at most six fractional digits). The latest date **not after** a usage
date applies. An absent model/date rate makes that usage and its entire
workflow cost `null`, never zero. A workflow with no usage is incomplete.

Rates are scaled to millionths of a dollar. Multiplying that integer by token
counts yields exact pico-dollars; the report writes costs as strings with twelve
fractional digits, including `costPerOutcome` for each workflow's one recorded
outcome. Budget comparison uses the same integer units. These estimates do not
infer provider rounding, tax, discounts, retry traces not in the export or
actual charges. Every usage row is one recorded charge; the tool does not
invent unrecorded retries.

The report uses the house envelope (`schemaVersion`, `tool`, `status`,
`summary`, `findings`) plus sorted `usages` and `workflows`. It echoes only
validated short identifiers, dates and derived costs, never prompts, response
text, credentials or a raw parse error. `summary.checked` counts usage rows;
`summary.unresolved` counts usage rows without a price. A known budget failure
can coexist with unresolved pricing, but `incomplete` takes precedence: a
partial cost cannot certify the whole ledger.

## Rules and exits

| Rule | Severity | Meaning |
| --- | --- | --- |
| `input-unreadable` | error, incomplete | Named document cannot be read, decoded or parsed. |
| `input-outside-root` | error, incomplete | Real input path escapes the declared root. |
| `input-too-large` | error, incomplete | A document exceeded `maxDocumentBytes`. |
| `input-invalid` | error, incomplete | Shape, field, date, count or duplicate key is unusable. |
| `too-many-records` | error, incomplete | Usage, workflow or price bound exceeded. |
| `analysis-timeout` | error, incomplete | Cooperative time limit expired; no partial ledger is published. |
| `no-usage` | warning, incomplete | A workflow or entire export has no cost evidence. |
| `price-unresolved` | warning, incomplete | No supplied price applied at the usage date. |
| `budget-exceeded` | error | Fully priced workflow exceeds its supplied budget. |
| `findings-truncated` | error, incomplete | The report hit its finding bound. |

Findings sort by UTF-16 code unit on `(location.file, location.pointer,
ruleId)`. `0` means all evidence was evaluated and budgets held; `1` means a
completed review found an overrun; `2` means bad configuration (empty stdout)
or incomplete input/review (JSON report on stdout). No run over zero usages is
a pass.

## Limits and non-goals

| Flag | Default | Bound |
| --- | ---: | --- |
| `--max-document-bytes` | 1048576 | Bytes in each file. |
| `--max-usages` | 10000 | Usage rows. |
| `--max-workflows` | 2000 | Workflow rows. |
| `--max-prices` | 5000 | Dated price rows. |
| `--max-findings` | 2000 | Findings in the report. |
| `--timeout-ms` | 30000 | Cooperative elapsed milliseconds, at most 3600000. |

Each count/byte boundary accepts exactly N and refuses N+1. The time check is
injected and cooperative; a single filesystem read, sort or rate lookup can
finish before the next checkpoint. Costs stay exact within the declared
nonnegative count/rate bounds (one billion tokens per count and one million
dollars per million tokens per rate). There is no live API, tokenizer,
currency conversion, forecast, billing reconciliation or account action.

MIT. See [LICENSE](./LICENSE).
