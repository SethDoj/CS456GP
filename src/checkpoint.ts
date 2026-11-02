import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const VERSION = 1;
//how many committed checkpoints to keep, so a corrupt newest file has fallbacks
const GENERATIONS = 3;
const NAME_PATTERN = /^ckpt-(\d{10})-(\d{10})\.json$/;

export interface CheckpointState {
  stats: {
    allowed: number;
    rejected: number;
    startedAt: string;
  };
  blocked: string[];  // raw --block values
}

export interface Checkpoint {
  version: number;
  epoch: number;
  seq: number;
  savedAt: string;
  state: CheckpointState;
}

interface CheckpointFile {
  name: string;
  epoch: number;
  seq: number;
}

// Local disk on purpose: the project lives on NFS, which has weaker rename and fsync behaviour.
export function defaultCheckpointDir(): string{
  return path.join("/tmp", `cs456-firewall-${os.userInfo().username}`);
}

export async function ensureCheckpointDir(dir: string): Promise<void>{
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

function digestOf(body: string): string{
  return createHash("sha256").update(body).digest("hex");
}

function fileName(epoch: number, seq: number): string{
  const pad = (value: number) => String(value).padStart(10, "0");
  return `ckpt-${pad(epoch)}-${pad(seq)}.json`;
}

// Committed checkpoints, newest first. Unfinished .tmp files never match the pattern.
async function listCheckpoints(dir: string): Promise<CheckpointFile[]>{
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch(err) {
    if((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const files: CheckpointFile[] = [];
  for(const name of names){
    const match = NAME_PATTERN.exec(name);
    if(match) files.push({ name, epoch: Number(match[1]), seq: Number(match[2]) });
  }
  return files.sort((a, b) => b.epoch - a.epoch || b.seq - a.seq);
}

// Syncs the file, renames it into place, then syncs the directory, so a reader
// only ever sees a complete checkpoint. The rename is what commits it.
export async function writeCheckpoint(dir: string, epoch: number, seq: number, state: CheckpointState): Promise<void>{
  // Serialized before the first await, so the snapshot can't change mid-write.
  const checkpoint: Checkpoint = { version: VERSION, epoch, seq, savedAt: new Date().toISOString(), state };
  const body = JSON.stringify(checkpoint);
  const name = fileName(epoch, seq);
  const target = path.join(dir, name);
  const temp = `${target}.tmp`;

  const file = await fs.open(temp, "w", 0o600);
  try {
    await file.writeFile(`${digestOf(body)}\n${body}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await fs.rename(temp, target);

  const directory = await fs.open(dir, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isCount(value: unknown): value is number{
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

// Throws with the reason if anything about the file can't be trusted.
function parseCheckpoint(raw: string, file: CheckpointFile): Checkpoint{
  const [digest, body, trailing] = raw.split("\n");
  if(body === undefined || trailing !== "") throw new Error("truncated file");
  if(digest !== digestOf(body)) throw new Error("digest mismatch");

  const checkpoint = JSON.parse(body) as Checkpoint;
  if(checkpoint.version !== VERSION) throw new Error(`unsupported version ${checkpoint.version}`);
  if(checkpoint.epoch !== file.epoch || checkpoint.seq !== file.seq) throw new Error("header does not match file name");

  const { stats, blocked } = checkpoint.state ?? {};
  if(!isCount(stats?.allowed) || !isCount(stats?.rejected)) throw new Error("invalid counters");
  if(typeof stats.startedAt !== "string" || Number.isNaN(Date.parse(stats.startedAt))) throw new Error("invalid startedAt");
  // buildBlockList throws on a bad address, so one here would crash every standby that loads it.
  if(!Array.isArray(blocked) || !blocked.every((entry) => net.isIPv4(entry))) throw new Error("invalid blocklist");
  return checkpoint;
}

// Returns the newest checkpoint that passes validation, or null if none does.
export async function loadLatestCheckpoint(dir: string): Promise<Checkpoint | null>{
  for(const file of await listCheckpoints(dir)){
    try {
      const raw = await fs.readFile(path.join(dir, file.name), "utf8");
      return parseCheckpoint(raw, file);
    } catch(err) {
      console.error(`Skipping bad checkpoint ${file.name}: ${(err as Error).message}`);
    }
  }
  return null;
}

// Reads file names only, so a corrupt newest file still counts as used.
export async function highestEpoch(dir: string): Promise<number>{
  const files = await listCheckpoints(dir);
  return files.length > 0 ? files[0].epoch : 0;
}

// Only the active firewall calls this, and never while a write is in flight,
// so any .tmp file found here was left by a process that died.
export async function pruneCheckpoints(dir: string): Promise<void>{
  const stale = (await listCheckpoints(dir)).slice(GENERATIONS).map((file) => file.name);
  const unfinished = (await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"));
  await Promise.all([...stale, ...unfinished].map((name) => fs.rm(path.join(dir, name), { force: true })));
}
