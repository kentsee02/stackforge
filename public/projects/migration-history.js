import { setText } from '/i18n.js';

export const postgresHistoryMessages = {
  'target-changed': 'The PostgreSQL target could not be verified. Rescan database configuration and select it again.',
  'container-stopped': 'Start Project PostgreSQL and check the migration history again.',
  'loopback-ambiguous': 'Both IPv4 and IPv6 are listening. Use an explicit loopback address in the database URL.',
  authentication: 'PostgreSQL rejected the username or password.',
  database: 'The configured PostgreSQL database is missing.',
  server: 'No server responded on this port. Start PostgreSQL and check again.',
  permission: 'PostgreSQL denied access. Check the account permissions or server access rules.',
  tls: 'PostgreSQL could not establish the requested TLS connection.',
  client: 'Install psql and add it to PATH to check this database.',
  connection: 'Could not verify the PostgreSQL connection.'
};

export function labelledMigrationControl(text, control) {
  const label = document.createElement('label');
  const caption = document.createElement('span');
  setText(caption, text);
  label.append(caption, control);
  return label;
}

export function migrationHistoryName(value) {
  const input = document.createElement('input');
  input.required = true;
  input.spellcheck = false;
  input.maxLength = 63;
  input.pattern = '[A-Za-z_][A-Za-z0-9_]{0,62}';
  input.value = value;
  return input;
}
