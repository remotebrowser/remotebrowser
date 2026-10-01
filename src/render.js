import { Eta } from 'eta';
import { config } from './config.js';

const eta = new Eta({ views: config.viewsDir, defaultExtension: '.eta.html' });

export { eta };
