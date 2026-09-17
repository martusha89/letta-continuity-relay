import test from "node:test";
import assert from "node:assert/strict";
import { readBoundedBody } from "../build/http-body.js";

test("bounded response reader accepts small streamed bodies", async () => {
  const response = new Response(new Blob(["hello"]));
  assert.equal((await readBoundedBody(response, 5, "Test body")).toString(), "hello");
});

test("bounded response reader rejects declared and streamed overflow", async () => {
  const declared = new Response("too large", { headers: { "Content-Length": "100" } });
  await assert.rejects(readBoundedBody(declared, 5, "Test body"), /byte limit/);

  const streamed = new Response(new Blob(["too large"]));
  await assert.rejects(readBoundedBody(streamed, 5, "Test body"), /byte limit/);
});

test("bounded response reader rejects malformed declared lengths", async () => {
  const malformed = new Response("hello", { headers: { "Content-Length": "-1" } });
  await assert.rejects(readBoundedBody(malformed, 5, "Test body"), /invalid Content-Length/);
});
