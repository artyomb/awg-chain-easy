'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { amneziaQrChunks } = require('../app/amnezia-qr');
test('Amnezia QR packets match QDataStream and reconstruct every payload byte', () => {
  for (const size of [1, 849, 850, 851, 1190, 1700, 1701, 850 * 255]) {
    const original = Buffer.from(Array.from({ length: size }, (_, i) => i % 251));
    const chunks = amneziaQrChunks('vpn://' + original.toString('base64url'));
    assert.equal(chunks.length, Math.ceil(size / 850));
    const restored = chunks.map((text, index) => {
      const packet = Buffer.from(text, 'base64url');
      assert.equal(packet.readInt16BE(0), 1984);
      assert.equal(packet[2], chunks.length);
      assert.equal(packet[3], index);
      assert.equal(packet.readUInt32BE(4), packet.length - 8);
      assert.ok(packet.length - 8 <= 850);
      return packet.subarray(8);
    });
    assert.deepEqual(Buffer.concat(restored), original);
  }
  assert.equal(amneziaQrChunks('vpn://QUJD')[0], Buffer.from('07c0010000000003414243', 'hex').toString('base64url'));
  assert.throws(() => amneziaQrChunks('vpn://' + Buffer.alloc(850 * 255 + 1).toString('base64url')));
});
