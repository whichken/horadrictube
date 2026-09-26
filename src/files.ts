import { open } from 'node:fs/promises';

// Bun handles file data; node:fs supplies the exclusive-open and fsync operations
// needed for race-free publication, plus directory operations elsewhere.
export async function writeExclusive(path: string, data: string | Blob): Promise<void> {
  const file = await open(path, 'wx');
  try {
    await Bun.write(Bun.file(file.fd), data);
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function removeFile(path: string): Promise<void> {
  try {
    await Bun.file(path).delete();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
