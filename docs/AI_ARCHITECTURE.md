# NEWAY TMS — AI Architecture

The AI layer is the intelligence layer of the platform: it watches company data, detects problems, predicts outcomes, recommends actions, answers questions, and, within an approval system, executes actions. It is built **after** the core modules produce reliable data (Phase 14) but its data model and hooks are designed now so nothing has to be retrofitted.

Related: [ARCHITECTURE.md](../ARCHITECTURE.md) · [RBAC.md](RBAC.md) · [DATABASE.md](DATABASE.md) §3.16 · [INTEGRATIONS.md](INTEGRATIONS.md)

---

## 1. Layers

```
COMPANY DATA (modules, read models, events)
        │
        ▼
DETECT   deterministic detectors (rules + statistics) → ai_insights
        │
        ▼
PREDICT  models over history (ETA risk, MPG trend, safety trend) → insight.confidence, evidence
        │
        ▼
REASON   Claude with typed, permission-scoped tools → explanations, correlations, recommendations, answers
        │
        ▼
RECOMMEND  ai_recommendations (what to do, why, evidence)
        │
        ▼
ACT      ai_actions through the shared action registry
        │
        ▼
APPROVE  approvals (policy: suggest | require_approval | auto_execute)
        │
        ▼
EXECUTE  service methods under the automation principal → audit (actor_type = ai)
```

Two rules hold everything together:

1. **The model never touches the database directly.** It reads through tools that are ordinary service calls scoped by the asking user's tenant and permissions, and it writes only through approved actions.
2. **Numbers come from tools, reasoning comes from the model.** The model explains and correlates the data it was given; it does not invent figures.

---

## 2. Detectors and predictors

Detectors are TypeScript classes in `modules/ai/detectors/`, each with a key, a trigger (schedule or event types), a `run(ctx)` that returns insights, and tests. They are cheap, explainable, and run for every company on the worker.

| Detector | Signals | Insight example |
|---|---|---|
| `load.late_risk` | ETA vs appointment, HOS remaining, miles remaining, facility average dwell, traffic/weather adapters | "Load L-123456: 72% probability of missing appointment by ~45 min" |
| `truck.mpg_drop` | `fuel_stats_daily` 30-day trend vs 90-day baseline, idle share, engine service history, open defects | "Unit 3012 MPG down 14% over 30 days; idle up; engine service history → recommend inspection" |
| `driver.safety_trend` | `safety_events` per driver vs fleet average, 14/30-day windows | "Driver 3021: 7 speeding events in 14 days vs fleet average 2 → recommend coaching" |
| `truck.pm_due` | `pm_schedules` next due vs odometer velocity (miles/day) | "Unit 2785 PM due in ~500 mi (≈3 days)" |
| `truck.recurring_defect` | repair order lines by category per unit, 180 days | "Unit 2785: third brake repair in 6 months" |
| `fuel.anomaly` | transaction vs position at time, gallons vs tank, duplicates, off-hours | "Fuel purchase 212 mi from Unit 3091's position" |
| `ar.aging` | invoices by bill-to, 30/60/90 buckets, broker payment history | "Broker ABC: $42,000 outstanding, 2 invoices past 60 days" |
| `dispatcher.overload` | active loads and at-risk loads per dispatcher vs team norms | "Dispatcher Sarah: 18 active loads, 4 at risk" |
| `document.expiring` | qualification items and document expirations at each lead rung | "CDL for Driver X expires in 17 days" |
| `load.unprofitable` | `load_profitability` below threshold or negative | "Load L-1201 profit per mile −$0.32" |
| `company.profit_change` | period-over-period revenue/cost by category | "Net profit down 11% vs last month: fuel +8%, maintenance +22%" |

Predictors (Phase 14, second half) add statistical models trained per company on history: late-arrival probability (logistic over the features above), MPG expected range per unit, safety-event rate baselines. They live behind the same insight interface and record `confidence`.

Every insight has a `dedupe_key` (e.g. `truck.mpg_drop:3012:2026-09`) so re-runs update rather than duplicate, and `evidence` (the numbers and record ids used) so a human can verify it.

---

## 3. Reasoning and the assistant

### 3.1 Model and SDK

- Anthropic TypeScript SDK. Default model `claude-opus-5` with adaptive thinking for the assistant, explanations, correlations, and customer-update drafts. `claude-haiku-4-5` for high-volume classification (document type detection, note categorization, message triage).
- Streaming responses to the UI. Prompt caching on the stable system prompt and the tool catalog. Structured outputs (JSON schema) for anything parsed by code (recommendations, classifications). Server-side refusal fallbacks enabled.
- Batch API for nightly analyses (ops brief, weekly profitability narrative) at lower cost.
- The `LLMProvider` adapter isolates the SDK; a mock provider runs the whole UI and tests without a key.

### 3.2 Tools (the only way the model sees data)

Tools are typed functions registered in `modules/ai/tools/`, each mapping to a service call with the caller's context. Results pass through the same financial/PII masking as API responses.

| Tool | Answers |
|---|---|
| `find_loads(filters)` | "loads at risk today", "loads for driver X", "unprofitable loads this month" |
| `load_detail(id)` | full load with timeline, financials, tracking summary |
| `load_profitability(period, group_by)` | by load / driver / truck / customer / broker / route / dispatcher |
| `fleet_status()` | counts by status, dispatchable, in shop |
| `trucks_needing_maintenance(window)` | PM due within window |
| `truck_health(unit)` | MPG trend, idle, defects, service history, faults |
| `available_trucks(near, equipment)` / `available_drivers(near, hos_min)` | capacity search |
| `driver_safety_summary(driver|all, period)` | events, violations, score, trend |
| `fuel_spend(period, group_by)` | totals, MPG, CPM by truck/driver/route |
| `expired_documents(scope)` | expired/expiring qualification items |
| `dispatcher_performance(period)` | loads, on-time, revenue, at-risk per dispatcher |
| `ar_aging()` / `ap_due()` | receivables/payables buckets |
| `profit_bridge(period_a, period_b)` | revenue and cost deltas by category (for "why did profit decrease") |
| `run_report(report_code, params)` | any saved report definition |
| `search(query)` | global search |
| `run_query(view, filters)` | guarded read over an allow-list of read-only SQL views with mandatory tenant binding and row limits (long-tail questions) |

The model receives tool results as data. Free text from notes, emails, or documents is passed inside clearly delimited data blocks and treated as untrusted content, never as instructions.

### 3.3 Assistant behavior

- Every answer shows which tools were called and the key numbers, and offers "open in module" links. Tables and charts are rendered by the UI from the tool results.
- Conversations are stored per user (`ai_conversations`, `ai_messages`) with tool calls for audit.
- Saved questions can be pinned to a dashboard as live tiles (they re-run the tools, not the model, on refresh).
- Natural-language global search (Phase 14): the command palette routes free-text queries to `search` and, when a question is detected, to the assistant.

---

## 4. Actions and approvals

### 4.1 Action registry

One registry serves workflows and AI: `notify_user`, `notify_role`, `create_task`, `create_alert`, `flag_load`, `update_internal_eta`, `create_maintenance_request`, `create_safety_coaching_task`, `create_compliance_task`, `draft_customer_update`, `generate_report`, `suggest_truck_for_load`, `suggest_driver_for_load`, `assign_load` (approval always), `schedule_maintenance` (approval always). Each action declares its parameters schema, the permission it needs, its risk class, and whether it may ever be auto-executed.

### 4.2 Permission levels

`ai_action_policies` per company per action type:

| Level | Behavior |
|---|---|
| `read_only` | The AI may analyze but never proposes this action |
| `suggest` | Shown as a recommendation only; a human performs the action in the module |
| `require_approval` | An `ai_actions` row is created and an `approvals` row assigned to the approver role; executed on approval |
| `auto_execute` | Executed immediately; only allowed for actions whose risk class is `low` (tasks, alerts, internal notes, internal ETA) |

Hard floor: anything that changes a load's assignment or status, touches money, sends a message outside the company, or deletes anything is `require_approval` at minimum and cannot be lowered. Executed actions run through the normal service methods under the `automation` principal and produce an audit row with `actor_type = ai` plus the approver's id.

### 4.3 Recommendation lifecycle

`insight → recommendation (action_type, params, rationale, evidence) → open | accepted | dismissed(reason) | expired`. Dismiss reasons and outcomes (did the late load actually miss its appointment?) are recorded to tune detector thresholds and to build the evaluation set.

---

## 5. Company brain: correlations

Beyond single-signal detectors, a nightly **correlation pass** (model-assisted) reviews open insights per company and looks for relationships across modules, for example MPG drop + idle increase + engine service history → mechanical issue; late ETA + low HOS + weather alert → delivery risk; repeated safety events + recent complaints → coaching. The pass only reads insights and tool results, writes `ai_insights` with `detector = 'correlation'`, and links the source insights in `evidence`.

---

## 6. Guardrails

- **Scope:** tools run as the asking user (assistant) or as the automation principal with a per-company permission ceiling (detectors, correlation pass). No cross-company data ever enters a prompt.
- **Injection:** stable, cached system prompt; untrusted text delimited as data; tool schemas strict; tool results size-capped.
- **Cost:** per-company monthly token cap from the plan, per-user rate limit, Haiku for bulk, Batch for nightly. Usage recorded per call in `ai_usage_daily`; the UI shows the meter; when the cap is hit the assistant says so.
- **Quality:** a regression eval of natural-language questions with expected tool calls and expected answers, run before each release; recommendations sampled for review; detector precision tracked from dismiss reasons.
- **Transparency:** every insight has evidence; every action has an audit row; every assistant answer lists its tool calls.
- **Refusals and errors:** handled per the SDK guidance; the user sees a clear message, never a stack trace.

---

## 7. Screens

- **AI Command Center:** company health summary, open insights by department and severity, pending approvals, recent AI actions, cost meter.
- **AI Assistant:** streaming chat, tool transparency, saved questions, pin to dashboard.
- **AI Alerts:** insights list with filters and resolve.
- **AI Recommendations:** approve / edit parameters / dismiss with reason.
- **AI Action Center:** policies per action type, approval queue, execution log.
- **AI Reports:** nightly ops brief, weekly profitability narrative, on-demand analyses.

---

## 8. Rollout

| Step | Phase | Content |
|---|---|---|
| Hooks | 3–12 | Read models, `dedupe_key` conventions, action registry (shared with workflows), `approvals` table |
| Detectors | 14a | Deterministic detectors, insights, alerts, Command Center |
| Assistant | 14b | Tools, assistant, saved questions, eval set |
| Actions | 14c | Policies, approvals, execution, Action Center |
| Predictors and correlation | 14d | Statistical models, nightly correlation pass, AI reports |
