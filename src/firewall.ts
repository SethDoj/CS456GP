import net from "node:net";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import * as dotenv from "dotenv"
let challengeKey:string = "-1"
// In /tmp rather than the project because the project is on NFS.
const CHECKPOINT_FILE = "/tmp/cs456-checkpoint.json";
const CHECKPOINT_TMP = CHECKPOINT_FILE + ".tmp";
//ms
const CHECKPOINT_INTERVAL = 1000;
//Heartbeat port: 5000;
interface Config {
  port: number;
  healthPort: number;
  blocked: string[];  // raw --block values
}

interface Stats {
  allowed: number;
  rejected: number;
  startedAt: string;
}

function blockServer(): void{
  console.log("Frozen at", Date.now());
  const end = Date.now() + 30000;
  while(Date.now() < end){}
  console.log("Unfrozen at", Date.now());
  return;
}

// Reads flags with parseArgs (--block uses multiple: true). Exits with usage text on bad input.
function parseCli(argv: string[]): Config{
  let healthPort = 5000;
  const args = argv.slice(2);
  const blocked: string[] = [];
  let port = -1;

  for(let i = 0; i < args.length; i++){
    const flag = args[i];
    const val = args[i + 1];

    switch(flag){
      case "--port":
        port = Number(val);
        i++;
        break;
      case "--block":
        blocked.push(val);
        i++;
        break;
      default:
        console.error('Unknown flag', flag);
        process.exit(1);
    }
  }
  if(port == -1){
    console.error('Port not specified, use \'--port\'');
    process.exit(1);
  }
  return {port, healthPort, blocked};
}

function buildBlockList(entries: string[]): net.BlockList{
  const blocked = new net.BlockList();
  for(let i = 0; i < entries.length; i++){
    blocked.addAddress(entries[i]);
  }
  return blocked;
}

//Simple logger: one line per connection.
function log(action: "allowed" | "rejected", ip: string): void{
  const now = new Date();
  const time = now.toLocaleString();
  console.log('IP', ip , action, 'at', time);
}

// Checks the IP; rejects (log + destroy) or forwards.
function handleConnection(socket: net.Socket, blockList: net.BlockList, config: Config, stats: Stats): void{
  socket.on('error', (err) => {
    console.warn(`Socket error: ${err.message}`);
  });
  const address = socket.remoteAddress;
  const family = socket.remoteFamily?.toLowerCase() as 'ipv4' | 'ipv6' | undefined;

  if (!address || !family) {
    stats.rejected++;
    socket.destroy();
    return;
  }

  if(blockList.check(address, family)){
    stats.rejected++;
    log("rejected", address);
    socket.destroy();
    return;
  }

  stats.allowed++;
  log("allowed", address);
  return;

}

//Connects to the heartbeat service and echoes its pings back.
function connectToHeartbeat(port: number): void{
  //holds a partial message until its newline arrives
  let buffer = "";
  const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
    console.log("Creating connection... attempting auth");
    socket.write(challengeKey+ '\n');
    console.log("Connected to heartbeat service on port", port);
  });

  socket.on('data', (data) => {
    // Pings are newline-delimited and can arrive merged (e.g. after a freeze).
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for(const line of lines){
      if(line.length > 0) socket.write(line + "\n");
    }
  });

  socket.on('error', (err) => {
    console.warn(`Heartbeat connection error: ${err.message}`);
  });

  // Retry if the monitor isn't up yet or the connection drops.
  socket.on('close', () => {
    console.log("Connection was closed or unsucsessful, retyring");
    setTimeout(() => connectToHeartbeat(port), 2000);
  });
}

function createServer(blockList: net.BlockList, config: Config, stats: Stats): net.Server{
  return net.createServer((socket) => {
    console.log("Server starting on", config.port, "at", stats.startedAt,);
    console.log("Blocklist:", blockList);
    handleConnection(socket, blockList, config, stats);
  });
}

// Writes to a temp file first, so being killed mid-write leaves the real file intact.
function saveStats(stats: Stats): void{
  try {
    writeFileSync(CHECKPOINT_TMP, JSON.stringify(stats));
    renameSync(CHECKPOINT_TMP, CHECKPOINT_FILE);
  } catch(err) {
    console.error(`Checkpoint failed: ${(err as Error).message}`);
  }
}

// A missing or unreadable checkpoint only resets the counts; the blocklist comes from --block.
function loadStats(): Stats{
  try {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, "utf8"));
  } catch {
    return { allowed: 0, rejected: 0, startedAt: new Date().toISOString() };
  }
}

// Runs once, when the supervisor promotes this standby.
function activate(config: Config): void{
  const stats = loadStats();
  console.log("Activating with stats:", stats);

  const server = createServer(buildBlockList(config.blocked), config, stats);
  // Never set reusePort here: the port being exclusive stops two firewalls serving at once.
  server.on('error', (err) => {
    console.error(`Server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(config.port);

  connectToHeartbeat(config.healthPort);
  setInterval(() => saveStats(stats), CHECKPOINT_INTERVAL);
  setTimeout(blockServer, Math.random() * 20000 + 15000);
}

// Idle until the supervisor promotes this process: no port, no checkpoint writes.
function waitForActivation(config: Config): void{
  if(!process.send){
    console.error("Run this through the supervisor: npm run supervise -- --port <port>");
    process.exit(1);
  }
  // Without a supervisor nothing can replace this process, so it stops too.
  process.on('disconnect', () => process.exit(1));
  process.on('message', (message: { type: string }) => {
    if(message.type === "activate") activate(config);
  });
  process.send({ type: "ready" });
}

function main(): void{
  dotenv.config();
  challengeKey = process.env.CHALLENGE_KEY?? '-1';
  if(challengeKey == '-1') {
    console.error("Failed to load challenge key from environment");
    process.exit(1);
  }
  const config = parseCli(process.argv);

  waitForActivation(config);
}
main();
