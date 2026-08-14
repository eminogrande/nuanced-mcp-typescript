import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const child = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
let nextID = 1;
const waiting = new Map<number, (value: any) => void>();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)!(message);
      waiting.delete(message.id);
    }
  }
});

function request(method: string, params: unknown = {}): Promise<any> {
  const id = nextID++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => waiting.set(id, resolve));
}

try {
  const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "selfcheck", version: "1" } });
  assert.equal(init.result.serverInfo.name, "Nuanced");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await request("tools/list");
  const names = listed.result.tools.map((tool: any) => tool.name);
  for (const name of ["initialize_graph", "knowledge_ingest", "knowledge_search", "knowledge_stats"]) assert.ok(names.includes(name), `${name} listed`);
  const ingest = await request("tools/call", { name: "knowledge_ingest", arguments: { reset: true, include_initialized_repositories: false } });
  const result = JSON.parse(ingest.result.content[0].text);
  assert.ok(result.recordings >= 1, "DICTATOR recordings ingested");
  const search = await request("tools/call", { name: "knowledge_search", arguments: { query: "auto paste", limit: 10 } });
  const found = JSON.parse(search.result.content[0].text);
  assert.ok(Array.isArray(found.results), "knowledge search returns results");
  console.log(`ok: ${names.length} tools; ${result.recordings} recordings; ${result.nodes} nodes; ${result.edges} edges`);
} finally {
  child.kill();
}
