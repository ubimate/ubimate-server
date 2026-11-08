// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

import { describe, expect, it } from 'vitest';
import { isBlockedAddress, isBlockedHost } from '../lib/publicAddress';

describe('isBlockedAddress', () => {
  const blocked = [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.255.255.255',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.0.1',
    '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:a9fe:a9fe', '::ffff:8.8.8.8',
    '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:0:4136:e378::1', '2001:db8::1',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', '[::1]',
    'not-an-ip', '',
  ];
  const allowed = [
    '1.1.1.1', '8.8.8.8', '93.184.215.14', '100.63.255.255', '100.128.0.0', '172.15.255.255',
    '172.32.0.0', '192.169.0.1', '198.20.0.1', '223.255.255.255',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::200e', '[2606:4700::1]',
  ];

  it('lists what it checks', () => {
    expect(blocked).toHaveLength(38);
    expect(allowed).toHaveLength(14);
  });

  it.each(blocked)('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(allowed)('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('isBlockedHost', () => {
  it.each(['localhost', 'LOCALHOST', 'localhost.', 'a.localhost', 'printer.local', 'db.internal', '127.0.0.1', '[::ffff:7f00:1]'])(
    'blocks %s',
    (h) => expect(isBlockedHost(h)).toBe(true),
  );

  // Ordinary names pass here; what they resolve to is checked at connect time.
  it.each(['example.com', 'localhost.example.com', 'internal.example.com', '8.8.8.8', '[2606:4700::1]'])(
    'leaves %s to the connect-time check',
    (h) => expect(isBlockedHost(h)).toBe(false),
  );
});
