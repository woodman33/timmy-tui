/**
 * Round R4 (helper H90): Timmy Connect's Windows command shapes. NO WINDOWS COMPUTER WAS AVAILABLE: nothing here ran on
 * Windows. What is checked: the PowerShell command builder (each script, encoded, decodes back to itself, uses only
 * characters cmd.exe and PowerShell pass through untouched, and fits cmd.exe's 8,191 characters, or is refused); the
 * detection of a device's shell from its answer; reading a Windows probe's answer (tests/fixtures/connect/
 * windows-probe-answer.txt, a FIXTURE written by hand in the shape the probe prints); and, through the FAKE ssh, a probe of
 * a FAKE Windows device whose default shell is cmd.exe (or PowerShell), which checks the encoded command's shape and answers
 * from that fixture.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDevice } from '../src/connect/devices.js';
import { scanDevice, trustKey } from '../src/connect/hostkeys.js';
import { parseProbe, probeDevice, probeWords } from '../src/connect/probe.js';
import { DETECT_WORDS, detectShell, windowsCommandScript, windowsFetchScript, windowsProbeScript, windowsStatusScript, windowsStopScript, windowsSubmitInput, windowsSubmitScript, windowsWaitScript, WINDOWS_RUNNER } from '../src/connect/remote-windows.js';
import { CMD_MAX, decodePowerShell, encodePowerShell, powershellWords } from '../src/connect/shells.js';
import { connectPaths } from '../src/connect/store.js';
import { makeKit, REPO, type Kit } from './fixtures/connect/kit.js';

const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'connect', 'windows-probe-answer.txt');
const SHA = 'c'.repeat(64);

describe('the PowerShell command builder', () => {
  const scripts: Record<string, string> = {
    probe: windowsProbeScript('.timmy-connect/jobs'),
    submit: windowsSubmitScript('.timmy-connect/jobs', 'r0123abcd', SHA),
    status: windowsStatusScript('.timmy-connect/jobs', 'r0123abcd'),
    stop: windowsStopScript('.timmy-connect/jobs', 'r0123abcd'),
    wait: windowsWaitScript('.timmy-connect/jobs', 'r0123abcd'),
    fetch: windowsFetchScript('.timmy-connect/jobs', 'r0123abcd', "work/it's here/out.bin"),
  };
  for (const [name, script] of Object.entries(scripts)) {
    it(`${name}: powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64 of UTF-16LE>, decoding back to the script, within cmd.exe's line`, () => {
      const words = powershellWords(script);
      expect(words.slice(0, 4)).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
      expect(words[4]).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(decodePowerShell(words[4])).toBe(script);
      expect(Buffer.from(words[4], 'base64').equals(Buffer.from(script, 'utf16le'))).toBe(true);
      expect(words.join(' ').length).toBeLessThanOrEqual(CMD_MAX);
    });
  }

  it('quotes a literal the PowerShell way, and refuses a command past cmd.exe\'s 8,191 characters (nothing is sent)', () => {
    expect(scripts.fetch).toContain("$rel = 'work/it''s here/out.bin'");
    expect(() => powershellWords(`'${'x'.repeat(4000)}'`)).toThrow(/past cmd\.exe's 8191: it was not sent/);
    expect(encodePowerShell('é')).toBe(Buffer.from('é', 'utf16le').toString('base64'));
  });

  it('a job\'s words run as literals (&), its exit passed on; a submission\'s bytes ride on stdin, never in the command', () => {
    expect(windowsCommandScript(['C:/Program Files/app.exe', "it's", '$env:X'])).toBe("& 'C:/Program Files/app.exe' 'it''s' '$env:X'\r\nexit $LASTEXITCODE\r\n");
    const script = Buffer.from('Write-Output 1\r\n');
    const input = windowsSubmitInput(script);
    const nl = input.indexOf(10);
    const [tag, runner, bytes] = input.subarray(0, nl).toString('ascii').split(' ');
    expect(tag).toBe('TIMMY-PARTS');
    expect(input.subarray(nl + 1, nl + 1 + Number(runner)).toString('utf8')).toBe(WINDOWS_RUNNER);
    expect(input.subarray(nl + 1 + Number(runner)).equals(script)).toBe(true);
    expect(Number(bytes)).toBe(script.length);
    expect(scripts.submit).not.toContain('Write-Output 1');
    expect(scripts.submit).toContain('Invoke-CimMethod -ClassName Win32_Process -MethodName Create');
  });
});

describe('recognising a Windows device from its answer', () => {
  it('the detection line: cmd.exe expands %OS%, PowerShell prints each word alone, a POSIX shell prints it as it is', () => {
    expect(DETECT_WORDS).toEqual(['echo', 'TIMMY-PROBE', '%OS%']);
    expect(detectShell('TIMMY-PROBE Windows_NT\r\n')).toBe('cmd');
    expect(detectShell('TIMMY-PROBE\r\n%OS%\r\n')).toBe('powershell');
    expect(detectShell('TIMMY-PROBE %OS%\n')).toBe('posix');
    expect(detectShell('something else\n')).toBe('unknown');
  });

  it('reads the Windows probe answer (a FIXTURE written by hand, not captured from Windows)', () => {
    const text = fs.readFileSync(FIXTURE, 'utf8');
    expect(text.split('\r\n')[0]).toMatch(/^FIXTURE .*NOT captured from a Windows computer/);
    const parsed = parseProbe(text)!;
    expect(parsed).toMatchObject({ family: 'powershell', os: 'windows', startTime: true });
    expect(parsed.facts).toMatchObject({ os_name: 'Windows', os_version: '10.0.26100.0', arch: 'AMD64', user: 'timmy-test', job_folder: 'absent, can be made', detach: 'wmi', sha256: 'Get-FileHash', found_on_path: ['git', 'python', 'ffmpeg', 'nvidia-smi', 'tailscale'] });
    const words = probeWords({ id: 'pc', os: 'windows', shell: 'cmd' }, parsed.facts);
    expect(words).toMatch(/^connected: Windows 10\.0\.26100\.0 AMD64, user timmy-test, shell cmd\.exe \(PowerShell sent encoded\)/);
    expect(words).toContain('jobs would start through WMI (not run on Windows yet)');
    expect(words).toContain('found on PATH: git, python, ffmpeg, nvidia-smi, tailscale (found on PATH only: not proven supported or working)');
  });
});

describe('a FAKE Windows device through the FAKE ssh', () => {
  let kit: Kit;
  beforeEach(() => { kit = makeKit('h90-windows-'); kit.stub((k, v) => { vi.stubEnv(k, v as string); }); });
  afterEach(() => { vi.unstubAllEnvs(); kit.cleanup(); });

  for (const shell of ['cmd', 'powershell'] as const) {
    it(`default shell ${shell}: recognised from its answer, then probed with an encoded PowerShell command`, async () => {
      const p = connectPaths(kit.home);
      const h = kit.addHost(2290, { shell, probeAnswer: FIXTURE });
      expect(addDevice(p, { id: 'pc', address: h.address, port: h.port, user: h.user, identity: kit.key.file }).problems).toEqual([]);
      const scan = await scanDevice(p, 'pc');
      if ('error' in scan) throw new Error(scan.error);
      trustKey(p, 'pc', scan.keys[0].fingerprint, 'cli');
      const r = await probeDevice(p, 'pc');
      if ('error' in r) throw new Error(r.error);
      expect(r.probe.outcome, r.probe.words).toBe('connected');
      expect(r.device).toMatchObject({ os: 'windows', shell });
      const calls = kit.calls('ssh').map((c) => c.argv.slice(c.argv.indexOf('--') + 2));
      expect(calls[0]).toEqual(['echo', 'TIMMY-PROBE', '%OS%']);
      expect(calls[1].slice(0, 4)).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
      expect(decodePowerShell(calls[1][4])).toBe(windowsProbeScript('.timmy-connect/jobs'));
    }, 60_000);
  }
});
