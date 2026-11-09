// SHA-1 is used only for YouTube's SAPISID request authentication, not password storage.
export function sha1(text) {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(size);
  data.set(bytes);
  data[bytes.length] = 128;
  const view = new DataView(data.buffer);
  view.setUint32(size - 4, bytes.length * 8);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Int32Array(80);
  const rotate = (n, b) => (n << b) | (n >>> (32 - b));
  for (let block = 0; block < size; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(block + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotate(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const next = (rotate(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rotate(b, 30); b = a; a = next;
    }
    [a, b, c, d, e].forEach((value, i) => { h[i] = (h[i] + value) | 0; });
  }
  return h.map(n => (n >>> 0).toString(16).padStart(8, '0')).join('');
}
