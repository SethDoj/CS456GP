import net from "node:net"; 

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
  console.log('IP', ip , action, 'at', now);
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

//The heartbeat service polls this.
function startHealthServer(port: number, stats: Stats): net.Server{
  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      // Guard against a client that never sends a newline
      if (buffer.length > 1024) {
        socket.destroy();
        return;
      }

      // Handle every complete line in the buffer
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);

        if (line === 'PING') {
          socket.write('PONG\n');
        } else {
          socket.end('ERR unknown command\n');
          return;
        }
      }
    });
  });
  
  server.on('error', (err) => {
    console.error(`Health server error on port ${port}:`, err.message);
  });

  server.listen(port, "127.0.0.1");
  return server;
}

function main(): void{
  const config = parseCli(process.argv);
  const blockList = buildBlockList(config.blocked);

  const stats: Stats = {
    allowed: 0,
    rejected: 0,
    startedAt: new Date().toISOString(),
  };

  startHealthServer(5000, stats);

  const server = net.createServer((socket) => {
    console.log("Server starting on", config.port, "at", stats.startedAt,);
    console.log("Blocklist:", blockList);
    handleConnection(socket, blockList, config, stats);
  });
  server.listen(config.port);

}
main();
