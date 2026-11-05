import * as net from 'net';
import * as dotenv from 'dotenv';
import {styles} from '../styles.ts'
import {HeartbeatConfig} from './heartbeatConfig.ts'
import {failover, startSupervisor} from './supervisor.ts'


type RequestResponseData = {
    requestTime: number;
    responseTime: number | null;
    countedAsSlow: boolean;
}

let requestStack: RequestResponseData[]=[];
let slowResponseBucket: RequestResponseData[]=[];
let challengeKey: string = '-1';
const config = HeartbeatConfig;

interface MonitoredStatus {
    isAuthenticated: boolean,
    authenticatedPorts: number[];
    connectionStatus: boolean,
    error: string,
    isFailedOver: boolean
}
const heartbeatStatus: MonitoredStatus = {
    isAuthenticated: false,
    authenticatedPorts: [],
    connectionStatus: false,
    error: '',
    isFailedOver: false
}


const authenticated = (socket: net.Socket): boolean => {
    if(!socket.remotePort) {
        return false;
    }
    const isAuthenticated = heartbeatStatus.authenticatedPorts.includes(socket.remotePort);
    return isAuthenticated;
}

const server: net.Server =  net.createServer((socket) => {
    //holds a partial message until its newline arrives
    let buffer = '';
    const pingInterval = setInterval(()=> {
        if(heartbeatStatus.connectionStatus &&  authenticated(socket)) {
            ping(socket)
        }
    }, 500);

    socket.on('error', (err) => {
        console.warn(`${styles.yellow}[WARN] Socket error:', err.message${styles.reset}`);
    });
    socket.on('close', (stream)=> {
        if(!authenticated(socket)) {
            return;
        }
        console.log(`${styles.yellow}[WARN] Client disconnected.${styles.reset}`);
        if(heartbeatStatus.isAuthenticated) {
            failover("Client disconnected");
            heartbeatStatus.isFailedOver = true;
        }
        heartbeatStatus.connectionStatus = false;
        heartbeatStatus.isAuthenticated = false;
        heartbeatStatus.error= '';
        clearInterval(pingInterval);
    });
    socket.on('data', (data) => {
        //messages are newline-delimited since TCP can merge or split them
        
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for(const line of lines) {
            if(!heartbeatStatus.isAuthenticated && line.length >0 ) {
                console.log( "Revieved hash: ", line);
                if(line == challengeKey) {
                    console.log(styles.green, "Key valid", styles.reset);
                    console.log(`${styles.green}Service Connected at ${Date().toLocaleString()} from ${socket.remoteAddress}:${socket.remotePort}... starting ping.${styles.reset}`)
                    heartbeatStatus.isAuthenticated = true;
                    const authenticatedPort = socket.remotePort;
                    if(!authenticatedPort) {
                        socket.destroy(new Error("Failed to obtain remote port for authentication"));
                        return;
                    }
                    heartbeatStatus.authenticatedPorts.push(socket.remotePort)
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
function ping(socket: net.Socket) {
    try {
        const now = Date.now();
        socket.write("HEARTBEAT:" + now + "\n");
        requestStack.push({
            requestTime: now,
            responseTime: null,
            countedAsSlow: false,
        });
        console.log("Ping sent: ", now, " at ", new Date().toLocaleString());
        return;
    } catch(error) {
        console.error(styles.red, styles.bold, "[ERROR] Some error occured attempting to ping the service...", styles.reset);
        return;
    }
}


const getConnectionHealth = (): boolean => {
    if(!heartbeatStatus.connectionStatus || !heartbeatStatus.isAuthenticated) {
        return true;
    }
    //remove no longer slow requests from bucket
    removeStaleSlowRequests();

    let slowRequests: RequestResponseData[] =  getSlowRequests();
    //clear slow requests older than window
    slowRequests = slowRequests.filter((request)=> {
        const diff = Date.now() - request.requestTime;
        if(diff < config.SLOW_BUILDUP_WINDOW ) {
            return request;
        }
    });
    slowRequests.forEach((slowRequest)=> {  
        slowResponseBucket.push(slowRequest);
    });

    let droppedRequests: RequestResponseData[] = getDroppedRequests();
    //clear dropped older than window
    droppedRequests = droppedRequests.filter((request)=> {
        const diff = Date.now() - request.requestTime;
        if(diff < config.DROPPED_REQUEST_WINDOW) {
            return request;
        }
    });
    if(droppedRequests.length > config.DROPPED_REQUEST_LIMIT) {
        const error = `${styles.red}[ERROR] Exceeded maximum dropped requests in window size: ${config.DROPPED_REQUEST_WINDOW}, dropped requests: ${droppedRequests.length} at ${new Date().toLocaleString()} ${styles.reset}`
        console.error(error);
        heartbeatStatus.error = error;
        return false;
    }
    if(slowResponseBucket.length >config.SLOW_BUCKET_LIMIT) {
        const error = `${styles.red}[ERROR] Exceeded maximum slow requests in window size: ${config.SLOW_BUILDUP_WINDOW}, slow requests: ${slowResponseBucket.length} at ${new Date().toLocaleString()} ${styles.reset}`
        console.error(error);
        heartbeatStatus.error = error;
        return false;
    }
    //remove resolved and out-of-window reuqests from the stack
    cleanStack();
    return true;
}

function removeStaleSlowRequests() {
    slowResponseBucket = slowResponseBucket.filter((request)=> {
        if(Date.now()-request.requestTime < config.SLOW_BUILDUP_WINDOW) {
            return true;
        }
    })
}

function getSlowRequests(): RequestResponseData[] {
    //includes out of window requests
    return requestStack.filter((value)=> {
        if(value.responseTime != null ) {
            const timeSinceSent = value.responseTime- value.requestTime;
            if(timeSinceSent > config.SLOW_REQUEST_TIME  && timeSinceSent < config.SLOW_REQUEST_WINDOW && value.countedAsSlow == false) {
                value.countedAsSlow = true;
                return value;
            }
        }
    }); 
}

function getDroppedRequests(): RequestResponseData[] {
    //includes out of window
    return requestStack.filter((value)=> {
        const timeSinceSent = Date.now()- value.requestTime;
        if(timeSinceSent >= config.SLOW_REQUEST_WINDOW ) {
            return value;
        }
    });
}

function cleanStack() {
    requestStack = requestStack.filter((request)=> {
        if(request.responseTime == null || Date.now() - request.requestTime <= (config.SLOW_REQUEST_WINDOW + config.SLOW_REQUEST_TIME)) {
            return request;
        }
        //everything else goes away (correctly handled requests)
    })
}

function handleResponse(data: string | NonSharedBuffer) {
    try {
        const receivedTime: number = Date.now();

        const parsedData:number = Number.parseInt(data.toString().replace("HEARTBEAT:", "")?? '-1');
        if(parsedData == -1) throw new Error('[ERROR] Failed to parse recieved request data: '+ data)
        const reqIndex: number = requestStack.findIndex((value, index)=> {
            if(parsedData == value.requestTime) {
                return true;
            }
            return false;
        });
    
        if(reqIndex == -1) throw new Error('[ERROR] Matching request not found for response. RES: "+ parsedData');

        requestStack[reqIndex].responseTime = receivedTime;
        console.log(`Received: ${parsedData} at ${new Date().toLocaleString()}`);
        return;

    } catch(error) {
        console.log(styles.red, styles.bold, error, styles.reset);
        return;
    }
}


function start() {
    server.listen(config.PORT, '127.0.0.1',  () => {
    console.log('TCP server listening on port ', config.PORT);
    });
    const connectionWait = setInterval(()=> {
        if(heartbeatStatus.connectionStatus) return;
        console.log("Waiting for service to connect...")
    }, 10000)
    server.addListener('close', (socket)=> {

        clearInterval(connectionWait);
    })
}


function init() {

    server.maxConnections = 50;
    
    server.prependListener('connection', (stream) => {
        if(!heartbeatStatus.isAuthenticated) {
            console.log("Client connect request... awaiting hash.");
        }
        const authTimeout = setTimeout(()=> {
            if(!heartbeatStatus.isAuthenticated) {
                console.error(styles.red, "Client failed to send hash, closing connection", styles.reset);
                stream.destroy();
            }
        }, 50);
        
        requestStack = [];
        slowResponseBucket = [];
        heartbeatStatus.connectionStatus = true;
        heartbeatStatus.error = '';

        const monitor = setInterval(()=> {
            if(heartbeatStatus.isAuthenticated && heartbeatStatus.connectionStatus && heartbeatStatus.isFailedOver) {
                console.log(styles.green, styles.bold, "[FAILOVER] Service restored.", styles.reset);
                heartbeatStatus.isFailedOver = false;
            }
            if(!getConnectionHealth()) {
                //since failover breaks the connection this will stop spammed monitor errrors.
                clearInterval(monitor);
                failover(heartbeatStatus.error);
                heartbeatStatus.isFailedOver = true;
            }
        }, config.SLOW_REQUEST_TIME / 2)    
        stream.on('close', ()=> {
            if(!authenticated(stream)) {
                return;
            }
            clearInterval(monitor);
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
    //firewall flags pass through; children inherit CHALLENGE_KEY from this process.
    startSupervisor(process.argv.slice(2));
}


main();