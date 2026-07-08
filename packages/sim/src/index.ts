import { SIM_PORT } from '@botty/shared';
import { SimEngine } from './engine.js';
import { createApp } from './server.js';

const port = Number(process.env.BOTTY_SIM_PORT ?? SIM_PORT);
const engine = new SimEngine();
const app = createApp(engine);

app.listen(port, '127.0.0.1', () => {
  console.log(`[sim] botty simulator listening on http://localhost:${port}`);
  console.log(`[sim] control panel: http://localhost:${port}/`);
});
