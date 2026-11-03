// The guest OSes that a browser can run on. Each has its own image and
// snapshot (layout.js), built by vm/build-<name>.sh. `guest` is the family,
// which picks the QEMU devices and how the host talks to the guest.
const linux = (label) => Object.freeze({ label, guest: 'linux' });
const windows = (label) => Object.freeze({ label, guest: 'windows' });

const OSES = Object.freeze({
  'debian-13': linux('Debian 13'),
  'ubuntu-26.04': linux('Ubuntu 26.04'),
  'fedora-44': linux('Fedora 44'),
  'windows-11': windows('Windows 11')
});

const DEFAULT_OS = 'debian-13';

const isOs = (name) => typeof name === 'string' && Object.hasOwn(OSES, name);

// Short names that the API also takes.
const OS_ALIASES = Object.freeze({ ubuntu: 'ubuntu-26.04', fedora: 'fedora-44', windows: 'windows-11' });

// The OS that `name` means, or null. Case does not matter, and the dash may
// be left out, e.g. 'Ubuntu', 'debian13', 'ubuntu26.04', or 'windows11'.
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

const guestOf = (os) => OSES[os].guest;

export { DEFAULT_OS, OSES, guestOf, isOs, machineOs, resolveOs };
