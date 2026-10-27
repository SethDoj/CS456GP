import net from "node:net";
import { parseArgs } from "node:util";

//Heartbeat port: 5000;
interface Config {
  port: number;
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
function parseCli(argv: string[]): Config{
  let healthPort = 5000;
  const args = process.argv.slice(2);
  const blocked: string[] = [];
  let port = -1;

  for(let i = 0; i < args.length; i++){
    const flag = args[i];
    const val = args[i + 1];

    switch(flag){
      case "--port":
        port = Number(args[i]);
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
  console.log('IP', ip , action, 'at', now);
}

// Checks the IP; rejects (log + destroy) or forwards.
function handleConnection(socket: net.Socket, blockList: net.BlockList, config: Config, stats: Stats): void{

}

// Opens the upstream connection and pipes both directions, with error and close handling.
function forward(client: net.Socket, config: Config, stats: Stats): void{

}

// The heartbeat service polls this.
// function startHealthServer(port: number, stats: Stats): net.Server{

//}

function main(): void{
  //random testing
  log("allowed", "192.186.56.6");
  log("rejected", "182.473");
}
main();
