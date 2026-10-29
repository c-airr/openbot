// Fork: reads the sessions that Cursor, Codex, Claude Code and OpenCode keep on this computer.
//
// Every reader is read-only and best effort: a missing folder or a format that moved on gives an
// empty list for that app, never an error for the others. OpenBot's own chats are left out, because
// the apps also record the sessions OpenBot starts in `OpenBot/Agents/<id>`.

import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { ImportableSession, SessionImportSource } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";

export interface SessionTurn {
  role: "user" | "assistant";
  text: string;
}

export interface SessionTranscript {
  session: ImportableSession;
  turns: SessionTurn[];
}

/** Where a listed session lives, kept beside the public row. */
interface Locator {
  session: ImportableSession;
  /** The file, or the database for the sources that keep sessions in one. */
  path: string;
  id: string;
}

const HEAD_BYTES = 512 * 1024;
const TITLE_LENGTH = 80;
const USER_TURN_LIMIT = 8_000;
const ASSISTANT_TURN_LIMIT = 4_000;

/** The key of the last listing, so a transcript read does not scan the disk again. */
let known = new Map<string, Locator>();

const cursorChats = () => join(homedir(), ".cursor", "chats");
const cursorIdeDatabase = () =>
  join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
const codexSessions = () => join(homedir(), ".codex", "sessions");
const claudeProjects = () => join(homedir(), ".claude", "projects");
const openCodeDatabase = () => join(homedir(), ".local", "share", "opencode", "opencode.db");
/** The Antigravity IDE and its CLI keep the same layout under different roots. */
const antigravityRoots = () => [
  join(homedir(), ".gemini", "antigravity"),
  join(homedir(), ".gemini", "antigravity-cli"),
];

const isOpenBotWorkspace = (cwd: string | null) => cwd !== null && /[\\/]OpenBot[\\/]Agents[\\/]/iu.test(cwd);

const shorten = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

const titleOf = (text: string) => shorten(text.replace(/\s+/gu, " ").trim(), TITLE_LENGTH);

/** The wrappers apps put around a user turn: reminders, environment blocks, tool echoes. */
const isScaffolding = (text: string) =>
  text.startsWith("<") || text.startsWith("# AGENTS.md") || text.startsWith("Caveat:") || text.trim() === "";

/** A user turn from Cursor wraps the words in `<user_query>`. */
function cursorUserText(text: string): string {
  const match = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/u.exec(text);
  return (match?.[1] ?? text).trim();
}

function row(
  source: SessionImportSource,
  id: string,
  fields: Omit<ImportableSession, "key" | "source">,
): ImportableSession {
  return { key: `${source}:${id}`, source, ...fields };
}

async function head(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseLines(text: string): DynamicRecord[] {
  const records: DynamicRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (isDynamicRecord(parsed)) records.push(parsed);
    } catch {
      // The head can end in the middle of a line.
    }
  }
  return records;
}

const asRecord = (value: unknown): DynamicRecord => (isDynamicRecord(value) ? value : {});

const blobText = (value: unknown): string =>
  typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : "";

function blocksText(content: unknown, kinds: readonly string[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      return kinds.includes(String(record.type)) && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

// Cursor CLI: ~/.cursor/chats/<folder hash>/<session>/{meta.json,store.db}

async function listCursorCli(): Promise<Locator[]> {
  const found: Locator[] = [];
  for (const hash of await readdir(cursorChats())) {
    for (const id of await readdir(join(cursorChats(), hash)).catch(() => [])) {
      const dir = join(cursorChats(), hash, id);
      try {
        const meta = asRecord(JSON.parse(await readFile(join(dir, "meta.json"), "utf8")));
        const store = join(dir, "store.db");
        await stat(store);
        const cwd = typeof meta.cwd === "string" ? meta.cwd : null;
        if (meta.isSubagent === true || meta.hasConversation !== true || isOpenBotWorkspace(cwd)) continue;
        const title = typeof meta.title === "string" && meta.title ? meta.title : "Cursor";
        const updatedAt = typeof meta.updatedAtMs === "number" ? meta.updatedAtMs : 0;
        found.push({ session: row("cursor-cli", id, { title, cwd, updatedAt, resumable: true }), path: store, id });
      } catch {
        // A session with no conversation has no store.db.
      }
    }
  }
  return found;
}

function readCursorCli(path: string): SessionTurn[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const turns: SessionTurn[] = [];
    // The message blobs are the JSON ones; the others are the tree that links them.
    for (const { data } of database
      .prepare("SELECT data FROM blobs WHERE CAST(substr(data, 1, 8) AS TEXT) = '{\"role\":'")
      .all()) {
      const message = asRecord(JSON.parse(blobText(data)));
      if (message.role === "user") {
        const text = cursorUserText(blocksText(message.content, ["text"]));
        if (text && !isScaffolding(text)) turns.push({ role: "user", text });
      } else if (message.role === "assistant") {
        const text = blocksText(message.content, ["text"]).trim();
        if (text) turns.push({ role: "assistant", text });
      }
    }
    return turns;
  } finally {
    database.close();
  }
}

// Cursor IDE: composers and bubbles in the global state database.

function listCursorIde(): Locator[] {
  const path = cursorIdeDatabase();
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT substr(key, 14) AS id, json_extract(value, '$.name') AS name,
                json_extract(value, '$.lastUpdatedAt') AS updated, json_extract(value, '$.createdAt') AS created
         FROM cursorDiskKV
         WHERE key LIKE 'composerData:%'
           AND json_array_length(json_extract(value, '$.fullConversationHeadersOnly')) > 0`,
      )
      .all();
    return rows.map((entry) => {
      const id = String(entry.id);
      const title = typeof entry.name === "string" && entry.name ? entry.name : "Cursor";
      const updatedAt = Number(entry.updated ?? entry.created ?? 0);
      return { session: row("cursor-ide", id, { title, cwd: null, updatedAt, resumable: false }), path, id };
    });
  } finally {
    database.close();
  }
}

function readCursorIde(path: string, id: string): SessionTurn[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const composer = database
      .prepare("SELECT json_extract(value, '$.fullConversationHeadersOnly') AS headers FROM cursorDiskKV WHERE key = ?")
      .get(`composerData:${id}`);
    const headers = JSON.parse(String(composer?.headers ?? "[]"));
    const bubble = database.prepare("SELECT json_extract(value, '$.text') AS text FROM cursorDiskKV WHERE key = ?");
    const turns: SessionTurn[] = [];
    for (const header of Array.isArray(headers) ? headers : []) {
      const { bubbleId, type } = asRecord(header);
      const text = String(bubble.get(`bubbleId:${id}:${String(bubbleId)}`)?.text ?? "").trim();
      if (text) turns.push({ role: type === 1 ? "user" : "assistant", text });
    }
    return turns;
  } finally {
    database.close();
  }
}

// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl

async function jsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(entry.parentPath, entry.name));
  }
  return files;
}

function codexTurn(record: DynamicRecord): SessionTurn | null {
  if (record.type !== "response_item") return null;
  const payload = asRecord(record.payload);
  if (payload.type !== "message") return null;
  if (payload.role === "user") {
    const text = blocksText(payload.content, ["input_text"]).trim();
    return isScaffolding(text) ? null : { role: "user", text };
  }
  if (payload.role === "assistant") {
    const text = blocksText(payload.content, ["output_text"]).trim();
    return text ? { role: "assistant", text } : null;
  }
  return null;
}

async function listCodex(): Promise<Locator[]> {
  const found: Locator[] = [];
  for (const path of await jsonlFiles(codexSessions())) {
    try {
      const records = parseLines(await head(path));
      const meta = asRecord(records.find((record) => record.type === "session_meta")?.payload);
      const id = typeof meta.id === "string" ? meta.id : null;
      const cwd = typeof meta.cwd === "string" ? meta.cwd : null;
      if (!id || isOpenBotWorkspace(cwd)) continue;
      const first = records.map(codexTurn).find((turn) => turn?.role === "user");
      if (!first) continue;
      const updatedAt = (await stat(path)).mtimeMs;
      found.push({
        session: row("codex", id, { title: titleOf(first.text), cwd, updatedAt, resumable: true }),
        path,
        id,
      });
    } catch {
      // An unreadable rollout is left out.
    }
  }
  return found;
}

async function readJsonlTurns(
  path: string,
  turnOf: (record: DynamicRecord) => SessionTurn | null,
): Promise<SessionTurn[]> {
  return parseLines(await readFile(path, "utf8"))
    .map(turnOf)
    .filter((turn): turn is SessionTurn => turn !== null);
}

// Claude Code: ~/.claude/projects/<folder>/<session>.jsonl

function claudeTurn(record: DynamicRecord): SessionTurn | null {
  if (record.isSidechain === true || record.isMeta === true) return null;
  const message = asRecord(record.message);
  if (record.type === "user") {
    const text = blocksText(message.content, ["text"]).trim();
    return isScaffolding(text) ? null : { role: "user", text };
  }
  if (record.type === "assistant") {
    const text = blocksText(message.content, ["text"]).trim();
    return text ? { role: "assistant", text } : null;
  }
  return null;
}

async function listClaude(): Promise<Locator[]> {
  const found: Locator[] = [];
  for (const path of await jsonlFiles(claudeProjects())) {
    // Subagent transcripts sit in a `subagents` folder beside the session.
    if (/[\\/]subagents[\\/]/u.test(path)) continue;
    try {
      const records = parseLines(await head(path));
      const first = records.map(claudeTurn).find((turn) => turn?.role === "user");
      if (!first) continue;
      const cwdRecord = records.find((record) => typeof record.cwd === "string");
      const cwd = typeof cwdRecord?.cwd === "string" ? cwdRecord.cwd : null;
      if (isOpenBotWorkspace(cwd)) continue;
      const id = path.replace(/^.*[\\/]/u, "").replace(/\.jsonl$/u, "");
      const updatedAt = (await stat(path)).mtimeMs;
      found.push({
        session: row("claude", id, { title: titleOf(first.text), cwd, updatedAt, resumable: true }),
        path,
        id,
      });
    } catch {
      // An unreadable session is left out.
    }
  }
  return found;
}

// OpenCode: sessions and messages in its own database.

function listOpenCode(): Locator[] {
  const path = openCodeDatabase();
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT id, title, directory, time_updated,
                (SELECT json_extract(m.data, '$.metadata.displayText') FROM session_message m
                 WHERE m.session_id = session_v2.id AND m.type = 'user' ORDER BY m.seq LIMIT 1) AS first
         FROM session_v2 WHERE parent_id IS NULL AND first IS NOT NULL`,
      )
      .all();
    const found: Locator[] = [];
    for (const entry of rows) {
      const cwd = typeof entry.directory === "string" ? entry.directory : null;
      if (isOpenBotWorkspace(cwd)) continue;
      const id = String(entry.id);
      const title = titleOf(typeof entry.title === "string" && entry.title ? entry.title : String(entry.first));
      found.push({
        session: row("opencode", id, { title, cwd, updatedAt: Number(entry.time_updated ?? 0), resumable: true }),
        path,
        id,
      });
    }
    return found;
  } finally {
    database.close();
  }
}

function readOpenCode(path: string, id: string): SessionTurn[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const turns: SessionTurn[] = [];
    for (const entry of database
      .prepare(
        "SELECT type, data FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant') ORDER BY seq",
      )
      .all(id)) {
      const data = asRecord(JSON.parse(String(entry.data)));
      if (entry.type === "user") {
        const text = String(asRecord(data.metadata).displayText ?? data.text ?? "").trim();
        if (text) turns.push({ role: "user", text });
      } else {
        const text = blocksText(data.content, ["text"]).trim();
        if (text) turns.push({ role: "assistant", text });
      }
    }
    return turns;
  } finally {
    database.close();
  }
}

// Antigravity: one row per conversation in `conversation_summaries.db`, the words beside it.

/** `2026-10-06 17:39:58.4487795+00:00`: the seventh fraction digit and the space would not parse. */
function antigravityTime(value: unknown): number {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/u.exec(
    String(value ?? "").trim(),
  );
  if (!match) return 0;
  const [, date, time, fraction = "0", zone = "Z"] = match;
  const millis = `${fraction}000`.slice(0, 3);
  const offset = zone === "Z" ? "Z" : zone.replace(":", "");
  const parsed = Date.parse(`${date}T${time}.${millis}${offset}`);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `["file:///i%3A/code/PROJECTS/beacle"]` holds the folder, escaped as a URI. */
function antigravityFolder(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim().startsWith("[")) return null;
  try {
    const uris = JSON.parse(value);
    if (!Array.isArray(uris)) return null;
    for (const uri of uris) {
      if (typeof uri !== "string" || !uri.startsWith("file:")) continue;
      try {
        return fileURLToPath(uri);
      } catch {
        // A URI the host cannot turn into a path is skipped.
      }
    }
  } catch {
    // Not a JSON list: no folder to show.
  }
  return null;
}

/** The full transcript when the app wrote one, else the short one. */
async function antigravityTranscript(root: string, id: string): Promise<string | null> {
  const logs = join(root, "brain", id, ".system_generated", "logs");
  for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
    const path = join(logs, name);
    try {
      await stat(path);
      return path;
    } catch {
      // Try the next name.
    }
  }
  return null;
}

async function listAntigravityRoot(root: string): Promise<Locator[]> {
  const found: Locator[] = [];
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(join(root, "conversation_summaries.db"), { readOnly: true });
  } catch {
    return found;
  }
  try {
    // Subagent conversations sit under their parent and are left out, as in the other apps.
    const rows = database
      .prepare(
        `SELECT conversation_id, title, preview, workspace_uris, last_modified_time
         FROM conversation_summaries
         WHERE parent_conversation_id = '' AND nesting_depth = 0`,
      )
      .all();
    for (const entry of rows) {
      const id = String(entry.conversation_id ?? "");
      if (!id) continue;
      const cwd = antigravityFolder(entry.workspace_uris);
      if (isOpenBotWorkspace(cwd)) continue;
      const path = await antigravityTranscript(root, id);
      if (!path) continue;
      const title = titleOf(String(entry.title || entry.preview || "Antigravity"));
      const updatedAt = antigravityTime(entry.last_modified_time) || (await stat(path)).mtimeMs;
      found.push({ session: row("antigravity", id, { title, cwd, updatedAt, resumable: false }), path, id });
    }
  } catch {
    // A moved schema leaves the other app listed.
  } finally {
    database.close();
  }
  return found;
}

async function listAntigravity(): Promise<Locator[]> {
  return (await Promise.all(antigravityRoots().map((root) => listAntigravityRoot(root)))).flat();
}

/** The words of one user turn sit in `<USER_REQUEST>`; the rest of the record is machine context. */
function antigravityUserText(content: string): string {
  const request = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/u.exec(content);
  if (request?.[1] !== undefined) return request[1].trim();
  return (content.split(/<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>/u)[0] ?? "").trim();
}

function antigravityTurn(record: DynamicRecord): SessionTurn | null {
  if (typeof record.content !== "string") return null;
  if (record.type === "USER_INPUT") {
    const text = antigravityUserText(record.content);
    return text && !isScaffolding(text) ? { role: "user", text } : null;
  }
  if (record.type === "PLANNER_RESPONSE") {
    const text = record.content.trim();
    return text ? { role: "assistant", text } : null;
  }
  return null;
}

async function readAntigravity(path: string): Promise<SessionTurn[]> {
  const turns: SessionTurn[] = [];
  // A turn arrives in pieces: one answer is often several PLANNER_RESPONSE records in a row.
  for (const turn of parseLines(await readFile(path, "utf8")).map(antigravityTurn)) {
    if (!turn) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === turn.role) last.text = `${last.text}\n\n${turn.text}`;
    else turns.push({ ...turn });
  }
  return turns;
}

/** One app that cannot be read leaves the others listed. */
async function safely(reader: () => Promise<Locator[]> | Locator[]): Promise<Locator[]> {
  try {
    return await reader();
  } catch {
    return [];
  }
}

export async function listImportableSessions(): Promise<ImportableSession[]> {
  const readers: Array<() => Promise<Locator[]> | Locator[]> = [
    listCursorCli,
    listCursorIde,
    listCodex,
    listClaude,
    listOpenCode,
    listAntigravity,
  ];
  const found = (await Promise.all(readers.map(safely))).flat();
  known = new Map(found.map((locator) => [locator.session.key, locator]));
  return found.map((locator) => locator.session).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readSessionTranscript(key: string): Promise<SessionTranscript> {
  if (!known.has(key)) await listImportableSessions();
  const locator = known.get(key);
  if (!locator) throw new Error("This session is no longer on this computer.");
  const { session, path, id } = locator;
  let turns: SessionTurn[];
  switch (session.source) {
    case "cursor-cli":
      turns = readCursorCli(path);
      break;
    case "cursor-ide":
      turns = readCursorIde(path, id);
      break;
    case "codex":
      turns = await readJsonlTurns(path, codexTurn);
      break;
    case "claude":
      turns = await readJsonlTurns(path, claudeTurn);
      break;
    case "opencode":
      turns = readOpenCode(path, id);
      break;
    case "antigravity":
      turns = await readAntigravity(path);
      break;
  }
  return { session, turns };
}

/** The conversation as plain text, newest turns kept when it must fit `limit` characters. */
export function transcriptText(turns: readonly SessionTurn[], limit: number): string {
  const blocks = turns.map(
    (turn) =>
      `## ${turn.role === "user" ? "User" : "Assistant"}\n${shorten(turn.text, turn.role === "user" ? USER_TURN_LIMIT : ASSISTANT_TURN_LIMIT)}`,
  );
  const kept: string[] = [];
  let length = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index] ?? "";
    if (length + block.length + 2 > limit) break;
    kept.unshift(block);
    length += block.length + 2;
  }
  const dropped = blocks.length - kept.length;
  return `${dropped > 0 ? `[The first ${dropped} messages are left out.]\n\n` : ""}${kept.join("\n\n")}`;
}
