// The limits per network address (chapter 18; python/tests/test_ch18.py).

import assert from "node:assert/strict";
import { test } from "node:test";
import { RateLimiter, clientAddress } from "../comptoir/limits.ts";

test("the limiter counts over a sliding window", () => {
  let instant = 0;
  const limiter = new RateLimiter(3, 60, () => instant);
  assert.deepEqual([limiter.accept("a"), limiter.accept("a"), limiter.accept("a")], [null, null, null]);
  assert.equal(limiter.accept("a"), 60);
  assert.equal(limiter.accept("b"), null);
  instant = 61;
  assert.equal(limiter.accept("a"), null);
});

test("X-Forwarded-For is believed only from a trusted proxy", () => {
  assert.equal(clientAddress("203.0.113.9", "1.2.3.4", []), "203.0.113.9"); // anyone can write it
  assert.equal(clientAddress("127.0.0.1", "9.9.9.9, 1.2.3.4", ["127.0.0.1"]), "1.2.3.4"); // the last one, added by Caddy
  assert.equal(clientAddress(null, null, []), "unknown");
});
