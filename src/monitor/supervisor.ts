import { ChildProcess, fork } from 'child_process';
import { fileURLToPath } from 'url';
import { styles } from '../styles.ts';

//ms
const RESPAWN_DELAY = 1000;

const FIREWALL_PATH = fileURLToPath(new URL('../firewall.ts', import.meta.url));

interface Firewall {
    process: ChildProcess;
    ready: Promise<void>;
}

let active: Firewall | null = null;
let standby: Firewall | null = null;
let firewallArgs: string[] = [];

// fork() runs the real node process with the tsx loader. Spawning the tsx CLI
// would give the wrapper's PID, and SIGKILL would leave the firewall itself alive.
function spawnFirewall(): Firewall {
    const child = fork(FIREWALL_PATH, firewallArgs);
    child.on('error', (err) => {
        console.warn(`${styles.yellow}[WARN] Firewall process error: ${err.message}${styles.reset}`);
    });

    const firewall: Firewall = {
        process: child,
        ready: new Promise((resolve) => {
            child.on('message', (message: { type: string }) => {
                if(message.type == 'ready') resolve();
            });
        }),
    };
    child.once('exit', () => handleExit(firewall));
    return firewall;
}

// Promotion only ever happens here, after the old firewall's exit is confirmed,
// so two firewalls can't be active at once.
function handleExit(firewall: Firewall) {
    if(firewall === active) {
        console.error(styles.red, styles.bold, `[FAILOVER] Firewall ${firewall.process.pid} exited at ${new Date().toLocaleString()}`, styles.reset);
        promote();
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

function promote() {
    const next = standby ?? spawnFirewall();
    standby = null;
    active = next;
    next.ready.then(() => {
        console.log(`${styles.green}Activating firewall ${next.process.pid}.${styles.reset}`);
        next.process.send({ type: 'activate' });
    });
    setTimeout(ensureStandby, RESPAWN_DELAY);
}

// For a firewall that's alive but stuck. Its exit then triggers the promotion.
export function failover(reason: string) {
    console.error(styles.red, styles.bold, `[FAILOVER] ${reason}`, styles.reset);
    active?.process.kill('SIGKILL');
}

function shutdown() {
    active?.process.kill('SIGKILL');
    standby?.process.kill('SIGKILL');
    process.exit(0);
}

// Takes the firewall's own flags and passes them through to every child.
export function startSupervisor(args: string[]) {
    firewallArgs = args;
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    promote();
}
