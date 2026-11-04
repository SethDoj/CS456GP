import * as dotenv from 'dotenv';
import { startSupervisor } from './supervisor.ts';

// Children inherit CHALLENGE_KEY from this process's environment.
function main() {
    dotenv.config();
    startSupervisor(process.argv.slice(2));
}

main();
