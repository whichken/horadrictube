import { afterEach, expect, jest, test } from 'bun:test';
import { EncodingProgressWatchdog, EncodingStallError } from '../../src/progress.ts';

afterEach(() => jest.useRealTimers());

function fixture() {
  jest.useFakeTimers();
  const warnings: number[] = [];
  const errors: EncodingStallError[] = [];
  const watchdog = new EncodingProgressWatchdog(
    (time) => warnings.push(time),
    (error) => errors.push(error),
  );
  return { watchdog, warnings, errors };
}

test('startup silence warns at two minutes and stalls at five, once only', () => {
  const { warnings, errors } = fixture();
  jest.advanceTimersByTime(119999);
  expect(warnings).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(warnings).toEqual([0]);
  jest.advanceTimersByTime(179999);
  expect(errors).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(EncodingStallError);
  expect(errors[0]!.message).toContain('5 minutes');
  jest.advanceTimersByTime(600000);
  expect(warnings).toEqual([0]);
  expect(errors).toHaveLength(1);
});

test('repeated, backwards, invalid timestamps and other records cannot reset the watchdog', () => {
  const { watchdog, warnings, errors } = fixture();
  expect(watchdog.observe('out_time_us=1000000')).toBe(1000000);
  for (let minute = 0; minute < 5; minute++) {
    for (const line of [
      'out_time_us=1000000',
      'out_time_us=999999',
      'out_time_us=0',
      'out_time_us=-1',
      'out_time_us=N/A',
      'out_time_us=',
      'out_time_us=NaN',
      'out_time_us=Infinity',
      'out_time_us=1000001garbage',
      'out_time_us=9007199254740992',
      'out_time_us=1.5',
      'frame=1000',
      'total_size=50000000',
      'progress=continue',
      'progress=end',
    ])
      expect(watchdog.observe(line)).toBeUndefined();
    jest.advanceTimersByTime(60000);
  }
  expect(warnings).toEqual([1000000]);
  expect(errors).toHaveLength(1);
  expect(errors[0]!.outputTimeUs).toBe(1000000);
});

test('advancement clears the previous warning and gives a fresh five-minute window', () => {
  const { watchdog, warnings, errors } = fixture();
  jest.advanceTimersByTime(240000);
  expect(warnings).toEqual([0]);
  expect(watchdog.observe('out_time_us=1')).toBe(1);
  jest.advanceTimersByTime(119999);
  expect(warnings).toEqual([0]);
  expect(errors).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(warnings).toEqual([0, 1]);
  jest.advanceTimersByTime(179999);
  expect(errors).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(errors).toHaveLength(1);
});

test('stopping prevents late warnings/termination and cannot be rearmed by buffered output', () => {
  const { watchdog, warnings, errors } = fixture();
  watchdog.stop();
  expect(watchdog.observe('out_time_us=1000')).toBeUndefined();
  jest.advanceTimersByTime(600000);
  expect(warnings).toEqual([]);
  expect(errors).toEqual([]);
});
