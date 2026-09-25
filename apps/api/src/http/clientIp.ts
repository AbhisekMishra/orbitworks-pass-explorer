/**
 * The client address used to key rate limits.
 *
 * Proxies disagree on how they pass it on. nginx (docker compose) sets X-Forwarded-For, which
 * Fastify resolves through `trustProxy` into `request.ip`. Railway's edge does not: it sends the
 * client address in `X-Real-IP`, and its own (rotating) address as the socket peer. Keying on
 * `request.ip` there put every visitor behind the same edge node in one shared bucket. So a
 * deployment names the header its proxy sets (CLIENT_IP_HEADER), and it is used when it holds a
 * single valid IP; anything else falls back to `request.ip`. The config only allows the header
 * behind a trusted proxy, which is what overwrites it (a direct client could send any value).
 */
import { isIP } from 'node:net';

import type { FastifyRequest } from 'fastify';

export function clientIp(
  request: Pick<FastifyRequest, 'ip' | 'headers'>,
  header: string | undefined,
): string {
  if (!header) return request.ip;
  const value = request.headers[header];
  if (typeof value !== 'string') return request.ip;
  const candidate = value.trim();
  return isIP(candidate) ? candidate : request.ip;
}
