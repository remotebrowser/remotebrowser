// The guest OS that a browser runs on: Debian 13, with its image and
// snapshot (layout.js) built by vm/build-debian-13.sh.
const OSES = Object.freeze({
  'debian-13': Object.freeze({ label: 'Debian 13' })
});

const DEFAULT_OS = 'debian-13';

const isOs = (name) => typeof name === 'string' && Object.hasOwn(OSES, name);

// The OS of a VM's machine.json. Older VMs have none.
const machineOs = (machine) => machine?.os ?? DEFAULT_OS;

export { DEFAULT_OS, OSES, isOs, machineOs };
