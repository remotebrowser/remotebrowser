#!/usr/bin/env node
// Sends one command to a QEMU QMP socket, or to the guest agent's socket with
// --agent, and prints the result as JSON. Exits non-zero on an error reply.
//
//   vm/scripts/qmp.js SOCKET COMMAND [ARGUMENTS-AS-JSON]
//   vm/scripts/qmp.js --agent SOCKET COMMAND [ARGUMENTS-AS-JSON]
//
// For example, vm/scripts/qmp.js .data/vm/run/qmp.sock query-status
import { openQmp } from '../../src/vm/qmp.js';

const args = process.argv.slice(2);
const agent = args[0] === '--agent';
if (agent) {
  args.shift();
}
if (args.length < 2 || args.length > 3) {
  console.error('Usage: vm/scripts/qmp.js [--agent] SOCKET COMMAND [ARGUMENTS-AS-JSON]');
  process.exit(2);
}
const [socketPath, command, json] = args;
try {
  const qmp = await openQmp(socketPath, { agent });
  try {
    console.log(JSON.stringify(await qmp.execute(command, json ? JSON.parse(json) : undefined)));
  } finally {
    qmp.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
