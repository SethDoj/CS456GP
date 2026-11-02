import { ChildProcess, fork } from 'child_process';
import { fileURLToPath } from 'url';
import { defaultCheckpointDir, ensureCheckpointDir, highestEpoch } from '../checkpoint.ts';
import { styles } from '../styles.ts';

//ms
//how long a firewall gets to report ready, or to report active once promoted.
//must stay above the heartbeat's 5s auth timeout + the firewall's 2s reconnect
const ACTIVATION_TIMEOUT = 10000;
const RESPAWN_DELAY = 1000;

const FIREWALL_PATH = fileURLToPath(new URL('../firewall.ts', import.meta.url));

type State = 'STARTING' | 'ACTIVE' | 'FAILING_OVER';

interface Firewall {
    process: ChildProcess;
    ready: Promise<void>;
    exited: Promise<void>;
}

let state: State = 'STARTING';
let active: Firewall | null = null;
let standby: Firewall | null = null;
let firewallArgs: string[] = [];
let checkpointDir = defaultCheckpointDir();
let lastEpoch = 0;

// fork() runs the real node process with the tsx loader. Spawning the tsx CLI
// would give the wrapper's PID, and SIGKILL would leave the firewall itself alive.
function spawnFirewall(): Firewall {
    const child = fork(FIREWALL_PATH, [...firewallArgs, '--supervised']);
    child.on('error', (err) => {
        console.warn(`${styles.yellow}[WARN] Firewall process error: ${err.message}${styles.reset}`);
    });

    const readyTimeout = setTimeout(() => child.kill('SIGKILL'), ACTIVATION_TIMEOUT);
    const ready = new Promise<void>((resolve, reject) => {
        child.on('message', (message: { type: string }) => {
            if(message.type != 'ready') return;
            clearTimeout(readyTimeout);
            resolve();
        });
        child.once('exit', () => {
            clearTimeout(readyTimeout);
            reject(new Error('exited before ready'));
        });
    });
    //a standby that dies unused is handled by handleExit, not whoever awaits this
    ready.catch(() => {});

    const firewall: Firewall = {
        process: child,
        ready,
        exited: new Promise((resolve) => child.once('exit', () => resolve())),
    };
    child.once('exit', (code, signal) => handleExit(firewall, code, signal));
    return firewall;
}

function handleExit(firewall: Firewall, code: number | null, signal: string | null) {
    if(firewall === active && state == 'ACTIVE') {
        failover(`active firewall exited (code ${code}, signal ${signal})`);
    }
    else if(firewall === standby) {
        console.warn(`${styles.yellow}[WARN] Standby exited, replacing it.${styles.reset}`);
        standby = null;
        setTimeout(ensureStandby, RESPAWN_DELAY);
    }
}

function ensureStandby() {
    if(!standby) standby = spawnFirewall();
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function takeStandby(): Promise<Firewall> {
    while(true) {
        const candidate = standby ?? spawnFirewall();
        standby = null;
        try {
            await candidate.ready;
            return candidate;
        } catch(error) {
            //on first boot this means bad flags or a missing key, which retrying can't fix
            if(state == 'STARTING') {
                console.error(styles.red, styles.bold, "[FATAL] Firewall failed to start", styles.reset);
                process.exit(1);
            }
            await delay(RESPAWN_DELAY);
        }
    }
}

// Disk first so a restarted supervisor continues from the highest epoch used.
// lastEpoch covers a firewall that died before it could claim its epoch on disk.
async function nextEpoch(): Promise<number> {
    let onDisk = 0;
    try {
        onDisk = await highestEpoch(checkpointDir);
    } catch(error) {
        console.error(styles.red, "[ERROR] Unable to read checkpoint directory:", error, styles.reset);
    }
    lastEpoch = Math.max(onDisk, lastEpoch) + 1;
    return lastEpoch;
}

function activate(firewall: Firewall, epoch: number): Promise<boolean> {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), ACTIVATION_TIMEOUT);
        firewall.process.on('message', (message: { type: string; epoch: number }) => {
            if(message.type != 'active' || message.epoch != epoch) return;
            clearTimeout(timeout);
            resolve(true);
        });
        firewall.exited.then(() => {
            clearTimeout(timeout);
            resolve(false);
        });
        firewall.process.send({ type: 'activate', epoch });
    });
}

async function promote() {
    while(true) {
        const candidate = await takeStandby();
        const epoch = await nextEpoch();
        console.log(`Activating firewall ${candidate.process.pid} with epoch ${epoch}...`);
        if(await activate(candidate, epoch)) {
            active = candidate;
            state = 'ACTIVE';
            console.log(`${styles.green}Firewall ${candidate.process.pid} is active with epoch ${epoch}.${styles.reset}`);
            ensureStandby();
            return;
        }
        console.error(styles.red, `[ERROR] Firewall ${candidate.process.pid} failed to activate, trying another.`, styles.reset);
        candidate.process.kill('SIGKILL');
        await candidate.exited;
    }
}

// Safe to call from any trigger: only the first call while ACTIVE does anything.
// The old firewall must be confirmed dead before promotion, so this waits on
// exit with no timeout. A process that can't be killed blocks failover, because
// promoting past it is what would cause split-brain.
export async function failover(reason: string) {
    if(state != 'ACTIVE') return;
    state = 'FAILING_OVER';
    console.error(styles.red, styles.bold, `[FAILOVER] ${reason} at ${new Date().toLocaleString()}`, styles.reset);

    const failed = active;
    active = null;
    if(failed) {
        failed.process.kill('SIGKILL');
        await failed.exited;
    }
    await promote();
}

function shutdown() {
    active?.process.kill('SIGKILL');
    standby?.process.kill('SIGKILL');
    process.exit(0);
}

// Takes the firewall's own flags and passes them through to every child.
export async function startSupervisor(args: string[]) {
    firewallArgs = args;
    const dirFlag = args.indexOf('--checkpoint-dir');
    if(dirFlag != -1) checkpointDir = args[dirFlag + 1];
    await ensureCheckpointDir(checkpointDir);

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await promote();
}
