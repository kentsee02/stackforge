import { run } from '../../platform/process.mjs';

const validUser = /^[a-zA-Z0-9_][a-zA-Z0-9_.@\\-]{0,127}$/;

export function sqlServerAuth(credential) {
  if (credential?.integrated) return { integrated: true };
  const { user, password } = credential ?? {};
  if (validUser.test(user ?? '') && typeof password === 'string' && password && password.length <= 1024 &&
      !/[\0\r\n]/.test(password)) return { user, password };
}

export async function queryLocalSqlServer({ host, port, name }, auth, sql, { command = run, signal } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:OSQLPASSWORD$|SQLCMD)/i.test(key)));
  if (!auth.integrated) env.SQLCMDPASSWORD = auth.password;
  const address = host.includes(':') ? `[${host}]` : host;
  const args = ['-S', `tcp:${address},${port}`, '-d', name, '-l', '5', '-t', '8', '-C', '-b', '-h', '-1', '-W', '-s', '\t',
    ...(auth.integrated ? ['-E'] : ['-U', auth.user]), '-Q', sql];
  try {
    return (await command('sqlcmd', args, { env, signal, stdoutOnly: true, stdoutLimit: 768 * 1024, timeout: 15000 })).trim();
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const message = error.message;
    const issue = /ENOENT|not recognized/i.test(message) ? 'client' :
      /cannot open database|database .* does not exist/i.test(message) ? 'database' :
      /login failed/i.test(message) ? 'authentication' : /permission .*denied/i.test(message) ? 'permission' :
      /SSL|TLS|certificate/i.test(message) ? 'tls' : /timeout|timed out|connection refused/i.test(message) ? 'server' : 'connection';
    throw Object.assign(new Error('Could not verify the SQL Server connection.'), { issue });
  }
}
