export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  onLine?: (line: string) => void;
  maxStdout?: number;
  env?: NodeJS.ProcessEnv;
  onStderr?: (text: string) => void;
}
export async function run(binary: string, args: string[], options: RunOptions): Promise<string> {
  options.signal?.throwIfAborted();
  const child = Bun.spawn([binary, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: options.env,
  });
  let stdout = '',
    stderr = '',
    pending = '',
    failure: Error | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (error: Error) => {
    if (failure) return;
    failure = error;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
  };
  const onAbort = () => terminate(new Error('Process interrupted by shutdown'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => terminate(new Error(`${binary} exceeded its timeout`)),
    options.timeoutMs,
  );
  const consume = async (stream: ReadableStream<Uint8Array>, onText: (text: string) => void) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        onText(decoder.decode(value, { stream: true }));
      }
      onText(decoder.decode());
    } catch (error) {
      terminate(error instanceof Error ? error : new Error(String(error)));
    } finally {
      reader.releaseLock();
    }
  };
  try {
    const [code] = await Promise.all([
      child.exited,
      consume(child.stdout, (text) => {
        if (options.onLine) {
          pending += text;
          if (pending.length > 1024 * 1024) {
            terminate(new Error('Process line limit exceeded'));
            pending = '';
            return;
          }
          const lines = pending.split('\n');
          pending = lines.pop()!;
          for (const line of lines) options.onLine(line.trim());
        } else {
          if (stdout.length + text.length > (options.maxStdout ?? 8 * 1024 * 1024)) {
            terminate(new Error('Process output limit exceeded'));
            return;
          }
          stdout += text;
        }
      }),
      consume(child.stderr, (text) => {
        stderr = (stderr + text).slice(-16000);
        options.onStderr?.(text);
      }),
    ]);
    if (failure) throw failure;
    if (code !== 0) throw new Error(`${binary} exited ${code}: ${stderr}`);
    return stdout;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
