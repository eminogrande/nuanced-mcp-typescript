// Registry: holds initialized graphs keyed by absolute repo path, tracks the
// active repo, and dispatches init to the right backend based on language.

import { resolve, relative, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import type { Graph } from "./analyzer.js";
import { initPythonGraph } from "./pythonBackend.js";
import { initTsGraph } from "./tsBackend.js";

export type Language = "python" | "typescript";

export interface RepoEntry {
  repoPath: string; // absolute
  language: Language;
  graph: Graph;
}

export interface InitResult {
  errors: string[];
  entry: RepoEntry | null;
}

export class RepoRegistry {
  private repos = new Map<string, RepoEntry>();
  private active: string | null = null;

  async initialize(repoPath: string, language: Language): Promise<InitResult> {
    const abs = resolve(repoPath);
    if (!existsSync(abs)) {
      return { errors: [`Path '${repoPath}' does not exist`], entry: null };
    }

    let graph: Graph;
    let errors: string[];
    if (language === "python") {
      ({ graph, errors } = await initPythonGraph(abs));
    } else {
      ({ graph, errors } = await initTsGraph(abs));
    }

    if (errors.length > 0 && Object.keys(graph).length === 0) {
      return { errors, entry: null };
    }

    const entry: RepoEntry = { repoPath: abs, language, graph };
    this.repos.set(abs, entry);
    this.active = abs;
    return { errors, entry };
  }

  switchTo(repoPath: string): { errors: string[]; entry: RepoEntry | null } {
    const abs = resolve(repoPath);
    const entry = this.repos.get(abs);
    if (!entry) {
      return {
        errors: [`Repository at '${repoPath}' has not been initialized. Use initialize_graph first.`],
        entry: null,
      };
    }
    this.active = abs;
    return { errors: [], entry };
  }

  list(): { entries: RepoEntry[]; activePath: string | null } {
    return { entries: [...this.repos.values()], activePath: this.active };
  }

  getActive(): RepoEntry | null {
    if (!this.active) return null;
    return this.repos.get(this.active) ?? null;
  }

  get(repoPath?: string): RepoEntry | null {
    if (!repoPath) return this.getActive();
    const abs = resolve(repoPath);
    return this.repos.get(abs) ?? null;
  }

  // Count source files for a repo by language, for summary text.
  // ponytail: uses graph node count as a proxy to avoid a filesystem walk.
  // Ceiling: an empty function still counts as tracked; fine for summaries.
  async countSourceFiles(entry: RepoEntry): Promise<number> {
    const files = new Set<string>();
    for (const node of Object.values(entry.graph)) files.add(node.filepath);
    return files.size;
  }

  toRelPath(absPath: string, root: string): string {
    return isAbsolute(absPath) && absPath.startsWith(root) ? relative(root, absPath) : absPath;
  }
}
