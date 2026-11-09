import { createExtractor } from '../src/extractor.js';

async function* readLines(stream) {
  const decoder = new TextDecoder();
  let remaining = '';
  for await (const chunk of stream) {
    remaining += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = remaining.indexOf('\n')) >= 0) {
      yield remaining.slice(0, newline);
      remaining = remaining.slice(newline + 1);
    }
  }
  remaining += decoder.decode();
  if (remaining) yield remaining;
}
function spawn(command, args) {
  const child = Bun.spawn([command, ...args], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  const lines = readLines(child.stdout);
  return {
    closeStdin() { child.stdin.end(); },
    async readLine() { const line = await lines.next(); return line.done ? null : line.value; },
    wait: () => child.exited,
    kill: () => child.kill(),
  };
}
const id = Bun.argv.slice(2).find(arg => arg !== '--') || 'aqz-KE-bpKQ';
const stream = await createExtractor(spawn)(id);
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
