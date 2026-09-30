import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { routes } from './routes/index.js';
import { client } from './middleware/client.js';
import mountSecurity from './middleware/security.js';
import './logging.js';

const app = new Hono();

app.onError((err, c) => {
  consola.error(err);
  return c.text('Internal Server Error', 500);
});

app.use(client);
mountSecurity(app);

app.route('/', routes);

export default app;
