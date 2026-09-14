// test.hygiene (ORDER tui-stash-j1d4): env-dependent integration tests are
// skip-when-absent so the suite is green without live services and RED only
// when the required service is present and broken.
import { connect } from 'net';
import { execSync } from 'child_process';

function portServes(port: number, marker: string, ms = 400): boolean | 'free' {
  return new Promise(resolve => {
    const sock = connect({ port, host: '127.0.0.1' });
    const done = (v: boolean | 'free') => { sock.destroy(); resolve(v); };
    sock.setTimeout(ms);
    sock.on('timeout', () => done(false));
    sock.on('error', () => resolve('free'));
    sock.on('connect', () => {
      sock.write(`GET / HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      let buf = '';
      sock.on('data', d => { buf += d.toString(); });
      sock.on('close', () => done(buf.includes(marker)));
    });
  }) as unknown as boolean | 'free';
}

// sync wrappers (tests gate at collect time)
function portFree(port: number): boolean {
  try {
    execSync(`node -e "const s=require('net').createServer();s.once('error',()=>process.exit(1));s.listen(${port},'127.0.0.1',()=>s.close(()=>process.exit(0)))"`, { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch { return false; }
}

export function dockerPresent(): boolean {
  try { execSync('docker info', { stdio: 'ignore', timeout: 3000 }); return true; } catch { return false; }
}
export function comfyPresent(): boolean {
  try { execSync(`node -e "require('net').connect(8188,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),400)"`, { stdio: 'ignore', timeout: 2000 }); return true; } catch { return false; }
}
export function tmuxPresent(): boolean {
  try { execSync('tmux -V', { stdio: 'ignore', timeout: 2000 }); return true; } catch { return false; }
}
// mission studio gateway :4310 is available to the test when the port is free
// (the test binds it) or already serves the TIMMY studio; a FOREIGN service on
// :4310 makes the test meaningless -> absent.
// mission studio gateway: the test binds its logserver on 4399; available when
// that port is free (test binds it) or opted in; a FOREIGN listener on 4399
// makes the test meaningless -> absent.
export function companion4310Available(): boolean {
  if (portFree(4399)) return true; // free: the test binds it
  return process.env.TIMMY_COMPANION_TESTS === '1';
}
// live-shell PTY contract needs an operator-provided live TUI session
export function ptyAvailable(): boolean {
  return tmuxPresent() && process.env.TIMMY_PTY_TESTS === '1';
}
export { portServes };
