import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const child = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || join(root, '.wrangler/config'),
    WRANGLER_LOG_PATH: join(root, '.wrangler/logs'), WRANGLER_SEND_METRICS: 'false',
  },
});
child.on('error', () => { console.error('Could not start Wrangler. Run npm ci first.'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
