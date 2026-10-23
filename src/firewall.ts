import net from "node:net";
import { parseArgs } from "node:util";

//Heartbeat port: 5000;
interface Config {
  port: number;
  upstreamHost: string;
  upstreamPort: number;
  healthPort: number;
  blocked: string[];  // raw --block values
}

interface Stats {
  allowed: number;
  rejected: number;
  active: number;
  startedAt: string;
}

// Reads flags with parseArgs (--block uses multiple: true). Exits with usage text on bad input.
function parseCli(argv: string[]): Config;

function buildBlockList(entries: string[]): net.BlockList;

//Simple logger: one line per connection.
function log(action: "allowed" | "rejected", ip: string, reason?: string): void;

// Checks the IP; rejects (log + destroy) or forwards.
function handleConnection(socket: net.Socket, blockList: net.BlockList, config: Config, stats: Stats): void;

// Opens the upstream connection and pipes both directions, with error and close handling.
function forward(client: net.Socket, config: Config, stats: Stats): void;

// Replies with JSON stats and closes. The heartbeat service polls this.
function startHealthServer(port: number, stats: Stats): net.Server;

function main(): void;
main();
