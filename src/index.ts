// MCP server: mirrors the surface of mattmorgis/nuanced-mcp but in TypeScript
// and able to analyze both Python (via `nuanced` subprocess) and TS/JS (native
// via ts-morph).

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, isAbsolute } from "node:path";
import { RepoRegistry, type Language } from "./graph/registry.js";
import {
  enrich,
  findDependents,
  findDirectCallers,
  findIndirectCallers,
  type Graph,
} from "./graph/analyzer.js";

const registry = new RepoRegistry();
const server = new McpServer(
  { name: "Nuanced", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  },
);

// ---- Tools --------------------------------------------------------------

server.registerTool(
  "initialize_graph",
  {
    description:
      "Initialize a code graph for the given repository path. Works for Python (via the nuanced library) or TypeScript/JavaScript (native via ts-morph).",
    inputSchema: {
      repo_path: z.string().describe("Path to the repository to analyze"),
      language: z
        .enum(["python", "typescript"])
        .default("python")
        .describe("Language of the repo: 'python' or 'typescript'"),
    },
  },
  async ({ repo_path, language }) => {
    const { errors, entry } = await registry.initialize(repo_path, language as Language);
    if (errors.length && !entry) {
      return text(`Error initializing code graph:\n${errors.join("\n")}`);
    }
    const fileCount = entry ? await registry.countSourceFiles(entry) : 0;
    const fnCount = entry ? Object.keys(entry.graph).length : 0;
    const errLine = errors.length ? `\nWarnings:\n${errors.join("\n")}` : "";
    return text(
      `Successfully initialized code graph for ${repo_path} (${language}).\n` +
        `Repository contains ${fileCount} source files and ${fnCount} tracked functions.\n` +
        `This is now the active repository.${errLine}`,
    );
  },
);

server.registerTool(
  "switch_repository",
  {
    description: "Switch to a different initialized repository.",
    inputSchema: { repo_path: z.string().describe("Path to the repository to switch to") },
  },
  async ({ repo_path }) => {
    const { errors, entry } = registry.switchTo(repo_path);
    if (errors.length) return text(errors.join("\n"));
    return text(`Successfully switched to repository: ${repo_path} (${entry?.language})`);
  },
);

server.registerTool(
  "list_repositories",
  { description: "List all initialized repositories.", inputSchema: {} },
  async () => {
    const { entries, activePath } = registry.list();
    if (entries.length === 0) return text("No repositories have been initialized yet.");
    const lines = entries.map((e) => {
      const prefix = e.repoPath === activePath ? "* " : "  ";
      return `${prefix}${e.repoPath} (${e.language}, ${Object.keys(e.graph).length} functions)`;
    });
    return text("Initialized repositories:\n" + lines.join("\n") + "\n\n* indicates active repository");
  },
);

server.registerTool(
  "get_function_call_graph",
  {
    description: "Get the call graph for a specific function.",
    inputSchema: {
      file_path: z.string().describe("Path to the file containing the function"),
      function_name: z.string().describe("Name of the function to analyze"),
      repo_path: z
        .string()
        .optional()
        .describe("Optional repository path (uses active repository if not specified)"),
    },
  },
  async ({ file_path, function_name, repo_path }) => {
    const entry = registry.get(repo_path);
    if (!entry) return text(repo_path ? `Error: Repository '${repo_path}' not initialized` : "Error: No active repository. Please initialize a graph first.");
    const abs = resolveFilePath(file_path, entry.repoPath);
    const e = enrich(entry.graph, abs, function_name);
    if (e.errors.length) return text("Errors retrieving call graph:\n" + e.errors.join("\n"));
    if (!e.result) return text(`Function '${function_name}' not found in '${file_path}'`);
    return text(formatEnrichmentResult(file_path, function_name, e.result));
  },
);

server.registerTool(
  "analyze_dependencies",
  {
    description:
      "Find all module or file dependencies in the codebase. Identifies all functions that depend on the specified file or module in the active repository.",
    inputSchema: {
      file_path: z.string().optional().describe("Path to a specific file to analyze dependencies for"),
      module_name: z.string().optional().describe("Name of a module to analyze dependencies for (matches dotted suffix)"),
    },
  },
  async ({ file_path, module_name }) => {
    const entry = registry.getActive();
    if (!entry) return text("Error: No active repository. Please initialize a graph first.");
    if (!file_path && !module_name) return text("Error: Please specify either file_path or module_name");

    const graph = entry.graph;
    let targetKeys: string[] = [];
    if (file_path) {
      const abs = resolveFilePath(file_path, entry.repoPath);
      targetKeys = Object.keys(graph).filter((k) => graph[k].filepath === abs);
    }
    if (module_name) {
      const extra = Object.keys(graph).filter(
        (k) => k.includes("." + module_name + ".") || k.startsWith(module_name + ".") || k.endsWith("." + module_name),
      );
      targetKeys = [...new Set([...targetKeys, ...extra])];
    }

    if (targetKeys.length === 0) {
      return text(file_path ? `No functions found in '${file_path}'` : `No functions found matching module '${module_name}'`);
    }

    const dependents = findDependents(graph, targetKeys);
    const header = `# Dependencies for ${file_path ? "file: " + file_path : "module: " + module_name}\n`;
    if (dependents.size === 0) {
      return text(`${header}\nNo dependencies found. This code is not used by other parts of the codebase.`);
    }

    const lines = [header, "The following code depends on this component:\n"];
    for (const [filepath, fns] of [...dependents.entries()].sort()) {
      const rel = registry.toRelPath(filepath, entry.repoPath);
      lines.push(`## ${rel}`);
      for (const fn of fns.sort()) lines.push(`- ${fn}`);
      lines.push("");
    }
    const total = [...dependents.values()].reduce((n, a) => n + a.length, 0);
    lines.push(`**Summary:** ${dependents.size} files with ${total} functions depend on this component`);
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "analyze_change_impact",
  {
    description: "Analyze the impact of changing a specific function.",
    inputSchema: {
      file_path: z.string().describe("Path to the file containing the function"),
      function_name: z.string().describe("Name of the function to analyze"),
    },
  },
  async ({ file_path, function_name }) => {
    const entry = registry.getActive();
    if (!entry) return text("Error: No active repository. Please initialize a graph first.");
    const abs = resolveFilePath(file_path, entry.repoPath);
    const e = enrich(entry.graph, abs, function_name);
    if (e.errors.length) return text("Errors analyzing impact:\n" + e.errors.join("\n"));
    if (!e.result) return text(`Function '${function_name}' not found in '${file_path}'`);

    const graph = entry.graph;
    const subgraph = e.result;
    const entrypointKey = Object.keys(subgraph).find((k) => k.endsWith("." + function_name));
    if (!entrypointKey) return text(`Error: Entry point function ${function_name} not found in subgraph`);

    const directCallers = findDirectCallers(graph, entrypointKey);
    const indirectCallers = findIndirectCallers(
      graph,
      directCallers.map((c) => c.key),
    );
    const potentialTests = new Set<string>();
    for (const c of [...directCallers, ...indirectCallers]) {
      const fp = c.node.filepath;
      if (/test/i.test(fp)) potentialTests.add(fp);
    }

    const lines: string[] = [
      `# Change Impact Analysis for ${function_name} in ${file_path}`,
      "",
      "This analysis helps you understand the potential impact of changing this function.",
      "",
      "## Direct Dependents",
      "These functions directly call the function you plan to change:",
      "",
    ];

    if (directCallers.length) {
      const byFile = groupByFile(directCallers);
      for (const [fp, callers] of [...byFile.entries()].sort()) {
        lines.push(`### ${registry.toRelPath(fp, entry.repoPath)}`);
        for (const c of callers) lines.push(`- ${c.key.split(".").pop()} (line ${c.node.lineno ?? "?"})`);
        lines.push("");
      }
    } else {
      lines.push("No direct dependents found. This function is not called directly by other functions.\n");
    }

    lines.push("## Indirect Dependents", "These functions indirectly depend on the function through the call chain:\n");
    if (indirectCallers.length) {
      const byDepth = new Map<number, typeof indirectCallers>();
      for (const c of indirectCallers) {
        const arr = byDepth.get(c.depth) ?? [];
        arr.push(c);
        byDepth.set(c.depth, arr);
      }
      for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
        lines.push(`### Depth ${depth} (Call Chain Length)`);
        for (const c of (byDepth.get(depth) ?? []).sort((a, b) => a.key.localeCompare(b.key))) {
          lines.push(`- ${c.key.split(".").pop()} in ${registry.toRelPath(c.node.filepath, entry.repoPath)}`);
        }
        lines.push("");
      }
    } else {
      lines.push("No indirect dependents found.\n");
    }

    if (potentialTests.size) {
      lines.push("## Potential Tests Affected", "These test files might need updates:\n");
      for (const t of [...potentialTests].sort()) lines.push(`- ${registry.toRelPath(t, entry.repoPath)}`);
      lines.push("");
    }

    const totalImpact = directCallers.length + indirectCallers.length;
    const impactLevel = totalImpact > 10 ? "High" : totalImpact > 3 ? "Medium" : "Low";
    lines.push(
      "## Impact Summary",
      `- **Impact Level**: ${impactLevel}`,
      `- **Direct Dependents**: ${directCallers.length}`,
      `- **Indirect Dependents**: ${indirectCallers.length}`,
      `- **Potential Tests Affected**: ${potentialTests.size}`,
      "",
      "## Recommendations",
    );
    if (impactLevel === "High") {
      lines.push(
        "- Consider breaking the change into smaller, incremental changes",
        "- Implement thorough tests before changing the function",
        "- Communicate the change to other developers",
        "- Document all breaking changes carefully",
      );
    } else if (impactLevel === "Medium") {
      lines.push(
        "- Maintain backward compatibility if possible",
        "- Test all direct dependent functions",
        "- Consider deprecation warnings before removing functionality",
      );
    } else {
      lines.push("- Proceed with changes while maintaining the same function signature if possible", "- Update related tests");
    }

    return text(lines.join("\n"));
  },
);

// ---- Resources ----------------------------------------------------------

server.registerResource(
  "summary",
  "graph://summary",
  { description: "Summary of the currently loaded code graph" },
  async (uri) => resourceText(uri.href, await graphSummary(registry.getActive())),
);

server.registerResource(
  "repo_summary",
  new ResourceTemplate("graph://repo/{repo_path}/summary", { list: undefined }),
  { description: "Summary of a specific repository's code graph" },
  async (uri, { repo_path }) => {
    const entry = registry.get(String(repo_path));
    if (!entry) return resourceText(uri.href, `Repository '${repo_path}' not initialized`);
    return resourceText(uri.href, await graphSummary(entry));
  },
);

server.registerResource(
  "function_details",
  new ResourceTemplate("graph://function/{file_path}/{function_name}", { list: undefined }),
  { description: "Detailed information about a specific function" },
  async (uri, { file_path, function_name }) => {
    const entry = registry.getActive();
    if (!entry) return resourceText(uri.href, "No code graph has been initialized yet.");
    const abs = resolveFilePath(String(file_path), entry.repoPath);
    const e = enrich(entry.graph, abs, String(function_name));
    if (e.errors.length) return resourceText(uri.href, "Errors retrieving function details:\n" + e.errors.join("\n"));
    if (!e.result) return resourceText(uri.href, `Function '${function_name}' not found in '${file_path}'`);
    return resourceText(uri.href, formatResourceResult(String(file_path), String(function_name), e.result));
  },
);

// ---- Prompts ------------------------------------------------------------

server.registerPrompt(
  "analyze_function",
  {
    description: "Create a prompt to analyze a function with its call graph.",
    argsSchema: {
      file_path: z.string(),
      function_name: z.string(),
    },
  },
  ({ file_path, function_name }) =>
    promptResult(analyzeFunctionPrompt(String(file_path), String(function_name))),
);

server.registerPrompt(
  "impact_analysis",
  {
    description: "Create a prompt to analyze the impact of changing a function.",
    argsSchema: { file_path: z.string(), function_name: z.string() },
  },
  ({ file_path, function_name }) =>
    promptResult(impactAnalysisPrompt(String(file_path), String(function_name))),
);

server.registerPrompt(
  "analyze_dependencies_prompt",
  {
    description: "Create a prompt to analyze dependencies of a file or module.",
    argsSchema: { file_path: z.string().optional(), module_name: z.string().optional() },
  },
  ({ file_path, module_name }) =>
    promptResult(
      analyzeDependenciesPrompt(file_path ? String(file_path) : undefined, module_name ? String(module_name) : undefined),
    ),
);

// ---- Helpers ------------------------------------------------------------

function resolveFilePath(file_path: string, repoRoot: string): string {
  return isAbsolute(file_path) ? resolve(file_path) : resolve(repoRoot, file_path);
}

async function graphSummary(entry: ReturnType<RepoRegistry["getActive"]>): Promise<string> {
  if (!entry) return "No code graph has been initialized yet.";
  const fileCount = await registry.countSourceFiles(entry);
  const fnCount = Object.keys(entry.graph).length;
  return [
    "# Code Graph Summary",
    "",
    `- Repository: ${entry.repoPath}`,
    `- Language: ${entry.language}`,
    `- Source files: ${fileCount}`,
    `- Functions tracked: ${fnCount}`,
    "",
    "## Usage",
    "",
    "To analyze specific functions:",
    "",
    `1. Use the \`get_function_call_graph\` tool with:`,
    `   - file_path: Path to the source file`,
    `   - function_name: Name of the function to analyze`,
    "",
    "## Available Resources",
    "",
    "- `graph://summary`: This summary",
    "- `graph://function/{file_path}/{function_name}`: Get details for a specific function",
  ].join("\n");
}

function formatEnrichmentResult(file_path: string, function_name: string, subgraph: Graph): string {
  const entrypointKey = Object.keys(subgraph).find((k) => k.endsWith("." + function_name));
  if (!entrypointKey) return `Error: Entry point function ${function_name} not found in subgraph`;
  const node = subgraph[entrypointKey];
  const directCallees = (node.callees ?? []).map((c) => c.split(".").pop()!);
  const callers = Object.entries(subgraph)
    .filter(([k, n]) => k !== entrypointKey && (n.callees ?? []).includes(entrypointKey))
    .map(([k]) => k.split(".").pop()!);

  const lines = [
    `## Function Call Graph for '${function_name}' in ${file_path}`,
    "",
    "### Function Information",
    `- Full path: ${entrypointKey}`,
    `- Filepath: ${node.filepath ?? "Unknown"}`,
    `- Line number: ${node.lineno ?? "Unknown"}`,
    "",
    "### Direct Function Calls",
  ];
  lines.push(...(directCallees.length ? directCallees.map((n) => `- ${n}`) : ["- No direct function calls found"]));
  lines.push("", "### Called By");
  lines.push(...(callers.length ? callers.map((n) => `- ${n}`) : ["- Not called by any other functions in the analyzed code"]));
  lines.push("", "### Full Call Graph (JSON)", "```json", JSON.stringify(subgraph, null, 2), "```");
  return lines.join("\n");
}

function formatResourceResult(file_path: string, function_name: string, subgraph: Graph): string {
  const entrypointKey = Object.keys(subgraph).find((k) => k.endsWith("." + function_name));
  if (!entrypointKey) return `Error: Entry point function ${function_name} not found in subgraph`;
  const node = subgraph[entrypointKey];
  const calleeDetails = (node.callees ?? []).map((c) => {
    const cn = subgraph[c];
    const name = c.split(".").pop()!;
    return cn ? `- ${name} (in ${cn.filepath}:${cn.lineno ?? "?"})` : `- ${name} (external)`;
  });
  const callers = Object.entries(subgraph)
    .filter(([k, n]) => k !== entrypointKey && (n.callees ?? []).includes(entrypointKey))
    .map(([k, n]) => `- ${k.split(".").pop()!} (in ${n.filepath}:${n.lineno ?? "?"})`);

  const lines = [
    `# Function: ${function_name}`,
    "",
    `**File:** ${file_path}`,
    `**Line:** ${node.lineno ?? "Unknown"}`,
    `**Full path:** ${entrypointKey}`,
    "",
    "## Calls",
  ];
  lines.push(...(calleeDetails.length ? calleeDetails : ["- This function doesn't call any other functions"]));
  lines.push("", "## Called By");
  lines.push(...(callers.length ? callers : ["- Not called by any other functions in the analyzed code"]));
  return lines.join("\n");
}

function groupByFile(callers: Array<{ key: string; node: Graph[string] }>): Map<string, Array<{ key: string; node: Graph[string] }>> {
  const m = new Map<string, Array<{ key: string; node: Graph[string] }>>();
  for (const c of callers) {
    const arr = m.get(c.node.filepath) ?? [];
    arr.push(c);
    m.set(c.node.filepath, arr);
  }
  return m;
}

function analyzeFunctionPrompt(file_path: string, function_name: string): string {
  return `Please analyze the function '${function_name}' in file '${file_path}'.

First, I need to understand how this function fits into the codebase. Please use the 'get_function_call_graph' tool to retrieve the call graph for this function.

Once you have the call graph, please analyze:

1. What does this function do? (based on its name and call patterns)
2. What other functions does it call? What is the purpose of each call?
3. Which parts of the codebase call this function? In what contexts is it used?
4. Is this a central/critical function in the codebase?
5. What potential bugs or optimization opportunities do you see?

Please provide a comprehensive analysis that helps me understand both the function itself and its role in the broader codebase.`;
}

function impactAnalysisPrompt(file_path: string, function_name: string): string {
  return `I'm planning to modify the function '${function_name}' in file '${file_path}'.

Please use the 'analyze_change_impact' tool to get a detailed impact analysis for this function.
This will show me which parts of the codebase would be affected by my changes.

Alternatively, you can use the 'get_function_call_graph' tool to retrieve the basic call graph.

Please analyze:

1. Which other parts of the codebase depend on this function?
2. If I change the function signature, what code will need to be updated?
3. Are there any functions that might be particularly sensitive to changes in this function?
4. What tests might I need to update if I modify this function?
5. Based on the call graph, what would be a safe approach to refactoring this function?

Please provide a comprehensive impact analysis to help me plan my changes safely.`;
}

function analyzeDependenciesPrompt(file_path?: string, module_name?: string): string {
  const target = file_path ? `file '${file_path}'` : `module '${module_name}'`;
  return `I need to understand which parts of the codebase depend on ${target}. This will help me
assess the impact of making changes to this component.

Please use the 'analyze_dependencies' tool to see all the code that depends on this component.
If you need to see specific function details, you can also use 'get_function_call_graph'.

Once you have the dependency information, please help me understand:

1. How extensively is this component used throughout the codebase?
2. Are there any unexpected dependencies that I should be aware of?
3. Which areas of the codebase would be most affected if I make changes?
4. Can you identify any potential refactoring opportunities to reduce tight coupling?
5. Should I be concerned about making changes to this component?

Please provide a thorough analysis to help me make informed decisions about modifying this code.`;
}

// MCP result-shape helpers
function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}
function resourceText(uri: string, content: string) {
  return { contents: [{ uri, text: content }] };
}
function promptResult(message: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text: message } }] };
}

// ---- Entrypoint ---------------------------------------------------------

export { server };

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run when invoked directly, not when imported by tests.
const isMain = (() => {
  try {
    return process.argv[1] && (process.argv[1].endsWith("index.js") || process.argv[1].endsWith("dist/index.js"));
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((err) => {
    console.error("Server error:", err);
    process.exit(1);
  });
}
