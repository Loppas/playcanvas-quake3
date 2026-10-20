import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * The Worker's tests, run in workerd by Cloudflare's plugin as the Worker is deployed
 * (`wrangler.jsonc`): a project of the suite's own (`vite.config.ts`).
 */

/** A name behind a CNAME, the one name the tests' DNS has (`worker.test.ts`). */
const CNAME = { name: 'master.example.test', target: 'host.example.test', ip: '192.0.2.8' };

/**
 * Cloudflare's DNS over HTTPS (`cloudflare-dns.com`), which the runtime's `node:dns` asks, as the
 * tests have it: {@link CNAME}'s IPv4 address, and no other. The Worker's every fetch comes here,
 * so no test reaches the network.
 */
function dnsOverHttps(request: Request): Response {
  const query = new URL(request.url).searchParams;
  const name = query.get('name');
  const type = query.get('type');
  const found = name === CNAME.name && type === 'A';
  const answer = [
    { name: CNAME.name, type: 5, TTL: 300, data: `${CNAME.target}.` },
    { name: CNAME.target, type: 1, TTL: 300, data: CNAME.ip }
  ];
  return Response.json({
    Status: found ? 0 : 3,
    Question: [{ name, type }],
    ...(found ? { Answer: answer } : {})
  });
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { outboundService: dnsOverHttps }
    })
  ],
  test: {
    name: 'workerd',
    include: ['**/*.test.ts'],
    // A Durable Object's WebSockets need storage shared across the files, which runs them one at
    // a time (the plugin's known issues), and so after the Node project, as Vitest groups them.
    maxWorkers: 1,
    isolate: false,
    sequence: { groupOrder: 1 }
  }
});
