export function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }));
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class SkipError extends Error {}
