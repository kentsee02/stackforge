import { setText } from '/i18n.js';
import { markUnverified, migrationHistoryState, migrationSourcePreview } from '/projects/migration-source-preview.js';

const messages = {
  ready: 'Local Flyway SQL migrations found. Database history is unverified.',
  partial: 'Some Flyway files need review. Check duplicate migrations, file names and migration folders.',
  empty: 'No Flyway SQL migrations were found in these folders.',
  disabled: 'Flyway is disabled in this configuration.',
  'unsupported-config': 'This Flyway configuration could not be resolved from local files. Check its migration locations and naming settings.'
};
const types = { versioned: 'Versioned migration', repeatable: 'Repeatable migration', baseline: 'Baseline migration', undo: 'Undo migration' };
const scopes = { standalone: 'Flyway CLI', spring: 'Spring Boot', maven: 'Maven', gradle: 'Gradle', runtime: 'JVM' };

export function flywayPreview(projectId, source, services) {
  return migrationSourcePreview(projectId, source, services, {
    adapter: 'flyway', tableName: 'flyway_schema_history', title: 'Preview Flyway migrations', reading: 'Reading Flyway migration files…',
    rescan: 'Rescan Flyway files', scope: scopes[source.scope], messages,
    render(result, relativePath) {
      const folders = document.createElement('p');
      folders.className = 'hint';
      folders.textContent = result.locations.map(relativePath).join(' · ');
      folders.hidden = result.locations.length === 0;
      const list = document.createElement('ul');
      list.className = 'check-list';
      for (const [index, item] of result.migrations.entries()) {
        const row = document.createElement('li');
        const kind = document.createElement('span');
        setText(kind, types[item.kind]);
        const file = document.createElement('code');
        file.textContent = relativePath(item.file);
        row.append(kind, ' · ', file);
        if (!item.verified) markUnverified(row);
        migrationHistoryState(row, result.database?.items?.[index]?.state);
        list.append(row);
      }
      return [folders, list];
    }
  });
}
