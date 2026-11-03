# Awa's Comptoir — companion code of Volume 2

Code of the examples of *Mastering Claude, Volume 2 — Developer: Building with Claude* (Botlyx Academy). The Comptoir, Awa, Yao and Délices d'Awa are fictional.

This is the book's companion repository. Its address is given on the companion page, academy.botlyx.com/en/livres/tome-2, with the book's updates.

The Comptoir was first built in French, the language of Awa's customers in Cotonou. This repository is the English translation of that code: names, comments, prompts, data and tests. The records of the runs (transcripts, judgments, registers, results of the series) keep Claude's answers in French, with their keys and IDs renamed so that the English code reads them; each `results/` folder says so in its README.

The code is published under the MIT license (`LICENSE` file): you can reuse it in your projects, even commercial ones, keeping the copyright notice. The text of the book is not concerned.

## Organization

```
python/
├── pyproject.toml      ← the “comptoir” package and its dependencies (anthropic SDK 2.x since chapter 21)
├── CLAUDE.md           ← the project's memory for Claude Code (chapter 4)
├── .claude/            ← Claude Code for the Comptoir: settings.json (permissions, chapter 4; hooks, chapter 20), hooks/ (file guard, secret guard, tool log, tests at the end of a turn), rules/ (tests, prompts, costs), skills/ (verify, peer-review, new-variant, regression), agents/ (reviewer, tester, documenter) (chapter 20)
├── comptoir/           ← the shared code, which grows chapter after chapter
│   ├── config.py       ← settings read from the environment (model, effort, log)
│   ├── costs.py        ← usage → dollars (chapter 2)
│   ├── log.py          ← one JSON line per call, without key or message (chapter 2)
│   ├── notation.py     ← grade an answer with criteria written in advance (chapter 3)
│   ├── prompt.py       ← the versioned system prompt, filled in by the code (chapter 5)
│   ├── prompts/        ← the versions of the system prompt (system_v1.md…)
│   ├── data/           ← Awa's catalog and terms (fictional); workshop/: sales, stock, suppliers, messages (chapter 13)
│   ├── knowledge/      ← Awa's knowledge base: FAQ, terms, product sheets, areas, events (fictional)
│   ├── assistant.py    ← the Comptoir: request, tagged customer message, Awa's instructions (chapter 5)
│   ├── evaluation.py   ← compare variants on a set of cases (chapter 5)
│   ├── conversations.py ← the history of the conversations, append-only (chapter 6)
│   ├── streaming.py    ← stream, keep, resume a cut answer (chapter 6)
│   ├── web.py          ← the Comptoir on the web: FastAPI, SSE, WebSocket (chapter 6); maximum size, even in chunks (chapters 18 and 19)
│   ├── pages/          ← the chat page (chapter 6)
│   ├── documents.py    ← images and PDFs for Claude, and their cost in tokens (chapter 7)
│   ├── extraction.py   ← orders and invoices as validated data: schema, code, checks (chapter 7)
│   ├── accuracy.py     ← measure an extractor field by field (chapter 7)
│   ├── errors.py       ← each error: retry or fix, and where it comes from (chapter 8)
│   ├── budget.py       ← ceilings per customer, per day, per month, with reservation (chapter 8)
│   ├── call.py         ← the robust call: counting, reservation, log, diagnosis (chapter 8)
│   ├── dashboard.py    ← read the log: costs, failure modes, conversations to pick up (chapter 8); cost per conversation, latency, alerts (chapter 19)
│   ├── shop.py         ← stock, summaries, orders, requests to Awa (chapter 9)
│   ├── tools.py        ← the Comptoir's three tools and their execution (chapter 9)
│   ├── loop.py         ← the tool loop written by hand (chapter 9)
│   ├── orders.py       ← official summary and confirmation by code (chapter 9)
│   ├── server_tools.py ← web search, page reading, code execution: definitions and reading of the answers (chapter 10)
│   ├── editor.py       ← Anthropic's text editor, run in a closed folder (chapter 10)
│   ├── sales.py        ← the week's totals, calculated by our code (chapter 10)
│   ├── knowledge.py    ← the base cut into citable chunks, as search_result blocks (chapter 11)
│   ├── retrieval.py    ← BM25, embeddings, rank fusion, reranking and context by Claude (chapter 11)
│   ├── doc_assistant.py ← answer from the documents, with the sources, and grade the answer (chapter 11)
│   ├── router.py       ← the router: the code first, then Claude Haiku 5.5, one category out of four (chapter 12)
│   ├── trace.py        ← one trace per message: each step, its model, its duration, its cost (chapter 12)
│   ├── complaints.py   ← the complaints chain: extract, check, pass on, draft, evaluate (chapter 12)
│   ├── routing.py      ← the routed Comptoir: a dispatcher written in the code, three services (chapter 12)
│   ├── workshop.py     ← Awa's workshop: sales, needs, check and total of a purchase order, by the code (chapter 13)
│   ├── restock_agent.py ← the restocking agent: tools, subagent, guardrails, Tool Runner (chapter 13)
│   ├── guard.py        ← what the code checks whatever the model writes: announced pass-ons, name and neighborhood (chapter 18)
│   ├── limits.py       ← limits per network address: messages per minute, conversations per hour (chapter 18)
│   ├── monitoring.py   ← the filter of chapter 18 as a signal: it flags suspicious messages, blocks nothing (chapter 19)
│   ├── service.py      ← the shipped Comptoir behind its channels: conversation in the database, budget per message, log (chapter 19)
│   ├── whatsapp.py     ← WhatsApp: signature, incoming messages, sending through Meta's API, directory of the numbers (chapter 19)
│   └── online.py       ← the production server: web chat, WhatsApp webhook, dashboard, health (chapter 19)
├── decisions/          ← the written decisions, with their measurements (model.md, chapter 3; security-audit.md, chapter 18; optimization.md, chapter 19; sdk-2.md, chapter 21)
├── docs/               ← to run and evolve the Comptoir without its author: operations.md (alerts, operations, incidents), migration.md (model, SDK, API) (chapter 21)
├── ch02/               ← the scripts of chapter 2
├── ch03/               ← the comparison of the models (cases.json, compare_models.py, list_models.py)
├── ch05/               ← the evaluation of prompts v0 and v1 (cases.json, evaluate_prompt.py, mid_conversation_instruction.py)
├── ch06/               ← the events of a stream, three customers in parallel
├── ch07/               ← extract, approve, measure, cite; documents/: fictional samples and expected values
├── ch08/               ← trigger the errors, the robust Comptoir, the dashboard
├── ch09/               ← the Comptoir that takes orders, the Tool Runner, the 10 scenarios
├── ch10/               ← watch, page reading, weekly report (PDF and Excel), FAQ correction
├── ch11/               ← questions to the documents, cache before and after, diagnosis, retrieval, evaluation, Comptoir with the knowledge base
├── ch12/               ← 30 test messages, the router measured, thinking and citations, order of the fields, complaints, routed Comptoir
├── ch13/               ← the workshop's data, criteria, the agent and its evaluation, approval by Awa, Agent SDK, Managed Agents, scheduling
├── ch14/               ← anonymized copy of the orders, DBHub read-only (dbhub.toml), server explorer, questions to Claude Code, MCP connector, evening question; mcp/: third-party MCP servers, pinned versions
├── .mcp.json           ← the orders' MCP server, plugged into Claude Code for the whole project (chapter 14)
├── ch15/               ← the “Comptoir for Awa” MCP server, its desktop extension (build_extension.py), the trials with Claude Code; tools/: MCP inspector and mcpb CLI, pinned versions
├── ch16/               ← the Comptoir online (online_server.py), its OAuth authorization server (authorization.py), an OAuth client, a raw client, the API through the connector; deployment/: Dockerfile, compose.yaml, Caddyfile, pinned dependencies with hashes
├── ch17/               ← the evaluation suite: 60 cases (cases.json), test harness, grading by the code, judge and its rubrics, calibration on human grades (grading page), comparison, register, regression; results/: series, transcripts, register
├── ch18/               ← the security audit: five attacks against Claude (attacks.json, attack.py), the injection seen from Awa's side (awa_side.py), a measured input filter (input_filter.py), five attacks against the code and two checks (code_audit.py), purge and erasure of the data (data.py); results/: series and audits
├── ch19/               ← the cost per conversation and its levers (conversations.json, measure_cost.py), the evening summary live or in batch (evening_summary.py), the judge in batch (judge_in_batch.py); deployment/: Dockerfile, compose.yaml, Caddyfile, .env.example, backup.sh, restore.sh (chapter 21), pinned dependencies with hashes; results/: costs and summaries
├── ch21/               ← the watch over the models, the SDK and the API version (watch.py), the estimate of a project (estimate_project.py)
└── tests/              ← tests without paid calls (fake client)
claude-tools/           ← a plugin marketplace for Claude Code (yao-tools): secret-guard (the Comptoir's hook) and peer-review (a subagent and /peer-review:review, which depends on secret-guard) (chapter 20)
.github/workflows/      ← tests.yml (the tests and the audit at each push, free); tests-typescript.yml (the same for the TypeScript version, types included); claude.yml (regression and review by Claude on each pull request, through identity federation, without a stored key) (chapter 20); watch.yml (the watch, every Monday, free, for both versions) (chapter 21)
typescript/             ← the TypeScript equivalent, chapter after chapter (SDK @anthropic-ai/sdk); all chapters, 2 to 21
├── package.json        ← the official SDK; TypeScript, tsx and Node's types for development
├── CLAUDE.md           ← the project's memory for Claude Code (chapter 4), with its tools (chapter 20)
├── .claude/            ← Claude Code for this version: settings.json (permissions, chapter 4; hooks, chapter 20), hooks/ (the four hooks of chapter 20, in TypeScript without dependencies, which Node runs alone), rules/, skills/ (verify, peer-review, new-variant, regression), agents/ (reviewer, tester, documenter)
├── comptoir/           ← the same shared code as in Python: config.ts, costs.ts, log.ts, notation.ts, prompt.ts, assistant.ts, evaluation.ts, conversations.ts, streaming.ts, web.ts (Hono instead of FastAPI), documents.ts (sharp instead of Pillow), extraction.ts (Zod instead of Pydantic), accuracy.ts, outputs.ts (the JSON schema of structured outputs, like transform_schema in Python), dashboard.ts, shop.ts, tools.ts, loop.ts, orders.ts, server_tools.ts, editor.ts, sales.ts, diff.ts (difflib.unified_diff, same algorithm), retrieval.ts, doc_assistant.ts, router.ts, trace.ts, complaints.ts, routing.ts, workshop.ts, restock_agent.ts (the SDK's Tool Runner), guard.ts and limits.ts (chapter 18), knowledge.ts (chapter 11), errors.ts, budget.ts, call.ts (chapter 8), monitoring.ts, service.ts, whatsapp.ts and online.ts (the production server, with Hono, chapter 19); client.ts (what the code expects of the SDK's client), csv.ts (the results files, in Python's format), rounding.ts and python.ts (round, repr, ==, sum, statistics.mean, json.dumps and json.loads, :g and repr of a Python float, for the same results and the same text sent to Claude), random.ts (Python's random.Random: the same draws, chapter 17), database.ts (the SQLite built into Node), dates.ts (dates like `date.fromisoformat`), launch.ts
├── ch02/ … ch16/       ← the same scripts as in Python, with the same names; the samples of chapter 7, the sales export of chapter 10, the workshop's data of chapter 13 and the orders history of chapter 14 are those of the Python version, made by python/ch07/make_samples.py, python/ch10/make_sales.py, python/ch13/make_data.py and python/ch14/make_orders.py (no TypeScript equivalent: they are made only once); in chapter 14, the MCP servers are those of python/ch14/mcp/, run from the python/ folder, and the MCP client is the official SDK @modelcontextprotocol/sdk; in chapter 15, the server is written with that same SDK, the extension is of type “node” (esbuild bundles the server, the MCP SDK and Zod into a single file) and is validated and packaged with the mcpb CLI of python/ch15/tools; the test database is that of python/customer_data/; in chapter 16, the OAuth endpoints are those of the MCP SDK, served by Express, and the server stops at the 2025-11-25 revision of the protocol; deployment/: Dockerfile (the sources run by tsx), compose.yaml, Caddyfile, pinned dependencies with hashes (package-lock.json)
├── ch17/ … ch21/       ← the same scripts as in Python, with the same names; the cases (cases.json), the regression list, the judge's rubrics and the grading page of chapter 17, the attacks of chapter 18 and the typical conversations of chapter 19 are those of python/, shared by both versions; the series, the register and the results go into this version's chNN/results/, in the Python version's formats (a series of one is reread, summarized and compared with the other); in chapter 18, Awa's side runs this version's chapter 15 MCP server; ch19/deployment/: Dockerfile (the sources run by tsx, Awa's data through a named build context), compose.yaml, Caddyfile, .env.example, backup.sh, restore.sh, pinned dependencies with hashes (package-lock.json)
└── tests/              ← the same tests without paid calls (fake client), with Node's test runner, and comparisons with the Python version (skipped if python/.venv is missing)
```

The data shared by the two languages (evaluation cases, catalog, prompts) stay in `python/`: the TypeScript version reads them there, so that only one copy exists.

## Install

Python 3.10 or later. From the `python/` folder:

```bash
python -m venv .venv
# Windows: .venv\Scripts\Activate.ps1   —   macOS, Linux: source .venv/bin/activate
pip install -e ".[tests]"
pip install -e ".[agents]"   # the Claude Agent SDK, for chapter 13 only
pip install -e ".[mcp]"      # the MCP client and anthropic[mcp], for chapter 14
cd ch14/mcp && npm ci && cd ../..   # the MCP servers of chapter 14 (Node 22.5 or later)
cd ch15/tools && npm ci && cd ../..   # the MCP inspector and mcpb, for chapter 15 (Node 22.19 or later)
pip install uv                     # to package the extension of chapter 15
python -m pytest
```

The tests never call the API and cost nothing.

In TypeScript: Node 22.13 or later (its built-in SQLite module, without a flag since that version). From the `typescript/` folder:

```bash
npm ci
npm test            # the tests, without paid calls
npm run typecheck   # the type check
```

`npm ci` also installs the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, pinned version) and the Claude Code binary for your platform: 285 MB on Windows. Only `ch13/with_agent_sdk.ts` uses it. To package the extension of chapter 15 (`--package`), you also need the mcpb CLI of the Python version: `npm ci` in `python/ch15/tools`.

## Run the examples

The API key goes in the `ANTHROPIC_API_KEY` environment variable, never in the code. Then, from `python/`:

```bash
python -m ch02.http_call
python -m ch02.first_call
python -m ch02.comptoir_cli "How much is the ginger syrup, and do you deliver to Fidjrossè?"
python -m ch02.count_tokens "your sentence"
python -m ch03.list_models
python -m ch03.compare_models --estimate
python -m ch03.compare_models --repetitions 3 --max-budget 2
python -m ch05.evaluate_prompt --estimate
python -m ch05.evaluate_prompt --repetitions 3 --max-budget 1
python -m ch05.evaluate_prompt --regrade   # free: regrades the answers already obtained
python -m ch05.mid_conversation_instruction
python -m ch06.events "Which juices do you have, and at what price?"
python -m ch06.three_customers
python -m uvicorn comptoir.web:app --reload   # then http://127.0.0.1:8000
python -m ch07.extract ch07/documents/order-01.jpg --estimate
python -m ch07.extract ch07/documents/order-02.jpg
python -m ch07.approve_orders ch07/documents/order-01.jpg
python -m ch07.measure_accuracy --repetitions 3 --max-budget 0.5
python -m ch07.cite_terms "Within what time must I report breakage, and what happens next?"
python -m ch08.trigger_errors
python -m ch08.robust_comptoir "How much are 6 bottles of bissap?" --customer trial-1
python -m ch08.dashboard --html log/dashboard.html
python -m ch09.comptoir_orders
python -m ch09.with_tool_runner
python -m ch09.play_scenarios --max-budget 0.5
python -m ch10.watch "Which public holidays fall in Benin in November and December 2026?"
python -m ch10.read_page --max-read-tokens 2000 https://fr.wikipedia.org/wiki/Bissap "Summarize in three sentences."
python -m ch10.weekly_report
python -m ch10.excel_report
python -m ch10.fix_faq
python -m ch11.ask "Can you deliver the juices for our wedding on a Sunday?"
python -m ch11.cache_before_after --max-budget 0.5
python -m ch11.diagnose_cache
python -m ch11.contextualize
python -m ch11.measure_retrieval          # free
python -m ch11.evaluate_doc_assistant --max-budget 0.8
python -m ch11.comptoir_with_knowledge --variants none 5m 1h
python -m ch11.evaluate_doc_assistant --modes context --model claude-haiku-5-5 --no-thinking --no-citations --output trials-haiku-no-citations.csv
python -m ch12.evaluate_router
python -m ch12.thinking_and_citations
python -m ch12.field_order
python -m ch12.complaints
python -m ch12.complaints --effort default --repetitions 2
python -m ch12.routed_comptoir --max-budget 1
python -m ch13.make_data                  # free
python -m ch13.restock
python -m ch13.restock --max-turns 2
python -m ch13.restock --memory workshop_memory --orders orders.json
python -m ch13.approve_order --orders orders.json --list
python -m ch13.evaluate_agent --repetitions 3 --max-budget 1.5
python -m ch13.with_agent_sdk --max-budget 0.60
python -m ch13.with_managed_agents --budget-cents 100
python -m ch13.schedule_monday --agent AGENT_ID --environment ENV_ID   # calls nothing without --create
python -m ch14.make_orders                # free
python -m ch14.explore_server orders      # free; also: everything, doc; --try-to-write
python -m ch14.measure_claude_code --claude claude --max-budget 0.40
python -m ch14.ask_the_docs
python -m ch14.ask_the_docs --pin
python -m ch14.evening_question
python -m ch15.build_extension --package   # free
python -m ch15.try_with_claude_code --claude claude --max-budget 0.30
python -m ch16.authorization hash        # the fingerprint of Awa's password
uvicorn ch16.online_server:app --port 8016   # with COMPTOIR_PUBLIC_URL, COMPTOIR_SHOP, COMPTOIR_PASSWORD_HASH
python -m ch16.connect http://localhost:8016/mcp
python -m ch16.raw_client http://localhost:8016/mcp
python -m ch16.ask_through_the_api https://<public-address>/mcp
python -m ch17.generate_cases
python -m ch17.evaluate estimate --set improvement --trials 3   # free
python -m ch17.evaluate run --variant reference --set improvement --trials 3 --max-budget 1
python -m ch17.evaluate judge <series> --model claude-haiku-5-5 --max-budget 0.3
python -m ch17.compare <series A> <series B> --judge-model claude-haiku-5-5   # free
python -m ch17.sample draw <series> --size 30 && python -m ch17.sample page   # free
python -m ch17.sample calibrate <series> --model claude-haiku-5-5 --half calibration   # free
python -m ch17.evaluate regression --max-budget 0.3   # the shipped version; exit code 1 at the first failure
python -m uvicorn comptoir.online:app --port 8019   # the Comptoir online, locally (web chat and WhatsApp webhook)
python -m ch19.measure_cost --estimate   # free; then --variant shipped|effort-low|no-cache --trials 3 --max-budget 0.2
python -m ch19.evening_summary --mode batch --max-wait 3600
python -m ch19.judge_in_batch <series> --estimate   # free; without --estimate: the judge of chapter 17 through the Batch API
python -m ch21.watch --horizon 120   # free (the Models API consumes no token); exit code 1 if there is an alert
python -m ch21.estimate_project --messages 1500 --whatsapp --hosting 7   # free
python -m ch18.data erase-number <number>   # free; erases the conversation, the requests and the number
```

The same examples in TypeScript, from `typescript/`:

```bash
npx tsx ch02/http_call.ts
npx tsx ch02/first_call.ts
npx tsx ch02/comptoir_cli.ts "How much is the ginger syrup, and do you deliver to Fidjrossè?"
npx tsx ch02/count_tokens.ts "your sentence"
npx tsx ch03/list_models.ts
npx tsx ch03/compare_models.ts --estimate
npx tsx ch03/compare_models.ts --repetitions 3 --max-budget 2
npx tsx ch05/evaluate_prompt.ts --estimate
npx tsx ch05/evaluate_prompt.ts --repetitions 3 --max-budget 1
npx tsx ch05/evaluate_prompt.ts --regrade --trials ../python/ch05/results/trials.csv   # free
npx tsx ch05/mid_conversation_instruction.ts
npx tsx ch06/events.ts "Which juices do you have, and at what price?"
npx tsx ch06/three_customers.ts
npm run web   # the Comptoir on the web, then http://127.0.0.1:8000 (the Python version's page)
npx tsx ch07/extract.ts ../python/ch07/documents/order-01.jpg --estimate
npx tsx ch07/extract.ts ../python/ch07/documents/order-02.jpg
npx tsx ch07/approve_orders.ts ../python/ch07/documents/order-01.jpg
npx tsx ch07/measure_accuracy.ts --repetitions 3 --max-budget 0.5
npx tsx ch07/cite_terms.ts "Within what time must I report breakage, and what happens next?"
npx tsx ch08/trigger_errors.ts
npx tsx ch08/robust_comptoir.ts "How much are 6 bottles of bissap?" --customer trial-1
npx tsx ch08/dashboard.ts --html log/dashboard.html
npx tsx ch09/comptoir_orders.ts
npx tsx ch09/with_tool_runner.ts
npx tsx ch09/play_scenarios.ts --max-budget 0.5
npx tsx ch10/watch.ts "Which public holidays fall in Benin in November and December 2026?"
npx tsx ch10/read_page.ts --max-read-tokens 2000 https://fr.wikipedia.org/wiki/Bissap "Summarize in three sentences."
npx tsx ch10/weekly_report.ts
npx tsx ch10/excel_report.ts
npx tsx ch10/fix_faq.ts
npx tsx ch11/ask.ts "Can you deliver the juices for our wedding on a Sunday?"
npx tsx ch11/cache_before_after.ts --max-budget 0.5
npx tsx ch11/diagnose_cache.ts
npx tsx ch11/contextualize.ts
npx tsx ch11/measure_retrieval.ts          # free
npx tsx ch11/evaluate_doc_assistant.ts --max-budget 0.8
npx tsx ch11/comptoir_with_knowledge.ts --variants none 5m 1h
npx tsx ch12/evaluate_router.ts
npx tsx ch12/thinking_and_citations.ts
npx tsx ch12/field_order.ts
npx tsx ch12/complaints.ts
npx tsx ch12/complaints.ts --effort default --repetitions 2
npx tsx ch12/routed_comptoir.ts --max-budget 1
npx tsx ch13/restock.ts
npx tsx ch13/restock.ts --max-turns 2
npx tsx ch13/restock.ts --memory workshop_memory --orders orders.json
npx tsx ch13/approve_order.ts --orders orders.json --list
npx tsx ch13/evaluate_agent.ts --repetitions 3 --max-budget 1.5
npx tsx ch13/with_agent_sdk.ts --max-budget 0.60
npx tsx ch13/with_managed_agents.ts --budget-cents 100
npx tsx ch13/schedule_monday.ts --agent AGENT_ID --environment ENV_ID   # calls nothing without --create
npx tsx ch14/explore_server.ts orders       # free; also: everything, doc; --try-to-write
npx tsx ch14/measure_claude_code.ts --claude claude --max-budget 0.40
npx tsx ch14/ask_the_docs.ts
npx tsx ch14/ask_the_docs.ts --pin
npx tsx ch14/evening_question.ts
npx tsx ch15/build_extension.ts --package   # free
npx tsx ch15/try_with_claude_code.ts --claude claude --max-budget 0.30
npx tsx ch16/authorization.ts hash        # the fingerprint of Awa's password (the same form as in Python)
npx tsx ch16/online_server.ts --port 8016   # with COMPTOIR_PUBLIC_URL, COMPTOIR_SHOP, COMPTOIR_PASSWORD_HASH
npx tsx ch16/connect.ts http://localhost:8016/mcp
npx tsx ch16/raw_client.ts http://localhost:8016/mcp --revision 2025-11-25
npx tsx ch16/ask_through_the_api.ts https://<public-address>/mcp
npx tsx ch17/generate_cases.ts
npx tsx ch17/evaluate.ts estimate --set improvement --trials 3   # the judge's counting is free
npx tsx ch17/evaluate.ts run --variant reference --set improvement --trials 3 --max-budget 1
npx tsx ch17/evaluate.ts judge <series> --model claude-haiku-5-5 --max-budget 0.3
npx tsx ch17/compare.ts <series A> <series B> --judge-model claude-haiku-5-5   # free; a series of the Python version compares too
npx tsx ch17/sample.ts draw <series> --size 30   # free; then: page, calibrate <series> --half calibration
npx tsx ch17/evaluate.ts regression --max-budget 0.3   # the shipped version; exit code 1 at the first failure
npx tsx ch18/attack.ts --estimate   # free; then --label before --trials 3 --max-budget 0.3
npx tsx ch18/awa_side.ts --estimate   # free; then --label before --trials 3 --max-budget 0.4
npx tsx ch18/input_filter.ts --estimate     # free; then --max-budget 0.1
npx tsx ch18/code_audit.ts --label before   # free: a fake client
npx tsx ch18/data.ts erase-number <number>   # free; erases the conversation, the requests and the number
npx tsx comptoir/online.ts --port 8019   # the Comptoir online, locally (web chat and WhatsApp webhook)
npx tsx ch19/measure_cost.ts --estimate   # free; then --variant shipped|effort-low|no-cache --trials 3 --max-budget 0.2
npx tsx ch19/evening_summary.ts --mode batch --max-wait 3600
npx tsx ch19/judge_in_batch.ts <series> --estimate   # free; without --estimate: the judge of chapter 17 through the Batch API
npx tsx ch21/watch.ts --horizon 120   # free (the Models API consumes no token); exit code 1 if there is an alert
npx tsx ch21/estimate_project.ts --messages 1500 --whatsapp --hosting 7   # free
```

With Claude Code, in the `python/` or `typescript/` folder: `/verify` before a commit (free), `/peer-review` for a review by the subagent, `/new-variant <change>` to prepare a variant of chapter 17, `/regression` (paid, about $0.03). The hooks of `.claude/settings.json` are programs without dependencies, run by `sh` (Git Bash on Windows): in Python in `python/`, in TypeScript in `typescript/`, which Node runs alone (it strips the types).

To put the Comptoir online: `python/ch19/deployment/`, or `typescript/ch19/deployment/` for the TypeScript version (copy `.env.example` to `.env`, fill it in, then `docker compose up -d --build`, from that folder, on the server). To run it afterwards: `python/docs/operations.md` (with the TypeScript version, the commands run in the container become `node --import tsx ch18/data.ts …` and `npx tsx ch21/watch.ts`); to change the model, the SDK or the API version: `python/docs/migration.md`.

Downloaded reports go into `reports/`, excluded from Git. The sales export of `ch10/data/` is fictional, made by `python -m ch10.make_sales`.

The documents of `ch07/documents/` are fictional, made by `python -m ch07.make_samples` (without a call to the API).

Each call is recorded in `log/calls.jsonl` (request ID, model, tokens, cost). The conversations of the web chat live in `customer_data/`: they are customer data, deleted after 30 days. These two folders are excluded from Git.

## Verified versions

The measurements of the book, and the real calls below, were made on the French code of the Comptoir, of which this repository is the translation; the test counts of the tables are those of the French code at each chapter. On this English code, the tests without calls pass: 469 in Python (`python -m pytest`) and 553 in TypeScript (`npm test`), with the types checked (`npm run typecheck`), on November 2, 2026. The French code has one more test in each language: the conversion of costs into FCFA and euros, which this edition does not have (dollars only).

| Chapter | Python | `anthropic` SDK | Tests without calls | Real calls |
|---|---|---|---|---|
| 2 | 3.13 | 1.15.0 | 12 passed on October 20, 2026 | made on October 20, 2026: 4 calls, $0.0075 |
| 3 | 3.13 | 1.15.0 | 13 more (25 in all) passed on October 20, 2026 | made on October 20, 2026: 270 calls, $0.6247 |
| 4 | 3.13 | 1.15.0 | 5 more (30 in all) passed on October 20, 2026 | Claude Code session replayed on October 20, 2026 (`claude -p`, Opus 5.5): $3.0257 |
| 5 | 3.13 | 1.15.0 | 15 more (45 in all) passed on October 20, 2026; 2 more after the measurement | made on October 20, 2026: 122 calls, $0.5258 |
| 6 | 3.13 | 1.15.0, FastAPI 0.150.0, uvicorn 0.54.0 | 27 more (72 in all) passed on October 20, 2026; interface tried in a browser with a fake client | made on October 20, 2026: 10 calls, $0.0576, including the web chat with Claude |
| 7 | 3.13 | 1.15.0, Pillow 13.0.0 | 40 more (112 in all) passed on October 20, 2026 | made on October 20, 2026: 39 calls, $0.4502 |
| 8 | 3.13 | 1.15.0 | 38 more (150 in all) passed on October 20, 2026; dashboard tried on a fictional log | made on October 20, 2026: 3 billed calls, ≈ $0.0091 |
| 9 | 3.13 | 1.15.0 | 30 more (180 in all) passed on October 20, 2026 | made on October 20, 2026: 27 calls, $0.2500 |
| 10 | 3.13 | 1.15.0 | 18 more (198 in all) passed on October 20, 2026 | made on October 20, 2026: 10 calls, $0.4563 |
| 11 | 3.13 | 1.15.0 | 31 more (231 in all) passed on October 20, 2026 | made on October 20, 2026: 162 calls, $0.8497; Voyage AI embeddings not measured (no key) |
| 12 | 3.13 | 1.15.0 | 21 more (252 in all) passed on October 20, 2026 | made on October 20, 2026: 1,095 logged calls, $1.1265, trials before fixes included |
| 13 | 3.13 | 1.15.0, claude-agent-sdk 0.2.168 (Claude Code 2.1.301) | 22 more (274 in all) passed on October 20, 2026 | made on October 20, 2026: 105 logged calls ($1.1887), an Agent SDK session ($0.0771) and a Managed Agents session ($0.0842): $1.35; scheduled deployment not created |
| 14 | 3.13 | 1.15.0, mcp 2.3.0, Claude Code 2.1.304; Node 22.20, DBHub 1.5.0, server-everything 1.0.0 | 17 more (291 in all) passed on October 21, 2026 | made on October 21, 2026: 8 logged calls ($0.0548) and 3 Claude Code sessions ($0.1493): $0.20 |
| 15 | 3.13 | 1.15.0, mcp 2.3.0, Claude Code 2.1.304; uv 0.13.4, @anthropic-ai/mcpb 2.1.2, MCP inspector 2.11.0 | 13 more (304 in all) passed on October 21, 2026; .mcpb package validated, built and run by uv | made on October 21, 2026: 3 Claude Code sessions, $0.1379 |
| 16 | 3.13 | 1.15.0, mcp 2.3.0, httpx2 2.15.1; Docker 29.7.2, cloudflared 2026.10.2 | 18 more (322 in all) passed on October 21, 2026; full OAuth flow locally and through a tunnel; Docker image run | made on October 21, 2026: 1 call, $0.0005 |
| 17 | 3.13 | 1.15.0 | 27 more (349 in all) passed on October 21, 2026; grading page tried by the author (40 answers graded) | made on October 21, 2026: 513 trials, 2,037 calls, $2.59; the routed Comptoir moves to Claude Haiku 5.5 (`COMPTOIR_COMPTOIR_MODEL`) |
| 18 | 3.13 | 1.15.0, mcp 2.3.0, FastAPI 0.150.0 | 56 more (405 in all) passed on October 21, 2026; code audit before and after (`ch18.code_audit`), free | made on October 21, 2026: 965 calls and 12 sessions on Awa's side, $0.3875; the shipped Comptoir moves to prompt v5 |
| 19 | 3.13 (image: python:3.13-slim) | 1.15.0, FastAPI 0.150.0, uvicorn 0.54.0, httpx2 2.15.1; Caddy 2.11.7 | 26 more (431 in all) passed on October 22, 2026; image built and played locally behind Caddy over HTTPS; WhatsApp tried with manufactured signed notifications and a fake sender (no real message) | made on October 22, 2026: 876 calls, $0.3311; the Comptoir's effort stays at `medium` |
| 20 | 3.13 | 1.15.0; Claude Code 2.1.304 | 22 more in `test_ch20.py`, 6 in `test_ch19.py` (459 in all) passed on October 22, 2026; plugins validated and installed; workflows analyzed, not run on GitHub | made on October 22, 2026: 12 Claude Code sessions (Claude Sonnet 5.5), $0.9394, and a regression, $0.0336; four fixes in the code of chapter 19, found by the review |
| 21 | 3.13 (image: python:3.13-slim) | **2.1.0** (API `2026-10-21`) | 10 more (469 in all) passed on October 22, 2026; migration tried in a separate environment (465 passed); image rebuilt; erasure by number and restoration played locally | made on October 22, 2026: regression, eight conversations, chapter 13 agent, trial calls, image: $0.0507; the watch, free; `watch.yml` not run on GitHub |

The TypeScript version:

| Chapter | Node | `@anthropic-ai/sdk` SDK | Tests without calls | Real calls |
|---|---|---|---|---|
| 2 and 3 | 22.20; TypeScript 7.0.2, tsx 4.23.15 | 1.1.0 (API `2026-10-21`) | 34 passed on October 22, 2026, including the comparison with the Python version's prompt; types checked (`tsc --noEmit`) | not yet: the book's measurements are those of the Python version |
| 5 | 22.20; TypeScript 7.0.2, tsx 4.23.15 | 1.1.0 | 21 more (55 in all) passed on October 22, 2026, including two comparisons with the Python version: the five assembled prompts have the same fingerprint, and the chapter's 120 real answers, regraded, receive the same verdicts (116 passed) | not yet |
| 6 | 22.20; TypeScript 7.0.2, tsx 4.23.15; Hono 4.13.13, @hono/node-server 2.1.5, ws 8.22.0, zod 4.6.7 | 1.1.0 | 73 more (128 in all) passed on October 22, 2026, including those of the chapter 8 modules and of the chapter 18 limits on which the server depends, and the behavior of the TypeScript SDK facing three stream cuts, against a fake local server; chat tried in a browser with a fake client (answer as it streams, second turn in the same conversation) | not yet |
| 7 | 22.20; TypeScript 7.0.2, tsx 4.23.15; zod 4.6.7, sharp 0.35.5 | 1.1.0 | 42 more (170 in all) passed on October 22, 2026, including the schema sent compared with the Python version's (identical, titles aside); scripts run without a key: the request is prepared, shrunk photo included, then stops before any sending | not yet |
| 8 | 22.20; TypeScript 7.0.2, tsx 4.23.15 | 1.1.0 | 10 more (180 in all) passed on October 22, 2026 (errors, budget and robust call had come with chapter 6), including the dashboard compared with the Python version's on the same log; dashboard tried on a fictional log: output and HTML page identical, byte for byte, to those of the Python version | not yet |
| 9 | 22.20; TypeScript 7.0.2, tsx 4.23.15; zod 4.6.7 | 1.1.0 (Tool Runner: `client.beta.messages.toolRunner`, `betaZodTool`) | 77 more (257 in all) passed on October 22, 2026, including the guards of chapter 18 and Awa's knowledge base of chapter 11, compared chunk by chunk with the Python version's; scenarios run without a key: stop before any call, $0 spent | not yet |
| 10 | 22.20; TypeScript 7.0.2, tsx 4.23.15 | 1.1.0 (Files API out of beta: `client.files`, `toFile`) | 33 more (290 in all) passed on October 23, 2026, including four comparisons with the Python version: the editor (same answers to 18 commands, same files), the totals and gaps of the sales, `difflib.unified_diff` on 60 cases, the sheets of workbooks written by `zipfile` and of the one the xlsx Skill produced; scripts run without a key: stop at the first sending, no file left | not yet |
| 11 | 22.20; TypeScript 7.0.2, tsx 4.23.15 | 1.1.0 (cache diagnosis: `client.beta.messages`, `diagnostics`) | 30 more (320 in all) passed on October 23, 2026, including six comparisons with the Python version: the BM25 rankings of the 20 questions (same chunks, same ranks; scores within 10⁻¹², V8's logarithm sometimes differing in the last bit), the cosine scores and the rank fusion (identical), the requests (six settings, reranking, context), the verdicts on the chapter's 160 real answers, 3,000 roundings and 610 written numbers; scripts run without a key: stop at the first sending, no results file written | not yet |
| 12 | 22.20; TypeScript 7.0.2, tsx 4.23.15 | 1.1.0 | 31 more (351 in all) passed on October 23, 2026, including the four tests of the “say versus do” guard of chapter 18, which waited for the routed Comptoir, and four comparisons with the Python version: the routing request (three settings), the schemas, prompts, promises and facts of the complaints, the complaints chain on three scripted scenarios (same requests sent, same result), the routed Comptoir on three conversations of two messages (same requests, tools and cache points included, same answers, same steps); scripts run without a key: stop at the first sending, no results file written | not yet |
| 13 | 22.20; TypeScript 7.0.2, tsx 4.23.15; Claude Agent SDK `@anthropic-ai/claude-agent-sdk` 0.3.309 (Claude Code binary 0.3.309), `@modelcontextprotocol/sdk` 1.32.1 | 1.1.0 (Tool Runner `client.beta.messages.toolRunner`, `betaTool`, `ToolError`, `compactBeforeNextTurn`, memory tool `BetaLocalFilesystemMemoryTool`; Managed Agents `client.beta.environments`, `agents`, `sessions`, `deployments`) | 31 more (382 in all) passed on October 23, 2026, including a full session with the real Tool Runner (answers from a fake `fetch`, without network), the workshop's MCP server queried by a real in-memory MCP client, and six comparisons with the Python version: the tools' outputs and the errors of a purchase order, the dates and numbers written (`date.fromisoformat`, `:g`), the orders file, the tools' definitions (`type: "custom"` aside, which the TypeScript SDK adds) and their outputs on nine calls, the custom tools of Managed Agents and the scheduling, the hook's decisions and the MCP tools of the Claude Agent SDK; `schedule_monday` run without `--create` in both languages: same output; calling scripts run without a key: stop at the first sending, except `with_agent_sdk`, not run from the session | not yet |
| 14 | 22.20; TypeScript 7.0.2, tsx 4.23.15; `@modelcontextprotocol/sdk` 1.32.1 (the most recent in the registry on October 23, 2026: protocol 2025-11-25 at most); DBHub 1.5.0 and server-everything 1.0.0 servers of the Python version | 1.1.0 (`mcpTools` of `@anthropic-ai/sdk/helpers/beta/mcp` for the Tool Runner; MCP connector: `mcp_servers`, `mcp_toolset`, betas `mcp-client-2025-11-20` and `mcp-client-2026-09-15`) | 17 more (399 in all) passed on October 23, 2026, including three comparisons with the Python version: alerts, check of Claude Code's answers, requests of the connector, price comparison and trace; right answers computed on the copy; Tool Runner tool drawn from an MCP tool; `explore_server` run in both languages on the three servers (free): same outputs, except the version negotiated with DBHub (2025-11-25 in TypeScript, 2026-07-28 in Python; 2025-11-25 on both sides with the two others); write refused by DBHub, copy intact; `evening_question` and `ask_the_docs` run without a key: stop at the first sending; `measure_claude_code` not run (it calls Claude Code, paid) | not yet |
| 15 | 22.20; TypeScript 7.0.2, tsx 4.23.15; `@modelcontextprotocol/sdk` 1.32.1 (`McpServer` server), zod 4.6.7, esbuild 0.28.2, sharp 0.35.5; `@anthropic-ai/mcpb` 2.1.2 of the Python version | 1.1.0 (the server does not call the API) | 15 more (414 in all) passed on October 23, 2026, including two comparisons with the Python version: the server's announcement (tools, annotations, `_meta`, schemas apart from differences of form, resources, prompts, instructions) and its answers to 13 calls, 2 resources and 3 prompts, on the same copy of the database, at the same time (identical, error texts included, randomly drawn tokens aside); server run over stdio by tsx, and once packaged, from a copy: clean standard output; .mcpb package validated and built (256.6 kB); extension not installed in the Claude app; `try_with_claude_code` not run (it calls Claude Code, paid) | not yet |
| 16 | 22.20; TypeScript 7.0.2, tsx 4.23.15; `@modelcontextprotocol/sdk` 1.32.1 (OAuth server `mcpAuthRouter`, `requireBearerAuth`, stateless HTTP transport), Express 5.3.0 (`@types/express` 5.0.6); uvicorn 0.54.0 of the Python version, for the cross trials | 1.1.0 (`ask_through_the_api`: MCP connector with `authorization_token`) | 30 more (444 in all) passed on October 23, 2026, including the full OAuth flow on a local port, and five comparisons with the Python version: the server's announcement, its answers (report, progress, confirmation form), 32 steps of the OAuth flow response by response (same statuses, same redirects, same pages; error texts specific to each SDK aside), the connector's request, and the TypeScript scripts facing the Python server run by uvicorn (password hashed by one, checked by the other, both ways); scripts run against the local TypeScript server: `connect --automatic`, `raw_client` in both revisions; login page tried in a browser: the redirect to the callback address goes through; Dockerfile checked by `docker build --check`, image not built; `ask_through_the_api` not run (paid) | not yet |
| 17 | 22.20; TypeScript 7.0.2, tsx 4.23.15 | 1.1.0 (the judge: `output_config` with a JSON schema; the generation of the cases: stream and `withOptions`) | 34 more (478 in all) passed on October 25, 2026, including comparisons with the Python version: `random.Random` (confirmation codes, draws) and `statistics.mean`; the grading by the code and the summaries, on the book's 13 measured series (all their real answers, with and without the judge); the drawn sample and the calibration on the author's grades; the judge's requests; the test harness on four scripted cases (same requests, same confirmation codes); the cases' fingerprint in the register; `evaluate.ts summarize`, `compare.ts` and `sample.ts draw` run in both languages on the book's series: same outputs; `estimate` and `generate_cases` run without a key: stop at the first sending, nothing written | not yet |
| 18 | 22.20; TypeScript 7.0.2, tsx 4.23.15; `@modelcontextprotocol/sdk` 1.32.1 (Awa's side, on this version's chapter 15 server) | 1.1.0 (Tool Runner, `mcpTools`, `betaTool`) | 15 more (493 in all) passed on October 25, 2026, including comparisons with the Python version: the grades of the attacks on the book's four measured series; the filter's labeled messages, its request, and the shop on Awa's side (same codes, same totals, same instants); code audit run (free): the seven points hold, with the figures of the Python audit “after” (10 messages accepted then 429, 20 out of 60, 413); `--estimate` of the three paid scripts: same outputs as in Python | not yet |
| 19 | 22.20; TypeScript 7.0.2, tsx 4.23.15; Hono 4.13.13, @hono/node-server 2.1.5; image `node:22.22.3-alpine` | 1.1.0 (Batch API: `messages.batches`) | 34 more (527 in all) passed on October 25, 2026, including comparisons with the Python version: WhatsApp's signatures, fingerprints, messages and splits; the evening facts and their request; the service on a conversation of two messages (same requests, same conversation kept, same events in the log); the requests of the judge in batch on a series of the book; the summary of the book's four cost measurements; online server tried on a real HTTP port, with a fake client and a fake sender (chat over SSE, signed webhook, dashboard, address read behind a proxy); `--estimate` of the three scripts: same outputs; Dockerfile checked by `docker build --check`, `docker compose config` valid, image not built | not yet |
| 20 | 22.20 (the hooks, run by Node alone, without tsx: `--experimental-strip-types`) | — | 15 more (542 in all) passed on October 25, 2026: hooks tried on manufactured events, in temporary Git repositories, and through `run.sh` as Claude Code runs them; settings, Skills, subagents and rules checked; `tests-typescript.yml` workflow analyzed, not run on GitHub | not yet |
| 21 | 22.20 | 1.1.0 (API `2026-10-21`, since 1.0.0); 1.3.0 available on October 25, 2026 | 12 more (554 in all) passed on October 25, 2026, including the comparison of the watch reports and of the estimates with the Python version; TypeScript watch job of `watch.yml` not run on GitHub | the watch, free, on October 25, 2026, in both languages: same models, same dates, no alert |
