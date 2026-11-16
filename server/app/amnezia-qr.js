'use strict';

// QDataStream: qint16 magic, quint8 count/index, quint32 QByteArray length.
// Compatible with Amnezia qrCodeUtils::generateQrCodeImageSeries.
function amneziaQrChunks(uri) {
  if (!uri.startsWith('vpn://')) throw new Error('Invalid Amnezia URI');
  const data = Buffer.from(uri.slice(6), 'base64url');
  const size = 850;
  const count = Math.ceil(data.length / size);
  if (count < 1 || count > 255) throw new Error('Amnezia QR payload is too large');
  return Array.from({ length: count }, (_, index) => {
    const part = data.subarray(index * size, (index + 1) * size);
    const header = Buffer.alloc(8);
    header.writeInt16BE(1984, 0);
    header.writeUInt8(count, 2);
    header.writeUInt8(index, 3);
    header.writeUInt32BE(part.length, 4);
    return Buffer.concat([header, part]).toString('base64url');
  });
}
module.exports = { amneziaQrChunks };
