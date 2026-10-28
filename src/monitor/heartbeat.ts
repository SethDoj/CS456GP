import * as net from 'net';

const PORT = 5000;
const SLOW_BUCKET_LIMIT = 10;
const DROPPED_REQUEST_LIMIT = 10;
//ms
const SLOW_REQUEST_TIME = 200;
const REQUEST_TIMEOUT_TIME = 10000;
let requestStack: string[]=[];
let connectionStatus = false;
let slowResponseBucket = 0;

const server: net.Server =  net.createServer((socket) => {
    console.log('Client connected');
    socket.on('close', (stream)=> {
        console.log('[WARN] Client disconnected.');
        connectionStatus = false;
    })
    socket.on('data', (data) => {
        handleResponse(data)
    });
    setInterval(()=> {
        if(connectionStatus) {
            ping(socket)
        }
    }, 1000);
});


function handleResponse(data: string | NonSharedBuffer) {
    try {
        const parsedData: string = data.toString();
        const receivedTime: number = Date.now();    
        const index: number = requestStack.indexOf(parsedData);
        if(index == -1) throw new Error("[ERROR] Matching request not found for response. RES: "+ parsedData);

        const req = requestStack.at(index);
        requestStack = requestStack.filter((value, i)=> {
            if(i != index) return value;
        });
        const reqTime = Number.parseInt(req?.replace("HEARTBEAT:", "")?? '-1');
        //TODO: handle case of repeated slow RTT
        if(reqTime == -1) throw new Error("[ERROR] failed to parse request time");

        //console.log(`Received: ${parsedData} at ${receivedTime}`);
        if(receivedTime - reqTime > SLOW_REQUEST_TIME) {
            slowResponseBucket++;
            console.warn(`[WARN] Slow heartbeat RTT took [${receivedTime - reqTime}ms] at ${new Date().toLocaleString()}`);
        }
        return;
    } catch(error) {
        console.log(error);
        return;
    }
}
function ping(socket: net.Socket) {
    try {
        const now = Date.now();
        socket.write("HEARTBEAT:" + now);
        requestStack.push("HEARTBEAT:"+ now);
        //console.log("Ping sent: ", date.toLocaleString());
        return;
    } catch(error) {
        console.error("[ERROR] Some error occured attempting to ping the service...");
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
        requestStack = [];
        slowResponseBucket = 0;
        connectionStatus = true;
        console.log(`Service Connected at ${Date().toLocaleString()} from ${stream.remoteAddress}:${stream.remotePort}... starting ping.`)
        //connection specific response metrics
        const slowRequestBucketInterval = setInterval(()=> {
            if(slowResponseBucket > 0) {
                slowResponseBucket--;
            }
            if(slowResponseBucket > SLOW_BUCKET_LIMIT) {
                const date = new Date();
                console.error("[ERROR] Monitored process exceeded slow request limit! ", date.toLocaleString());
            }
        }, 5000)
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
                console.error("[ERROR] Monitored process exceeded dropped request limit! Dropped ",droppedRequests.length," requests.", date.toLocaleString());
            }
        }, 2000)
        stream.on('close', ()=> {
            clearInterval(slowRequestBucketInterval);
            clearInterval(droppedRequestMonitor);
        })
        
    });
    return;

}

function main() {
    init();
    start();
}


main();