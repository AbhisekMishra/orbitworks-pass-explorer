// The security headers live in two places: nginx (docker compose) and vercel.json (production).
// They must agree, except for what the deployment itself changes (ADR-011): on Vercel the API is
// another origin (connect-src) and TLS is always on (upgrade-insecure-requests).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSP = 'content-security-policy';

/** `add_header Name "value" always;` lines of the nginx snippet, by lowercase name. */
function nginxHeaders() {
  const conf = readFileSync(path.join(WEB_ROOT, 'nginx', 'security-headers.conf'), 'utf8');
  const headers = new Map();
  for (const [, name, value] of conf.matchAll(/^add_header\s+(\S+)\s+"([^"]*)"\s+always;$/gm)) {
    headers.set(name.toLowerCase(), value);
  }
  return headers;
}

/** The headers vercel.json sets on every path, by lowercase name. */
function vercelHeaders() {
  const config = JSON.parse(readFileSync(path.join(WEB_ROOT, 'vercel.json'), 'utf8'));
  const all = config.headers.find((rule) => rule.source === '/(.*)');
  return new Map(all.headers.map(({ key, value }) => [key.toLowerCase(), value]));
}

/** CSP directives as name → sorted sources. */
function directives(policy) {
  return new Map(
    policy
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name, sources.sort()]),
  );
}

describe('security headers (nginx vs Vercel)', () => {
  const nginx = nginxHeaders();
  const vercel = vercelHeaders();

  it('set the same headers, with the same values apart from the CSP', () => {
    expect([...vercel.keys()].sort()).toEqual([...nginx.keys()].sort());
    for (const [name, value] of nginx) {
      if (name !== CSP) expect(vercel.get(name), name).toBe(value);
    }
  });

  it('use the same CSP, except the API origin and the HTTPS upgrade on Vercel', () => {
    const own = directives(nginx.get(CSP));
    const deployed = directives(vercel.get(CSP));
    expect(deployed.get('upgrade-insecure-requests')).toEqual([]);
    const extra = deployed.get('connect-src').filter((s) => !own.get('connect-src').includes(s));
    expect(extra).toHaveLength(1);
    expect(new URL(extra[0]).protocol).toBe('https:');
    deployed.delete('upgrade-insecure-requests');
    deployed.set('connect-src', own.get('connect-src'));
    expect(deployed).toEqual(own);
  });

  it('never allow inline scripts or styles, or eval', () => {
    for (const policy of [nginx.get(CSP), vercel.get(CSP)]) {
      expect(policy).not.toMatch(/unsafe-inline|unsafe-eval/);
    }
  });
});
