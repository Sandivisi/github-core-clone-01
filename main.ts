// Entrypoint: bind an ephemeral port, register it with the harness env,
// serve, then long-poll /done until the suite finishes and exit 0.
// Without MAKEFUN_ENV_URL it runs standalone (local testing): it just
// listens and serves until killed.

import { Forge } from './store.ts';
import { createServer } from './app.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createServer({ forge, token });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('could not bind a port');
    process.exit(1);
  }
  const port = address.port;
  forge.baseUrl = `http://127.0.0.1:${port}`;
  console.log(`forge listening on http://127.0.0.1:${port}`);

  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    // Standalone mode: no harness to talk to, just serve.
    return;
  }

  const base = envUrl.replace(/\/$/, '');
  // Register, retrying with backoff until the env accepts us.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok || response.status === 409) break;
      console.error(`register failed: HTTP ${response.status}`);
    } catch (error) {
      console.error('register failed:', error);
    }
    await sleep(Math.min(1000 * 2 ** attempt, 5000));
  }

  // Poll /done until the suite is finished, then exit 0.
  for (;;) {
    try {
      const response = await fetch(`${base}/done`);
      if (response.ok) {
        const data = (await response.json()) as { done?: boolean };
        if (data.done === true) break;
      }
    } catch (error) {
      console.error('done poll failed:', error);
    }
    await sleep(250);
  }
  server.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
