import { Hono } from 'hono';

export const routes = new Hono();

routes.get('/', (c) => c.text(`OK ${Date.now()}`));
