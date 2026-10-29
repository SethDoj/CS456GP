import * as net from 'net';
import * as dotenv from 'dotenv';
import {styles} from '../styles.ts'


const PORT = 5000;
//how many slow/dropped requests until errored
const SLOW_BUCKET_LIMIT = 10;
const DROPPED_REQUEST_LIMIT = 10;
//ms
//this sets how long a request needs to take be "slow"
const SLOW_REQUEST_TIME = 200;
//how long until a request is considered dropped.
const REQUEST_TIMEOUT_TIME = 10000;
let requestStack: string[]=[];
let connectionStatus = false;
let slowResponseBucket = 0;
let challengeKey: string = '-1';
let isAuthenticated = false;
const server: net.Server =  net.createServer((socket) => {
    //holds a partial message until its newline arrives
    let buffer = '';
    const pingInterval = setInterval(()=> {
        if(connectionStatus && isAuthenticated) {
            ping(socket)
        }
    }, 1000);
    socket.on('error', (err) => {
        console.warn(`${styles.yellow}[WARN] Socket error:', err.message${styles.reset}`);
    });
    socket.on('close', (stream)=> {
        console.log(`${styles.yellow}[WARN] Client disconnected.${styles.reset}`);
        connectionStatus = false;
        isAuthenticated = false;
        clearInterval(pingInterval);
    })
    socket.on('data', (data) => {
        //messages are newline-delimited since TCP can merge or split them
        
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for(const line of lines) {
            if(!isAuthenticated && line.length >0 ) {
                console.log( "Revieved hash: ", line);
                if(line == challengeKey) {
                    console.log(styles.green, "Key valid", styles.reset);
                    console.log(`${styles.green}Service Connected at ${Date().toLocaleString()} from ${socket.remoteAddress}:${socket.remotePort}... starting ping.${styles.reset}`)
                    isAuthenticated = true;
                    break;
                }
                else {
                    console.log(styles.yellow, "[WARN] invalid key from: ", socket.address, " ...closing connection", styles.reset);
                    socket.destroy(new Error("401 Unauthorized"));
                    return;
                }
            }
            if(line.length > 0) handleResponse(line);
        }
    });
});


function handleResponse(data: string | NonSharedBuffer) {
    try {
        const parsedData: string = data.toString();
        const receivedTime: number = Date.now();    
        const index: number = requestStack.indexOf(parsedData);
        if(index == -1) throw new Error('[ERROR] Matching request not found for response. RES: "+ parsedData');

        const req = requestStack.at(index);
        requestStack = requestStack.filter((value, i)=> {
            if(i != index) return value;
        });
        const reqTime = Number.parseInt(req?.replace("HEARTBEAT:", "")?? '-1');
        //TODO: handle case of repeated slow RTT
        if(reqTime == -1) throw new Error("[ERROR] failed to parse request time");

        console.log(`Received: ${parsedData} at ${new Date().toLocaleString()}`);
        if(receivedTime - reqTime > SLOW_REQUEST_TIME) {
            slowResponseBucket++;
            console.warn(`${styles.yellow}[WARN] Slow heartbeat RTT took [${receivedTime - reqTime}ms] at ${new Date().toLocaleString()}${styles.reset}`);
        }
        return;
    } catch(error) {
        console.log(styles.red, styles.bold, error, styles.reset);
        return;
    }
}
function ping(socket: net.Socket) {
    try {
        const now = Date.now();
        socket.write("HEARTBEAT:" + now + "\n");
        requestStack.push("HEARTBEAT:"+ now);
        console.log("Ping sent: ", now, " at ", new Date().toLocaleString());
        return;
    } catch(error) {
        console.error(styles.red, styles.bold, "[ERROR] Some error occured attempting to ping the service...", styles.reset);
        return;
    }
}
function start() {
    server.listen(PORT, () => {
    console.log('TCP server listening on port ', PORT);
    });
    setInterval(()=> {
        if(connectionStatus) return;
        console.log("Waiting for service to connect...")
    }, 10000)
}


function init() {
    server.setMaxListeners(2);
    server.maxConnections = 1;
    
    server.prependListener('connection', (stream) => {
        if(!isAuthenticated) {
            console.log("Client connect request... awaiting hash.");
        }
        const authTimeout = setTimeout(()=> {
            if(!isAuthenticated) {
                console.error(styles.red, "Client failed to send hash, closing connection", styles.reset);
                stream.destroy();
            }
        }, 5000)
        requestStack = [];
        slowResponseBucket = 0;
        connectionStatus = true;
        //connection specific response metrics
        const slowRequestBucketInterval = setInterval(()=> {
            if(slowResponseBucket > 0) {
                slowResponseBucket--;
            }
            if(slowResponseBucket > SLOW_BUCKET_LIMIT) {
                const date = new Date();
                console.error("[ERROR] Monitored process exceeded slow request limit! ", date.toLocaleString());
            }
        }, 2000)
        const droppedRequestMonitor = setInterval(()=> {
            const droppedRequests = requestStack.filter((value)=> {
                const sentAt = Number.parseInt(value.replace("HEARTBEAT:", ""));
                if((Date.now() - sentAt) > REQUEST_TIMEOUT_TIME) {
                    return true
                }
                return false
            });
            if(droppedRequests.length > DROPPED_REQUEST_LIMIT) {
                const date = new Date();
                console.error(styles.red, styles.bold, "[ERROR] Monitored process exceeded dropped request limit! Dropped ",droppedRequests.length," requests.", date.toLocaleString(), styles.reset);
            }
        }, 2000)
        stream.on('close', ()=> {
            clearInterval(slowRequestBucketInterval);
            clearInterval(droppedRequestMonitor);
            clearTimeout(authTimeout);
        })
        
    });
    
    return;

}

function main() {
    // Load environment variables
    dotenv.config();
    challengeKey = process.env.CHALLENGE_KEY?? '-1'
    if(challengeKey == '-1') {
        console.error(styles.red, styles.bold, "[FATAL] Unable to read environment challenge key", styles.reset);
        process.exit(1);
    }
    init();
    start();
}


main();