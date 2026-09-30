import { describe, it, expect } from 'vitest';
import { diagnose } from '../src/detectors/diagnose.js';
import { defaultSettings } from '../src/settings.js';
import { explainDiagnosis } from '../src/explain/templates.js';

const healthy = {
  cpuPct: 20,
  memUsedPct: 55,
  swapActivityBytes: 0,
  diskBusyPct: 10,
  diskLatencyMs: 4,
  cpuFreqRatio: 0.95,
  topProcesses: [
    { name: 'chrome.exe', cpuPct: 6, memMb: 900 },
    { name: 'Teams.exe', cpuPct: 4, memMb: 600 },
  ],
};
const run = (over = {}, baseline = { diskLatencyMs: 4 }) =>
  diagnose({ ...healthy, ...over }, defaultSettings, baseline);
const rules = (r) => r.causes.map((c) => c.rule);

describe('diagnose: each rule', () => {
  it('healthy sample gives no clear cause', () => {
    const r = run();
    expect(r.causes).toEqual([]);
    expect(r.verdict).toBe('no_clear_cause');
  });

  it('CPU >= 85% names the top process', () => {
    const r = run({
      cpuPct: 97,
      topProcesses: [
        { name: 'cpu_hog.py', cpuPct: 88, memMb: 40 },
        { name: 'chrome.exe', cpuPct: 5, memMb: 900 },
      ],
    });
    expect(rules(r)).toContain('cpu_saturated');
    expect(r.causes[0].process).toBe('cpu_hog.py');
    expect(r.verdict).toBe('causes_found');
  });

  it('CPU just below 85% is not a cause', () => {
    expect(rules(run({ cpuPct: 84 }))).not.toContain('cpu_saturated');
  });

  it('memory >= 90% is a cause and names the biggest memory user', () => {
    const r = run({
      memUsedPct: 93,
      topProcesses: [
        { name: 'chrome.exe', cpuPct: 5, memMb: 3100 },
        { name: 'Teams.exe', cpuPct: 4, memMb: 600 },
      ],
    });
    expect(rules(r)).toContain('memory_pressure');
    expect(r.causes.find((c) => c.rule === 'memory_pressure').process).toBe('chrome.exe');
  });

  it('swap activity alone flags memory pressure', () => {
    expect(rules(run({ swapActivityBytes: 50 * 1024 * 1024 }))).toContain('memory_pressure');
  });

  it('disk busy > 80% is a cause', () => {
    expect(rules(run({ diskBusyPct: 92 }))).toContain('disk_saturated');
  });

  it('disk latency 3x the device baseline is a cause', () => {
    expect(rules(run({ diskLatencyMs: 13 }, { diskLatencyMs: 4 }))).toContain('disk_saturated');
  });

  it('disk latency 2x baseline is not a cause', () => {
    expect(rules(run({ diskLatencyMs: 8 }, { diskLatencyMs: 4 }))).not.toContain('disk_saturated');
  });

  it('throttling: frequency ratio < 0.75 at high load', () => {
    expect(rules(run({ cpuPct: 80, cpuFreqRatio: 0.6 }))).toContain('cpu_throttled');
  });

  it('low frequency at LOW load is power saving, not throttling', () => {
    expect(rules(run({ cpuPct: 10, cpuFreqRatio: 0.3 }))).not.toContain('cpu_throttled');
  });
});

describe('diagnose: ranking and missing data', () => {
  it('ranks the most over-threshold cause first', () => {
    const r = run({ cpuPct: 99, memUsedPct: 91 });
    expect(rules(r)).toEqual(['cpu_saturated', 'memory_pressure']);
    expect(r.causes[0].rank).toBe(1);
    expect(r.causes[1].rank).toBe(2);
  });

  it('missing sensors (null) skip their rules and never count as zero or as a cause', () => {
    const r = run({
      memUsedPct: null,
      swapActivityBytes: null,
      diskBusyPct: null,
      diskLatencyMs: null,
      cpuFreqRatio: null,
      cpuPct: 97,
    });
    expect(rules(r)).toEqual(['cpu_saturated']);
    expect(r.skippedRules).toEqual(expect.arrayContaining(['memory_pressure', 'disk_saturated', 'cpu_throttled']));
  });

  it('with no baseline the latency rule is skipped but busy% still works', () => {
    const noBase = run({ diskLatencyMs: 50, diskBusyPct: 10 }, { diskLatencyMs: null });
    expect(rules(noBase)).not.toContain('disk_saturated');
    const busy = run({ diskLatencyMs: 50, diskBusyPct: 95 }, { diskLatencyMs: null });
    expect(rules(busy)).toContain('disk_saturated');
  });

  it('an entirely empty sample does not crash and finds nothing', () => {
    const r = diagnose({ topProcesses: [] }, defaultSettings, {});
    expect(r.causes).toEqual([]);
    expect(r.verdict).toBe('no_clear_cause');
  });

  it('thresholds come from settings, not the detector', () => {
    const s = { ...defaultSettings, diagnose: { ...defaultSettings.diagnose, cpuPct: 50 } };
    expect(rules(diagnose({ ...healthy, cpuPct: 60 }, s, {}))).toContain('cpu_saturated');
  });
});

describe('diagnosis explanation', () => {
  const banned = [/will fail/i, /going to fail/i, /\bdie\b/i, /guarantee/i];

  it('is hedged, names the process, and has no banned phrases', () => {
    const r = run({ cpuPct: 97, topProcesses: [{ name: 'cpu_hog.py', cpuPct: 88, memMb: 40 }] });
    const text = explainDiagnosis(r);
    expect(text).toMatch(/cpu_hog\.py/);
    expect(text).toMatch(/consistent with|may/i);
    for (const b of banned) expect(text).not.toMatch(b);
  });

  it('says so plainly when there is no clear cause', () => {
    expect(explainDiagnosis(run())).toMatch(/no clear cause/i);
  });
});
