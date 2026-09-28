export class EncodingStallError extends Error {
  constructor(public readonly outputTimeUs: number) {
    super(
      `FFmpeg encoding stalled: output timestamp did not advance for 5 minutes (last output time ${(outputTimeUs / 1000000).toFixed(3)}s)`,
    );
    this.name = 'EncodingStallError';
  }
}

export class EncodingProgressWatchdog {
  private outputTimeUs = 0;
  private stopped = false;
  private warningTimer?: ReturnType<typeof setTimeout>;
  private stallTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private onWarning: (outputTimeUs: number) => void,
    private onStall: (error: EncodingStallError) => void,
  ) {
    this.arm();
  }

  // Return only genuine advances. Empty, N/A, repeated and regressing values
  // cannot keep an idle process alive or refresh the job's database timestamp.
  observe(line: string): number | undefined {
    if (this.stopped || !/^out_time_us=-?\d+$/.test(line)) return;
    const time = Number(line.slice('out_time_us='.length));
    if (!Number.isSafeInteger(time) || time <= this.outputTimeUs) return;
    this.outputTimeUs = time;
    this.arm();
    return time;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.warningTimer);
    clearTimeout(this.stallTimer);
  }

  private arm(): void {
    clearTimeout(this.warningTimer);
    clearTimeout(this.stallTimer);
    this.warningTimer = setTimeout(() => this.onWarning(this.outputTimeUs), 2 * 60 * 1000);
    this.stallTimer = setTimeout(
      () => {
        this.stop();
        this.onStall(new EncodingStallError(this.outputTimeUs));
      },
      5 * 60 * 1000,
    );
  }
}
