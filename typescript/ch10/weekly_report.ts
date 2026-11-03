// Chapter 10: Awa's weekly sales report, calculated and laid out by code execution.
//
// 1. The CSV export goes to the container, through the Files API.
// 2. Claude writes and runs the code: totals, PNG chart, PDF report, JSON summary.
// 3. The script downloads the files, then compares the summary with our own calculation.
// 4. It deletes from the Files API the file sent and the files produced.
//
// The export is that of the Python version (python/ch10/data/), made once by python/ch10/make_sales.py.
// Run, from the typescript/ folder:  npx tsx ch10/weekly_report.ts

import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../comptoir/config.ts";
import { PYTHON } from "../comptoir/launch.ts";
import { compare, read, totals } from "../comptoir/sales.ts";
import { CODE_EXECUTION, call, producedFiles, toolErrors } from "../comptoir/server_tools.ts";

const SALES = join(PYTHON, "ch10", "data", "sales-2026-10-12.csv");
const OUTPUT = join("reports", "week-2026-10-12");

const INSTRUCTION = `Here is the export of the sales of Délices d'Awa for the week of October 12 to 18, 2026, a CSV file.
With code, and only with code (no figures from your head):
1. calculate the total revenue in FCFA (quantity × unit_price_fcfa), the number of distinct orders, the average basket rounded to the unit,
   and the revenue per product (quantity and amount), per day and per neighborhood;
2. plot the revenue per product as horizontal bars, readable on a phone, in chart.png;
3. produce report.pdf, one page in English: title, key figures, table per product, the chart;
4. write summary.json with exactly these keys: revenue_fcfa, orders, average_basket_fcfa,
   by_product (product -> {"quantity", "amount_fcfa"}), by_day (ISO date -> amount), by_neighborhood (neighborhood -> amount).
Copy chart.png, report.pdf and summary.json into $OUTPUT_DIR, then list that folder in the same command.
End with three sentences for Awa about the week.`;

const client = new Anthropic();
const sent = await client.files.upload({ file: await toFile(readFileSync(SALES), basename(SALES), { type: "text/csv" }) });
const produced: string[] = [];
try {
  const result = await call(client, {
    model: config.MODEL,
    max_tokens: 16000,
    tools: [CODE_EXECUTION],
    messages: [{ role: "user", content: [{ type: "container_upload", file_id: sent.id }, { type: "text", text: INSTRUCTION }] }],
  });
  console.log(result.text);
  for (const error of toolErrors(result.message)) console.log(`  ⚠ ${error}`);

  mkdirSync(OUTPUT, { recursive: true });
  for (const message of result.messages) produced.push(...producedFiles(message));
  for (const id of produced) {
    const name = (await client.files.retrieveMetadata(id)).filename;
    const response = await client.files.download(id);
    writeFileSync(join(OUTPUT, name), Buffer.from(await response.arrayBuffer()));
    console.log(`  file received: ${join(OUTPUT, name)}`);
  }

  const summary = join(OUTPUT, "summary.json");
  if (existsSync(summary)) {
    const gaps = compare(JSON.parse(readFileSync(summary, "utf8")), totals(read(SALES)));
    console.log("\nCheck by our code: " + (gaps.length ? "GAPS" : "all the figures match."));
    for (const gap of gaps) console.log(`  - ${gap}`);
  } else {
    console.log("\nNo summary.json: the report cannot be checked, so it is not sent.");
  }

  const usage = result.message.usage;
  console.log(
    `\n${result.calls} call(s), ${result.resumptions} resumption(s); last call: input ${usage.input_tokens} ` +
      `tokens, output ${usage.output_tokens}; cost in tokens $${result.cost.toFixed(4)}; ` +
      `container ${result.message.container?.id ?? "?"}`,
  );
} finally {
  // A file sent or produced stays stored as long as it is not deleted.
  for (const id of [sent.id, ...produced]) await client.files.delete(id);
  console.log("Files deleted from the Files API.");
}
