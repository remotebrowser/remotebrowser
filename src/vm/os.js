// The guest OSes that a browser can run on. Each has its own image and
// snapshot (layout.js), built by vm/build-<name>.sh.
const OSES = Object.freeze({
  'debian-13': Object.freeze({ label: 'Debian 13' }),
  'ubuntu-26.04': Object.freeze({ label: 'Ubuntu 26.04' })
});

const DEFAULT_OS = 'debian-13';

const isOs = (name) => typeof name === 'string' && Object.hasOwn(OSES, name);

// Short names that the API also takes.
const OS_ALIASES = Object.freeze({ ubuntu: 'ubuntu-26.04' });

// The OS that `name` means, or null. Case does not matter, and the dash may
// be left out, e.g. 'Ubuntu', 'debian13', or 'ubuntu26.04'.
const resolveOs = (name) => {
  if (typeof name !== 'string') {
    return null;
  }
  const key = name.toLowerCase();
  if (Object.hasOwn(OS_ALIASES, key)) {
    return OS_ALIASES[key];
  }
  return Object.keys(OSES).find((os) => os === key || os.replace('-', '') === key) ?? null;
};

// The OS of a VM's machine.json. VMs from before there were several OSes
// have none.
const machineOs = (machine) => machine?.os ?? DEFAULT_OS;

export { DEFAULT_OS, OSES, isOs, machineOs, resolveOs };
