import { config } from '../config.js';

// The __Host- prefix pins csrf_id to its exact origin; it only applies over HTTPS.
const cookieName = (name) => (config.secureCookies ? `__Host-${name}` : name);

export { cookieName };
