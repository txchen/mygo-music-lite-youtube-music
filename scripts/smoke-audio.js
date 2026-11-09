import { installPublicHost } from './runtime.js';
installPublicHost();
const plugin = await import('../index.js');
const id = Bun.argv.slice(2).find(arg => arg !== '--') || 'aqz-KE-bpKQ';
const started = performance.now();
const stream = await plugin.stream({ id });
console.log(`Stream resolved in ${Math.round(performance.now() - started)} ms.`);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15000);
try {
  const response = await fetch(stream.url, { headers: { ...stream.headers, Range: 'bytes=0-1023' }, signal: controller.signal });
  if (response.status !== 206) {
    await response.body?.cancel();
    throw new Error(`The direct audio server returned HTTP ${response.status}, expected 206.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const m4a = new TextDecoder().decode(bytes.slice(4, 8)) === 'ftyp';
  const webm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  if (stream.type === 'm4a' ? !m4a : !webm) throw new Error('The direct response did not contain the expected audio container.');
  console.log(`Public extraction returned ${stream.type}, HTTP 206 and valid container bytes. Signed URLs were not printed.`);
} finally { clearTimeout(timer); }
