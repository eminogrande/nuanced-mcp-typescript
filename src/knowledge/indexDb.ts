import { readFileSync, statSync } from "node:fs";
import { mkdirSync } from "node:fs";
// node:sqlite is bundled with Node 22+; no new dependency required.
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { excerptFor } from "./graph.js";

export interface IndexRelatedNode {
  id: string;
  type: string;
  label: string;
  path: string | null;
}

export interface IndexSearchHit {
  id: string;
  type: string;
  label: string;
  path: string | null;
  score: number;
  excerpt: string;
  related: IndexRelatedNode[];
}

interface StoredNode {
  id: string;
  type: string;
  label: string;
  text: string;
  path: string | null;
}

interface StoredEdge {
  from: string;
  to: string;
  type: string;
  weight: number;
}

interface StoredGraphFile {
  nodes: StoredNode[];
  edges: StoredEdge[];
}

const TYPE_BOOST: Record<string, number> = {
  decision: 4,
  claim: 4,
  preference: 4,
  memory: 4,
  transcript: 2.5,
  recording: 2.5,
  session: 2,
  turn: 2,
  project: 2,
  document: 2,
  entity: 1.5,
  task: 1.5,
  event: 1.5,
  file: 1,
  function: 1,
  prompt: 2,
};

function graphFingerprint(graphPath: string): string {
  const info = statSync(graphPath);
  return `${info.size}:${info.mtimeMs}`;
}

function quoteForTrigram(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}+_@.#-]+/u)) {
    const term = raw.trim();
    if (term.length < 2 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms.slice(0, 12);
}

export class BrainIndexDb {
  readonly path: string;
  private db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        path TEXT,
        text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS edges (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS edges_to ON edges(to_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  isFresh(graphPath: string): boolean {
    try {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'fingerprint'").get() as { value: string } | undefined;
      return row?.value === graphFingerprint(graphPath);
    } catch {
      return false;
    }
  }

  /** Rebuild from the canonical graph JSON when it changed. Returns node count indexed. */
  rebuildIfStale(graphPath: string): { rebuilt: boolean; nodes: number } {
    if (this.isFresh(graphPath)) return { rebuilt: false, nodes: this.nodeCount() };
    const raw = readFileSync(graphPath, "utf8");
    const graph: StoredGraphFile = JSON.parse(raw);
    this.rebuildFrom(graph, graphFingerprint(graphPath));
    return { rebuilt: true, nodes: this.nodeCount() };
  }

  rebuildFrom(graph: StoredGraphFile, fingerprint: string): void {
    this.db.exec("BEGIN;");
    try {
      this.db.exec(`
        DROP TABLE IF EXISTS chunks_fts;
        DELETE FROM nodes;
        DELETE FROM edges;
        DELETE FROM meta;
      `);
      const insertNode = this.db.prepare("INSERT OR REPLACE INTO nodes(id, type, label, path, text) VALUES (?, ?, ?, ?, ?)");
      let indexed = 0;
      for (const node of graph.nodes) {
        if (!node || node.type === "keyword") continue;
        insertNode.run(node.id, node.type, node.label ?? "", node.path ?? null, node.text ?? "");
        indexed += 1;
      }
      const insertEdge = this.db.prepare("INSERT INTO edges(from_id, to_id, type, weight) VALUES (?, ?, ?, ?)");
      for (const edge of graph.edges ?? []) {
        insertEdge.run(edge.from, edge.to, edge.type, edge.weight ?? 1);
      }
      this.db.exec(`
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
          label, text, path,
          content='nodes', content_rowid='rowid',
          tokenize='trigram'
        );
        INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');
      `);
      this.db.prepare("INSERT INTO meta(key, value) VALUES ('fingerprint', ?)").run(fingerprint);
      this.db.prepare("INSERT INTO meta(key, value) VALUES ('nodes', ?)").run(String(indexed));
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  nodeCount(): number {
    const row = this.db.prepare("SELECT count(*) AS count FROM nodes").get() as { count: number };
    return row.count;
  }

  search(query: string, limit = 20, types?: string[]): IndexSearchHit[] {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const match = terms.map(quoteForTrigram).join(" OR ");
    const typeFilter = types && types.length > 0
      ? ` AND n.type IN (${types.map(() => "?").join(", ")})`
      : "";
    const params: (string | number)[] = [match];
    if (types && types.length > 0) params.push(...types);
    params.push(Math.max(1, Math.min(limit, 100)) * 4);
    const rows = this.db.prepare(`
      SELECT n.id AS id, n.type AS type, n.label AS label, n.path AS path,
             substr(n.text, 1, 6000) AS text, bm25(chunks_fts) AS rank
      FROM chunks_fts
      JOIN nodes n ON n.rowid = chunks_fts.rowid
      WHERE chunks_fts MATCH ?${typeFilter}
      ORDER BY rank
      LIMIT ?
    `).all(...params) as unknown as Array<{ id: string; type: string; label: string; path: string | null; text: string; rank: number }>;

    const hits: IndexSearchHit[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const boost = TYPE_BOOST[row.type] ?? 1;
      const score = -row.rank * boost;
      hits.push({
        id: row.id,
        type: row.type,
        label: row.label,
        path: row.path,
        score,
        excerpt: excerptFor(row.text, query, 700),
        related: this.relatedNodes(row.id),
      });
      if (hits.length >= Math.max(1, Math.min(limit, 100))) break;
    }
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  private relatedNodes(id: string): IndexRelatedNode[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT n.id AS id, n.type AS type, n.label AS label, n.path AS path
      FROM edges e
      JOIN nodes n ON n.id = e.to_id OR n.id = e.from_id
      WHERE (e.from_id = ? OR e.to_id = ?) AND n.id != ? AND n.type != 'keyword'
      LIMIT 5
    `).all(id, id, id) as unknown as IndexRelatedNode[];
    return rows;
  }
}

export function defaultIndexPath(graphPath: string): string {
  return join(dirname(graphPath), "brain-index.sqlite");
}
