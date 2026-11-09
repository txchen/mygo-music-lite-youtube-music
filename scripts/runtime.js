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

export function installPublicHost() {
  const storage = new Map();
  globalThis.host = {
    t: text => text,
    language: () => 'en',
    platform: process.platform,
    storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, value), remove: key => storage.delete(key) },
    spawn(command, args) {
      const child = Bun.spawn([command, ...args], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
      const lines = readLines(child.stdout);
      return {
        closeStdin() { child.stdin.end(); },
        async readLine() { const line = await lines.next(); return line.done ? null : line.value; },
        wait: () => child.exited,
        kill: () => child.kill(),
      };
    },
  };
}
