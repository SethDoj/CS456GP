import net from "node:net";
import * as dotenv from "dotenv"
import { defaultCheckpointDir, ensureCheckpointDir, loadLatestCheckpoint, pruneCheckpoints, writeCheckpoint } from "./checkpoint.ts";
let challengeKey:string = "-1"
//ms
const CHECKPOINT_INTERVAL = 1000;
const LISTEN_RETRY_DELAY = 500;
const LISTEN_RETRY_LIMIT = 10;
//Heartbeat port: 5000;
interface Config {
  port: number;
  healthPort: number;
  blocked: string[];  // raw --block values
  supervised: boolean;
  checkpointDir: string;
  simulateFreeze: boolean;
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
  let supervised = false;
  let checkpointDir = defaultCheckpointDir();
  let simulateFreeze = false;

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
      case "--checkpoint-dir":
        checkpointDir = val;
        i++;
        break;
      case "--supervised":
        supervised = true;
        break;
      case "--simulate-freeze":
        simulateFreeze = true;
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
  return {port, healthPort, blocked, supervised, checkpointDir, simulateFreeze};
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

// Never set reusePort here: the port being exclusive is what stops two firewalls serving at once.
function listen(server: net.Server, port: number): Promise<void>{
  return new Promise((resolve, reject) => {
    let attempts = 0;
    server.on('error', (err: NodeJS.ErrnoException) => {
      attempts++;
      if(err.code === 'EADDRINUSE' && attempts < LISTEN_RETRY_LIMIT){
        console.warn(`Port ${port} in use, retrying`);
        setTimeout(() => server.listen(port), LISTEN_RETRY_DELAY);
        return;
      }
      console.error(`Server error: ${err.message}`);
      reject(err);
    });
    server.once('listening', () => resolve());
    server.listen(port);
  });
}

// Runs once, when the supervisor promotes this standby. Binding the port comes
// after the checkpoint work, so a firewall can't serve before it has restored.
async function activate(epoch: number, config: Config): Promise<void>{
  console.log("Activating with epoch", epoch);
  await ensureCheckpointDir(config.checkpointDir);

  let restored = null;
  try {
    restored = await loadLatestCheckpoint(config.checkpointDir);
  } catch(err) {
    console.error(`Unable to read checkpoints: ${(err as Error).message}`);
  }
  if(restored){
    console.log(`Restored checkpoint epoch ${restored.epoch} seq ${restored.seq}`);
  } else {
    console.warn("No valid checkpoint, starting from the --block list");
  }

  // Fail closed: the --block list always applies, so a lost checkpoint can't remove a block.
  const blocked = [...new Set([...config.blocked, ...(restored?.state.blocked ?? [])])];
  const stats: Stats = restored?.state.stats ?? {
    allowed: 0,
    rejected: 0,
    startedAt: new Date().toISOString(),
  };

  let seq = 0;
  let writing = false;
  // One write at a time. A failed write keeps its seq, so the next tick retries it.
  const save = async (): Promise<void> => {
    if(writing) return;
    writing = true;
    try {
      await writeCheckpoint(config.checkpointDir, epoch, seq, {stats, blocked});
      seq++;
      await pruneCheckpoints(config.checkpointDir);
    } catch(err) {
      console.error(`Checkpoint failed: ${(err as Error).message}`);
    } finally {
      writing = false;
    }
  };
  // The first write claims this epoch on disk.
  await save();

  const server = createServer(buildBlockList(blocked), config, stats);
  await listen(server, config.port);

  connectToHeartbeat(config.healthPort);
  setInterval(save, CHECKPOINT_INTERVAL);
  if(config.simulateFreeze) setTimeout(blockServer, Math.random() * 20000 + 15000);

  process.send?.({ type: "active", epoch });
}

// Idle until the supervisor promotes this process: no port, no checkpoint writes.
function waitForActivation(config: Config): void{
  if(!process.send){
    console.error("--supervised requires being started by the supervisor");
    process.exit(1);
  }
  // Fail closed: without a supervisor nothing can fence or replace this process.
  process.on('disconnect', () => process.exit(1));
  process.on('message', (message: { type: string; epoch: number }) => {
    if(message.type !== "activate") return;
    activate(message.epoch, config).catch((err) => {
      console.error(`Activation failed: ${err.message}`);
      process.exit(1);
    });
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
  if(config.supervised){
    waitForActivation(config);
    return;
  }

  const blockList = buildBlockList(config.blocked);

  const stats: Stats = {
    allowed: 0,
    rejected: 0,
    startedAt: new Date().toISOString(),
  };

  connectToHeartbeat(config.healthPort);

  const server = createServer(blockList, config, stats);
  server.listen(config.port);

  setTimeout(blockServer, Math.random() * 20000 + 15000);

}
main();
