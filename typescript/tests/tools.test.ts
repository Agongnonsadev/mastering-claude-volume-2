// The tools' definitions, and their execution without an exception toward the loop
// (python/tests/test_tools.py).

import assert from "node:assert/strict";
import { test } from "node:test";
import { Shop } from "../comptoir/shop.ts";
import { Execution, TOOLS, Tools, toJson } from "../comptoir/tools.ts";

type Schema = { type?: string; properties?: Record<string, Schema>; items?: Schema; required?: string[]; additionalProperties?: boolean };

/** All the objects of a schema, nested ones included. */
function* objects(schema: Schema): Generator<Schema> {
  if (schema.type === "object") {
    yield schema;
    for (const property of Object.values(schema.properties ?? {})) yield* objects(property);
  }
  if (schema.type === "array" && schema.items) yield* objects(schema.items);
}

test("strict and well-described definitions", () => {
  for (const tool of TOOLS) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,128}$/);
    assert.equal(tool.strict, true);
    // Anthropic advises at least three or four sentences per description.
    assert.ok(tool.description!.split(". ").length >= 3, tool.name);
    for (const o of objects(tool.input_schema as Schema)) {
      assert.equal(o.additionalProperties, false);
      assert.deepEqual(new Set(o.required), new Set(Object.keys(o.properties ?? {})));
    }
  }
});

const call = (name: string, input: unknown, id = "toolu_1") => ({ id, name, input });

test("the stock of several products", () => {
  const result = new Tools(new Shop(), "c1").execute(call("stock_check", { products: ["Pineapple juice", "Mango juice"] }), new Execution());
  assert.deepEqual(JSON.parse(String(result.content)), { "Pineapple juice": 12, "Mango juice": "missing from the catalog" });
  assert.ok(!("is_error" in result));
});

test("a shop error becomes a result in error", () => {
  const input = { lines: [{ product: "Mango juice", quantity: 3 }], customer_name: "A", neighborhood: "B" };
  const result = new Tools(new Shop(), "c1").execute(call("order_prepare", input), new Execution());
  assert.equal(result.is_error, true);
  assert.match(String(result.content), /missing from the catalog/);
});

test("Claude does not receive the confirmation code", () => {
  const execution = new Execution();
  const input = { lines: [{ product: "Bissap juice", quantity: 6 }], customer_name: "A", neighborhood: "B" };
  const result = JSON.parse(String(new Tools(new Shop(), "c1").execute(call("order_prepare", input), execution).content));
  assert.ok(!("confirmation_code" in result));
  assert.equal(result.total_fcfa, 6000);
  assert.ok(execution.summary?.confirmation_code); // the code, for its part, keeps it to display it
});

test("an unknown tool", () => {
  const result = new Tools(new Shop(), "c1").execute(call("order_create", {}), new Execution());
  assert.ok(result.is_error);
  assert.match(String(result.content), /Unknown/);
});

test("the pass-on to Awa", () => {
  const shop = new Shop();
  const execution = new Execution();
  new Tools(shop, "c1").execute(call("pass_to_awa", { reason: "discount", summary: "20% for 10 bottles" }), execution);
  assert.deepEqual([shop.requests()[0]!.conversation, shop.requests()[0]!.reason], ["c1", "discount"]);
  assert.equal(execution.passedOn.length, 1);
});

test("a tool result is written like Python's json.dumps", () => {
  assert.equal(toJson({ "Awa's juice": 12, list: [1, "Fidjrossè"], empty: null }), '{"Awa\'s juice": 12, "list": [1, "Fidjrossè"], "empty": null}');
});
