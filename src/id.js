import { customAlphabet } from 'nanoid';

const FRIENDLY_CHARS = '23456789abcdefghijkmnpqrstuvwxyz';

const generateShortId = (prefix = '', length = 5) => `${prefix}${customAlphabet(FRIENDLY_CHARS, length)()}`;

export { generateShortId, FRIENDLY_CHARS };
