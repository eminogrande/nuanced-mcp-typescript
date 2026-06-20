// Graph -> Mermaid syntax conversion. Shared by the render_mermaid MCP tool
// and the standalone nuanced-viz CLI. Pure functions over the Graph type.

import type { Graph } from "./analyzer.js";

// Sanitize a string for use as a Mermaid node ID (strip dots, keep it readable).
function nodeId(key: string): string {
  return key.replace(/[^a-zA-Z0-9_]/g, "_");
}

// Short display name: last segment of the dotted key.
function shortName(key: string): string {
  return key.split(".").pop() ?? key;
}

// Flowchart: graph TD, each function is a node, callees are arrows.
// External/unresolved callees (not in subgraph) get a dashed node.
export function toFlowchart(subgraph: Graph, entrypointKey: string): string {
  const lines = ["graph TD"];
  const entryId = nodeId(entrypointKey);
  const inGraph = new Set(Object.keys(subgraph));

  // Style the entrypoint
  lines.push(`    ${entryId}["${shortName(entrypointKey)}"]`);
  lines.push(`    style ${entryId} fill:#4CAF50,color:#fff,stroke:#2E7D32,stroke-width:3px`);

  for (const [key, node] of Object.entries(subgraph)) {
    if (key === entrypointKey) continue;
    const id = nodeId(key);
    const name = shortName(key);
    lines.push(`    ${id}["${name}"]`);
  }

  // Edges
  for (const [key, node] of Object.entries(subgraph)) {
    const fromId = nodeId(key);
    for (const callee of node.callees ?? []) {
      if (inGraph.has(callee)) {
        const toId = nodeId(callee);
        // Skip self-loops in mermaid (they render poorly)
        if (fromId !== toId) {
          lines.push(`    ${fromId} --> ${toId}`);
        }
      } else {
        // External callee: dashed node + dashed edge
        const extId = nodeId("ext_" + callee);
        lines.push(`    ${extId}["${shortName(callee)}"]:::external`);
        lines.push(`    ${fromId} -.-> ${extId}`);
      }
    }
  }

  lines.push("    classDef external fill:#f9f9f9,stroke:#ccc,stroke-dasharray: 5 5");
  return lines.join("\n");
}

// Sequence diagram: participants are the entrypoint + transitive callees.
// Calls are solid arrows participant -> participant.
export function toSequence(subgraph: Graph, entrypointKey: string): string {
  const lines = ["sequenceDiagram"];
  const inGraph = new Set(Object.keys(subgraph));
  const entryName = shortName(entrypointKey);

  // Participants: entrypoint first, then callees in order of appearance
  const participants = [entrypointKey];
  const seen = new Set([entrypointKey]);
  for (const key of Object.keys(subgraph)) {
    if (key !== entrypointKey && !seen.has(key)) {
      participants.push(key);
      seen.add(key);
    }
  }

  for (const p of participants) {
    lines.push(`    participant ${nodeId(p)} as ${shortName(p)}`);
  }

  // Calls: iterate nodes, emit arrows for each callee that's in the graph
  for (const [key, node] of Object.entries(subgraph)) {
    const fromId = nodeId(key);
    for (const callee of node.callees ?? []) {
      if (inGraph.has(callee) && callee !== key) {
        const toId = nodeId(callee);
        lines.push(`    ${fromId}->>+${toId}: ${shortName(callee)}`);
        lines.push(`    ${toId}-->>-${fromId}: ok`);
      }
    }
  }

  return lines.join("\n");
}
