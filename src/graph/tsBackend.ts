// TS/JS backend: builds a `Graph` natively from TypeScript/JavaScript source
// using ts-morph. No Python dependency. Matches the `nuanced` graph schema:
//   key = dotted module path (e.g. "src.auth.login")
//   value = { filepath, callees: [...], lineno, end_lineno }

import {
  Project,
  SyntaxKind,
  type SourceFile,
  type Node,
  type FunctionDeclaration,
  type MethodDeclaration,
  type ArrowFunction,
  type FunctionExpression,
  type PropertyAccessExpression,
  type CallExpression,
  type ClassDeclaration,
  type Symbol as TsSymbol,
} from "ts-morph";
import { relative, resolve, sep } from "node:path";
import { stat } from "node:fs/promises";
import type { Graph, GraphNode } from "./analyzer.js";

// Union of the concrete function-like declarations ts-morph exposes. Each
// member has the full Node API (getSourceFile, getStartLineNumber, etc.).
type FnDecl = FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression;

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export interface TsBackendOptions {
  // file globs relative to repo root, e.g. ["src/**\/*.ts"]. Defaults to all
  // supported extensions under the repo.
  include?: string[];
  exclude?: string[];
}

export async function initTsGraph(repoPath: string, opts: TsBackendOptions = {}): Promise<{ graph: Graph; errors: string[] }> {
  const errors: string[] = [];
  const absRepo = resolve(repoPath);
  const st = await stat(absRepo).catch(() => null);
  if (!st || !st.isDirectory()) {
    errors.push(`Path is not a directory: ${absRepo}`);
    return { graph: {}, errors };
  }

  const include = opts.include ?? TS_EXTENSIONS.map((ext) => `**/*${ext}`);
  const exclude = opts.exclude ?? ["node_modules/**", "dist/**", "build/**", ".git/**"];

  const project = new Project({
    tsConfigFilePath: undefined,
    compilerOptions: {
      allowJs: true,
      jsx: 2, // ts.JsxEmit.Preserve
      declaration: false,
      skipLibCheck: true,
      noEmit: true,
    },
    skipAddingFilesFromTsConfig: true,
  });

  // Add files explicitly so we don't need a tsconfig.
  const added = project.addSourceFilesAtPaths(include.map((p) => joinGlob(absRepo, p)));
  // Exclude by directory segment: a filepath matches an exclude rule if any
  // of its path segments equals the exclude dir name. Simpler and more robust
  // than glob->regex conversion.
  const excludeDirs = exclude.flatMap((p) => p.split("/")).filter((s) => s && !s.includes("*"));
  const files = added.filter((f) => {
    const fp = f.getFilePath();
    return !excludeDirs.some((d) => fp.includes("/" + d + "/"));
  });
  if (files.length === 0) {
    errors.push(`No TypeScript/JavaScript files found in ${absRepo}`);
    return { graph: {}, errors };
  }

  const graph: Graph = {};

  // First pass: collect every function-like declaration with a stable dotted
  // key, so callees in pass 2 can resolve to those keys.
  const keyToDecl = new Map<string, FnDecl>();
  const declToKey = new Map<FnDecl, string>();

  for (const sf of files) {
    collectFunctions(sf, absRepo, keyToDecl, declToKey);
  }

  // Second pass: resolve callees of each function to dotted keys when possible.
  for (const [key, decl] of keyToDecl) {
    const callees = resolveCallees(decl, keyToDecl, declToKey);
    graph[key] = {
      filepath: decl.getSourceFile().getFilePath(),
      callees,
      lineno: decl.getStartLineNumber(),
      end_lineno: decl.getEndLineNumber(),
    };
  }

  return { graph, errors };
}

function collectFunctions(
  sf: SourceFile,
  repoRoot: string,
  keyToDecl: Map<string, FnDecl>,
  declToKey: Map<FnDecl, string>,
): void {
  const decls: FnDecl[] = [
    ...sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...sf.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
    ...sf.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sf.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  ];

  for (const d of decls) {
    const key = buildKey(d, repoRoot);
    if (!key) continue;
    // first definition wins; duplicates get suffixed so we never lose data
    let finalKey = key;
    let i = 2;
    while (keyToDecl.has(finalKey)) {
      finalKey = `${key}__${i++}`;
    }
    keyToDecl.set(finalKey, d);
    declToKey.set(d, finalKey);
  }
}

function buildKey(decl: FnDecl, repoRoot: string): string | null {
  const sf = decl.getSourceFile();
  const filePath = sf.getFilePath();
  const rel = relative(repoRoot, filePath).split(sep).join("/");
  // strip extension
  const noExt = rel.replace(/\.(t|j)sx?$/, "").replace(/\.(m|c)js$/, "");
  const dotted = noExt.replace(/[/\\]/g, ".");

  const name = (decl as FunctionDeclaration).getName?.();
  // method: include class name for readability
  const parent = decl.getParent();
  const className = parent && parent.getKind() === SyntaxKind.ClassDeclaration
    ? (parent as ClassDeclaration).getName()
    : null;

  const fnName = name ?? "<anonymous>";
  if (className) {
    return `${dotted}.${className}.${fnName}`;
  }
  return `${dotted}.${fnName}`;
}

function resolveCallees(
  decl: FnDecl,
  keyToDecl: Map<string, FnDecl>,
  declToKey: Map<FnDecl, string>,
): string[] {
  const callees: string[] = [];
  const seen = new Set<string>();

  // Walk the function body for CallExpression identifiers.
  const calls = decl.getDescendantsOfKind(SyntaxKind.CallExpression) as CallExpression[];
  for (const call of calls) {
    const expr = call.getExpression();
    let name: string | null = null;
    if (expr.getKind() === SyntaxKind.Identifier) {
      name = expr.getText();
    } else if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      // foo.bar.baz -> use last segment; we resolve via symbol if available
      const sym = (expr as PropertyAccessExpression).getSymbol();
      if (sym) {
        name = sym.getName();
      } else {
        name = expr.getText();
      }
    }

    if (!name) continue;

    // Try to resolve to a known declaration key.
    const resolved = resolveByName(name, call, keyToDecl, declToKey);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      callees.push(resolved);
    } else if (name && !seen.has(name)) {
      // Unresolved call: keep the bare name so it still appears in the graph.
      seen.add(name);
      callees.push(name);
    }
  }

  return callees;
}

function resolveByName(
  name: string,
  call: CallExpression,
  keyToDecl: Map<string, FnDecl>,
  declToKey: Map<FnDecl, string>,
): string | null {
  // Prefer TS symbol resolution when the identifier refers to a local/imported
  // function we tracked.
  const expr = call.getExpression();
  const sym: TsSymbol | undefined = expr.getSymbol?.();
  if (sym) {
    const decls = sym.getDeclarations();
    for (const d of decls) {
      // climb to enclosing function-like declaration
      let node: Node | undefined = d;
      while (node && !declToKey.has(node as unknown as FnDecl)) {
        node = node.getParent();
        if (!node) break;
      }
      if (node && declToKey.has(node as unknown as FnDecl)) {
        return declToKey.get(node as unknown as FnDecl)!;
      }
    }
  }

  // Fallback: match by trailing ".name" against known keys.
  const suffix = "." + name;
  for (const k of keyToDecl.keys()) {
    if (k.endsWith(suffix)) return k;
  }
  return null;
}

function joinGlob(root: string, glob: string): string {
  if (glob.startsWith("/")) return glob;
  return `${root}/${glob}`;
}
