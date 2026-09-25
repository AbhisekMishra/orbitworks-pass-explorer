import { describe, expect, it } from 'vitest';

import { clientIp } from './clientIp.js';

/** Documentation ranges (RFC 5737 / 3849) stand in for real addresses. */
const PROXY = '198.51.100.10';

const request = (headers: Record<string, string | string[] | undefined>) => ({
  ip: PROXY, // the proxy's address as the socket peer (e.g. a Railway edge node)
  headers,
});

describe('clientIp', () => {
  it('uses request.ip when no client-IP header is configured', () => {
    expect(clientIp(request({ 'x-real-ip': '203.0.113.7' }), undefined)).toBe(PROXY);
  });

  it('uses the configured header when it holds one valid IP (v4 or v6)', () => {
    expect(clientIp(request({ 'x-real-ip': '203.0.113.7' }), 'x-real-ip')).toBe('203.0.113.7');
    expect(clientIp(request({ 'x-real-ip': ' 2001:db8::1 ' }), 'x-real-ip')).toBe('2001:db8::1');
  });

  it('falls back to request.ip when the header is missing, repeated or not an IP', () => {
    expect(clientIp(request({}), 'x-real-ip')).toBe(PROXY);
    expect(clientIp(request({ 'x-real-ip': ['203.0.113.7', '203.0.113.8'] }), 'x-real-ip')).toBe(PROXY);
    expect(clientIp(request({ 'x-real-ip': '203.0.113.7, 10.0.0.1' }), 'x-real-ip')).toBe(PROXY);
    expect(clientIp(request({ 'x-real-ip': 'not-an-ip' }), 'x-real-ip')).toBe(PROXY);
  });
});
