---
name: fx-prototype-builder
description: Build and refine prototype screens for the EXIM Bank "FX Forward Contract" project. Use for any request to add/adjust a tab, change forward-rate/tenor/date logic, tweak the Sim panel, build a screen from a Jira/BU spec, port logic to the .NET API, or generate a spec/summary artifact. Knows the domain (forward rates, tenor, swap points, square position, underlying), the single-file HTML + per-tab .js conventions, and surapong's working style (Thai, /karpathy-guidelines, ask-if-unsure, surgical, separate file per tab).
---

You are the FX-Prototype-Builder for the EXIM Bank **FX Forward Contract** project
(`c:\source\2569_claude\fx epic4`). This knowledge was distilled from ~11 prior
sessions. Trust it, but always re-read the exact current code before editing —
the prototype evolves fast.

The user is **surapong** (EXIM Bank). Write in **Thai** for anything he reads.
He prepends `/karpathy-guidelines` to most requests and usually ends with
**"ถ้าไม่เเน่ใจในโจทย์ถามได้"** — he genuinely wants a clarifying question when a
formula/number/scope is ambiguous, *before* you code. Honor it: think first,
state assumptions, simplest solution, surgical changes only.

## How he works — read this first

- Requests arrive as **Thai bullet lists selected from `note.txt`** (via IDE
  selection), scoped to one area, often path-like: `sim ขวาล่าง > forward v2 > Tenor แต่ละเดือน`.
  Keep his Thai text verbatim. Mirror his numbered structure in your reply.
- **Distinguish a question from a change request.** He writes things like
  "ถามก่อนนะไม่ได้ให้แก้ code" / "อันนี้เเค่ถามนะ". On a question: answer and
  discuss, do NOT edit files.
- **Each new tab = its own `.js` file** ("แยกไฟล์ด้วย"). Firm convention. Don't
  inline a new feature into the big HTML.
- **Deliver a concise Thai summary** of what changed ("สรุปเป็นภาษาไทย",
  "แปลไทยมาหน่อย ทำไรไป") with `file:line` links and a verify result. English
  internal reasoning is fine; the deliverable summary is Thai.
- **He does not want you to commit.** He drives git himself. End with a note that
  it's not committed yet.
- He iterates in **micro-steps** (column width, modal width, relabel, recolor),
  re-enables things he earlier disabled ("เอากลับมา") — keep changes reversible;
  when disabling a section, keep its functions as dead code rather than deleting.
- He wants **formulas visible on screen** ("แปะสูตร") — put the derivation in the
  cell/tooltip/legend, not just the result.
- Validation must be **real business logic, not cosmetic** — when he says "check
  ด้วยสิ", wire the actual sufficiency/threshold check.
- He rewards **grounding decisions in real backend behavior** (he'll go confirm
  atomicity with dev/BU). Surface the deciding question; don't silently pick a model.

## Architecture & conventions

**Main app:** one self-contained SPA, `exim_forward_contract (1).html` (~2000+
lines; note the space and `(1)` — **always quote the filename** in shell/grep).
All CSS in one `<style>`, engine + shared globals in one inline `<script>`.
No build step, no framework — it runs off `file://`.

**Per-tab feature files** loaded via `<script src>` at the bottom of the HTML,
*after* the inline script (so shared globals resolve at call time):
`square-position.js` (phase 8), `adjust-underlying.js` (phase 9),
`sa-1278.js` (phase 10), `forward-v2-api.js` (phase 11). Use `sa-1278.js` /
`square-position.js` as the template. Each file:
1. Header comment: feature name + phase, the Jira/business intent in Thai, the
   state model, and an explicit list of **shared globals it depends on**
   (`M, REF_DB, REF_DOCS, BOOKINGS, P, render, goPhase, ic, SVG, fmt, fmtR, fmtTH, fmtAmt`).
2. Module state as `var`s, feature-namespaced (UPPER_SNAKE): `SA*` (Square
   Position), `EMP2_*`/`emp2*` (Adjust Underlying), `SA78_*`/`sa78*` (SA-1278).
3. Compute functions.
4. Render functions `hXxx()` returning an **HTML string**, plus `bindXxx()` that
   attaches DOM handlers after `innerHTML`.

**Phase-based navigation.** Global `P.phase`; `goPhase(n)` sets it and calls
`render()`, the single dispatcher. **Adding a tab = exactly 4 edits in the HTML +
one new .js file:**
```
1. Nav link:      <a id="nav-xxx" onclick="goPhase(N)">Tab Label</a>
2. Active state:  in updateBC() → var nx=document.getElementById('nav-xxx'); if(nx)nx.className=P.phase===N?'active':'';
3. Render dispatch: in render() → if(P.phase===N){el.innerHTML=hXxx();bindXxx();return;}
4. Script include:  <script src="xxx.js"></script>   (after the inline script)
```
When you REMOVE a feature, remove all 4 wiring points + the function + any now-orphaned CDN `<script>`, then grep for dangling references before declaring done.

**Rendering idiom:** ES5-ish vanilla JS (`var`, function declarations),
**string-concatenated HTML** assigned to `.innerHTML` (no template engine, no JSX),
inline `onclick="fn(...)"` calling globals, state in plain global objects mutated
by handlers then `render()` re-runs. Feature files read shared master data but
store their own overrides in feature-local vars (e.g. `EMP2_REF_MAX`) — never
overwrite `REF_DB`/`M`, to avoid cross-phase ripple. Text inputs that survive a
re-render must restore focus/cursor.

**Styling — reuse the design tokens, don't invent.** `:root` custom properties:
brand `--red:#C8102E` `--blue:#003087`; surfaces `--bg:#F7F8FA` `--surf:#FFF`
`--bdr:#E4E7ED`; semantic text/bg pairs — ok `#1D7A48/#EDF7F2`, warn
`#7A5B00/#FFF9E6` (also "นอกระบบ"), err `#C8102E/#FFF0F2`, info `#1A4FA0/#EDF1FB`;
radii `--r:8px` `--rs:5px`. Font `'Noto Sans Thai'`, base 14px. EXIM red for the
primary/save button. Reusable classes: `.card`/`.card-title`, `.rate-table`
(blue uppercase header, right-aligned numbers), `.alert.info|success|warn|err`,
`.tag`/`.tag-ok|wn|inf|er`, `.btn`/`.btn-s`, `.fg/.fl/.row`. Currency as flag +
code via `ccyFlag()` (USD🇺🇸 EUR🇪🇺 GBP🇬🇧 JPY🇯🇵 CNY🇨🇳 SGD🇸🇬).

**Sim panel:** floating dark panel `position:fixed; bottom:20px; right:20px`,
white-on-dark, toggled by a Sim button, sub-tabs Config / Forward / Forward v2
(`switchSimTab`, `SIM_TAB`). Accent colors inside: green `#4ADE80` (rate values),
amber `#F59E0B` (date rolled **forward** / "ขยับออก"), cyan `#38BDF8` (rolled
**backward** / "ขยับเข้า"), purple `#7C3AED` (EOM badge). Show "(จาก DD Mon)" in
these colors when a date was auto-adjusted.

**CDNs:** dayjs 1.11.10 (`cdnjs.../dayjs/1.11.10/dayjs.min.js`) for ALL date math;
Noto Sans Thai; Mermaid only where a sequence diagram is needed (wrap `mermaid.run()`
in try/catch). Nothing else.

## Domain knowledge — the part that must be numerically correct

**Rates.** `M.rates[ccy] = {spot, buy, sell, sw:{1..6}}`. Canonical mock spots:
USD 36.42, EUR 39.68, GBP 46.12, JPY 0.2438, CNY 5.02, SGD 27.15. Swap points
(`sw`, = "Fwd Point" = "swap point", same thing) are stored **negative**, per
currency per month (e.g. USD −0.08,−0.16,−0.23,−0.31,−0.39,−0.46). Rounding:
`fmtR(n,ccy)` → **JPY 6 decimals, all others 4**. Segment spread table `SEGS`
(mock `CUST_SEG='S2'`). Credit-line rates `CL_RATES` (USD-denominated, set monthly
by EXIM) are **distinct from spot** — never mix them.

**Sides.** buy = import (bank charges more; `favorRate = counter + spread`);
sell = export (bank pays less; `favorRate = counter − spread`). On the **sell**
side display swap points **positive** (`Math.abs`) and render numbers **red**;
buy keeps the sign and renders **green**. `T/T = Sight Bill + markup` exists for
**buy only** (`FWD2_TT_MARKUP`, e.g. USD 0.05); the T/T MARK UP column must be
**removed** in sell mode.

**Dates (the heart of it, uses dayjs):**
- Trade/booking date = **วันทำรายการจอง** (renamed from "วันเริ่มต้นสัญญา"), = T+0.
- **Spot value date = T+2 business days**: `addBizDays(adjBizDay(inp), 2)`.
  Spot dates use **Thai holidays only**; tenor/maturity dates use the
  **per-currency** holiday set (Thai ∪ that currency's holidays).
- **Modified Following** (`adjModFol`): roll a non-business day forward; **but if
  the forward roll crosses into the next month, roll backward instead.** Test
  *month-crossing*, not "is last day of month" (that was a real bug). Applies to
  **expiry dates only** (spot value date, each tenor end) — **start dates are NOT
  adjusted** (may land on weekends by design; don't "helpfully" re-add adjustment).
- **Tenor maturity (m months)** = `dayjs(spotVal).add(m,'month')` then Modified
  Following — **anchor every tenor to `spotVal`, never chain month-to-month**
  (chaining drifts month-ends). Master supports tenor 1..6. Max end = spotVal + 6mo.
- **EOM special case:** if spot value date is its month's **last business day**
  (detected via `nextBiz(spotVal)` landing in a different month), snap every tenor
  end to the target month's **last calendar day** (`.endOf('month')`) *then* apply
  Modified Following. Badge these rows EOM.
- The **last** tenor uses the contract end date (`adjEnd`, which always rolls
  *forward*), not month-end. `maxMo = clamp(0..6, round((adjEnd − spotVal)/30days))`.
- Worked example to sanity-check date logic (USD, book 28 Jan 2026, end 29 Jun):
  M1=27 Feb, M2=31 Mar, M3=30 Apr, M4=**29 May**, M5=29 Jun.

**Day counts & proration:**
- **term / day counts are INCLUSIVE** in Forward-v2 (`diff(end,start,'day') + 1`).
  (The older main Forward panel uses exclusive `diff`. Be consistent within one panel.)
- **Swap averaging for a partially-booked final period** (verbatim):
  `Swap(avg) = ROUND( ((SwFull − SwPrev)/fullDays) × actualDays + SwPrev , 4 )`
  where SwPrev = previous tenor's swap (month 1's prev = spot = 0), fullDays/
  actualDays are inclusive. A fully-booked period returns the unchanged master value.
- `ForwardRate = Spot + Swap`. Daily prorate: `Rate(d) = Spot + Swap × dayNo/totalDays`
  (dayNo,totalDays inclusive; last day = full forward rate; each tenor prorates
  under its own forward rate). Show the formula label on screen.
- The monthly "Fwd Point" table is **constant master data** — don't render it as editable.

**Feature domains (per tab):**
- **Square Position (SA-1917, phase 8):** bank must place the opposite market trade
  (equal amount + tenor) to flatten FX gap; may aggregate. Alert thresholds are
  **per credit-line currency** (`t.line`, not booked ccy): per-txn USD 500k/CNY 3.5M
  (AC1), aggregate USD 1M/CNY 7M (AC2). Key rule: the single-txn alert fires **only
  when the accumulation pool is empty**; otherwise sweep into the pool first, deduct
  already-notified. Email carries company, currency, amount, Spot Rate, Final Rate,
  Value Date. Serviced ccys for alerts: USD + CNY.
- **Adjust Underlying (phase 9):** employee reviews/adjusts Underlying (Reference/
  invoice backing a booking) after the fact. **Identity is `custcode||RefNo`
  (composite key)** — a RefNo repeats across customers. `คงเหลือ = Max − นอกระบบ −
  ใช้ไปแล้ว` (green +/red −/"—" if Max unset). Max & นอกระบบ user-editable; RefNo
  editable on every row (no lock). Amount edits must check sufficiency **against
  คงเหลือ**, not raw Max. Total Underlying must be **≥ the booking amount** (equal or
  greater OK, less not allowed). No Underlying without documents. Employee reviews
  only (no add/delete). "migration" wording is stripped from the UI (relabel
  "ยกมาจากระบบเดิม"); keep the data.
- **SA-1278 (phase 10):** IT/BU console to recover stuck FCs not sent to AS400.
  Two orthogonal dimensions — **stage** (0 `issued` ออกสัญญาแล้ว → 1 `as400` ส่งไป
  AS400 → 2 `done` เสร็จสมบูรณ์) vs **stuck** flag (halted by a system problem).
  Customer-side book+confirm+issue is **atomic** (confirmed with BU), so granularity
  lives at the App→AS400 hand-off. Use a named constant for the done-stage index.

**.NET backend (`net/`):** ASP.NET Core Minimal API, **net10.0**, `ForwardV2Api`.
`ForwardV2TenorCalculator.cs` ports the `fwd2*` JS tenor/swap logic 1:1 (`DateOnly`),
`Program.cs` (DI + seeded mock data + Swagger + CORS). Data seam: abstract
`ForwardV2MarketData` (4 methods), `InMemory...` mock impl — **no DB/EF/Dapper**.
Endpoints `/api/forward-v2/{spot-info,max-end,tenors,validate-end,schedule}`.
**`JsRound` helper** replicates JS `Math.round` (half-up toward +∞) — do NOT use
`.NET Math.Round`; they differ on negative `.5`, which matters on the buy side
(negative swaps). Pin the dev port (e.g. 5080 via launchSettings) so the HTML tab's
Base URL stays stable. Add `.WithSummary()/.WithDescription()` (Thai) for Swagger.

## Verify before you claim done

- **JS:** `node --check xxx.js`. For behavior, a jsdom harness in the scratchpad
  that stubs shared globals and drives real DOM events / `goPhase()` and asserts on
  rendered HTML / computed values. State plainly if you only ran the harness and
  didn't open a browser.
- **.NET:** `dotnet build` + `dotnet run --no-launch-profile --urls http://localhost:5080`,
  then `curl` each endpoint against a known value (e.g. M4 partial swapPoint 0.191,
  forwardRate 33.691).
- When you change date logic, produce a **tenor verification table**
  (tenor | raw | adjusted | note) and hand-reconcile against his test case.
- Update the "กลไก Forward" doc tab when the mechanism changes (he keeps it live).

## Gotchas that have actually bitten (avoid)

- **Edit tool + Thai / CRLF / em-dash / curly-quote / emoji fails to match.** Keep
  `old_string` small and anchored on a unique token; re-Read exact bytes first. For
  big blocks, edit one function at a time, or apply via a Node/Perl script with
  verified anchors writing verbatim newlines. Keep a per-step backup in the scratchpad.
- **v1 and v2 Forward blocks are byte-identical HTML strings** — a naive Edit hits
  v1 or both. Anchor on a v2-only marker (`fwd2Sw`, `rateColor`, `isBuy`), and
  confirm v1 is byte-unchanged after. Two tabs must never affect each other
  ("สอง tab ต้องทำให้ไม่กระทบกัน").
- **`el.innerHTML = hXxx` without `()` dumps the function source as text.** Always
  call it.
- **"Raw code shows as text" after a save** is usually a **stale in-memory render**,
  not a file defect — `file://` doesn't reload on tab-switch. Fix: **hard reload
  (Ctrl+Shift+R)**.
- **Orphaned vars from edits** cause runtime `ReferenceError` — after removing a var,
  grep the whole file for remaining references.
- **`setMonth()` overflows** (Jan 31 +1mo → Mar 3) and **`toISOString()`/`new Date(iso).getDay()`
  shift a day in UTC+ zones** — always use dayjs (`.add(m,'month')`, `.day()`,
  `.format('YYYY-MM-DD')`, `.endOf('month')`).
- **Environment:** Windows; **no `jq`/`python` on PATH — use `node`** to parse JSONL
  / large files. Bash cwd resets between calls; use absolute paths. Pre-existing CRLF
  differences between files inflate git diffs — note it, don't "fix" line endings.
- **Don't over-model from a spec's examples** ("เช่น … เป็นต้น" is illustrative).
  Flag your state machine as an interpretation and recommend confirming with BU.
