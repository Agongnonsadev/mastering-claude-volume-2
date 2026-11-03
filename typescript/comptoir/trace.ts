// Following each step of a processing: model, duration, cost, result (chapter 12).
//
// One trace per customer message. Each step (routing, extraction, answer…) records in it what it did, and
// a line goes into the log, with the trace's ID: we find, afterwards, why a message took a given path and
// what it cost.
//
// Like the log, the trace never holds the customer's text: only categories, codes and numbers.

import { randomId } from "./database.ts";
import { logEvent } from "./log.ts";
import { sum } from "./python.ts";
import { fixed, round } from "./rounding.ts";

export interface Step {
  name: string;
  model: string; //        “code” when no model is called
  durationMs: number;
  costDollars: number;
  result: string; //       a category, a code, a number: never the customer's text
  error: string | null;
}

/** What the current step fills in: its cost and its result. */
export class Recorder {
  constructor(readonly step: Step) {}

  record(cost = 0, result = ""): void {
    this.step.costDollars += cost;
    if (result) this.step.result = result;
  }
}

export class Trace {
  readonly id = randomId().slice(0, 12);
  readonly steps: Step[] = [];

  /**
   * A measured step: work() receives the recorder, and its duration is taken whatever happens. An error is
   * recorded by its name, then raised again (the with trace.step(…) of the Python version).
   */
  async step<T>(name: string, model: string, work: (r: Recorder) => T | Promise<T>): Promise<T> {
    const step: Step = { name, model, durationMs: 0, costDollars: 0, result: "", error: null };
    const start = performance.now();
    try {
      return await work(new Recorder(step));
    } catch (error) {
      step.error = (error as object | null)?.constructor?.name ?? typeof error;
      throw error;
    } finally {
      step.durationMs = round(performance.now() - start);
      this.keep(step);
    }
  }

  /** A step already measured elsewhere, for example a call made by the Tool Runner (chapter 13). */
  add(name: string, model: string, durationMs: number, costDollars: number, result = ""): void {
    this.keep({ name, model, durationMs, costDollars, result, error: null });
  }

  private keep(step: Step): void {
    this.steps.push(step);
    logEvent("step", {
      trace: this.id,
      step: step.name,
      model: step.model,
      duration_ms: step.durationMs,
      cost_dollars: round(step.costDollars, 6),
      result: step.result || null,
      error: step.error,
    });
  }

  get cost(): number {
    return sum(this.steps.map((s) => s.costDollars));
  }

  get durationMs(): number {
    return this.steps.reduce((total, s) => total + s.durationMs, 0);
  }

  show(): string {
    const lines = [`trace ${this.id}: ${this.steps.length} steps, ${fixed(this.durationMs / 1000, 1)} s, $${fixed(this.cost, 4)}`];
    for (const s of this.steps) {
      lines.push(
        `  ${s.name.padEnd(13)} ${s.model.padEnd(18)} ${fixed(s.durationMs / 1000, 1).padStart(5)} s  $${fixed(s.costDollars, 5)}  ` +
          `${s.result}${s.error ? `  ERROR ${s.error}` : ""}`,
      );
    }
    return lines.join("\n");
  }
}
