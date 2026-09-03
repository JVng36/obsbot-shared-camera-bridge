import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { OllamaVision } from "../src/ollama-vision.js";

test("vision sends the frame only to loopback Ollama with privacy instructions", async () => {
  let request;
  const vision = new OllamaVision({
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3-vl:8b",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        message: { content: " A person is seated near a desk. " },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const description = await vision.describe({
    imageBase64: "PRIVATE_IMAGE",
    mime: "image/jpeg",
    question: "What is directly visible?",
    signal: new AbortController().signal,
  });

  assert.equal(description, "A person is seated near a desk.");
  assert.equal(request.url, "http://127.0.0.1:11434/api/chat");
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "qwen3-vl:8b");
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.equal(request.options.redirect, "error");
  assert.equal(body.messages[0].role, "system");
  assert.equal("images" in body.messages[0], false);
  assert.match(body.messages[0].content, /ignore.*text.*instructions/i);
  assert.match(body.messages[0].content, /do not infer.*emotion/i);
  assert.equal(body.messages[1].role, "user");
  assert.deepEqual(body.messages[1].images, ["PRIVATE_IMAGE"]);
  assert.match(body.messages[1].content, /What is directly visible\?/);
});

test("vision uses a live caller-supplied system prompt", async () => {
  let body;
  const vision = new OllamaVision({
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ message: { content: "Experimental result" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await vision.describe({
    imageBase64: "PRIVATE_IMAGE",
    mime: "image/jpeg",
    question: "What is visible?",
    systemPrompt: "Respond like an excitable stage director.",
  });

  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[0].content, "Respond like an excitable stage director.");
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

for (const redirectCode of [307, 308]) {
  test(`vision refuses HTTP ${redirectCode} without forwarding the frame body`, async () => {
    const receivedBodies = [];
    const receiver = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      receivedBodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: { content: "should not happen" } }));
    });
    const receiverPort = await listen(receiver);
    const redirector = createServer((_request, response) => {
      response.writeHead(redirectCode, {
        location: `http://127.0.0.1:${receiverPort}/sink`,
      });
      response.end();
    });
    const redirectorPort = await listen(redirector);

    try {
      const vision = new OllamaVision({
        baseUrl: `http://127.0.0.1:${redirectorPort}`,
        model: "qwen3-vl:8b",
      });
      await assert.rejects(
        () => vision.describe({
          imageBase64: "PRIVATE_REDIRECT_MARKER",
          mime: "image/jpeg",
          question: "What is visible?",
        }),
        /fetch failed|redirect/i,
      );
      assert.deepEqual(receivedBodies, []);
    } finally {
      await close(redirector);
      await close(receiver);
    }
  });
}

test("vision refuses a non-loopback inference URL", () => {
  assert.throws(
    () => new OllamaVision({ baseUrl: "https://vision.example.com", model: "qwen3-vl:8b" }),
    /loopback/i,
  );
});

test("vision rejects an oversized local response before returning content", async () => {
  const oversized = JSON.stringify({ message: { content: "x".repeat(20_000) } });
  const vision = new OllamaVision({
    fetchImpl: async () => new Response(oversized, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  await assert.rejects(
    vision.describe({
      imageBase64: "PRIVATE_IMAGE",
      mime: "image/jpeg",
      question: "What is visible?",
    }),
    /local vision response exceeded/i,
  );
});
