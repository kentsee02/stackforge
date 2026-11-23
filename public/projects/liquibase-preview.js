import { setText } from '/i18n.js';
import { markUnverified, migrationHistoryState, migrationSourcePreview } from '/projects/migration-source-preview.js';

const messages = {
  ready: 'Local Liquibase changesets found. Database history is unverified.',
  partial: 'Some Liquibase declarations need review. Check the listed files and duplicate changesets.',
  empty: 'No Liquibase changesets were found in the selected changelog.',
  disabled: 'Liquibase is disabled in this configuration.',
  'unsupported-config': 'This Liquibase configuration could not be resolved. Check the changelog path and search settings.'
};
const scopes = { standalone: 'Liquibase CLI', spring: 'Spring Boot', maven: 'Maven' };

export function liquibasePreview(projectId, source, services) {
  return migrationSourcePreview(projectId, source, services, {
    adapter: 'liquibase', tableName: 'databasechangelog', title: 'Preview Liquibase changesets', reading: 'Reading Liquibase changelogs…',
    rescan: 'Rescan Liquibase files', scope: scopes[source.scope], messages,
    render(result, relativePath) {
      const root = document.createElement('p');
      root.className = 'hint';
      root.hidden = !result.changelog;
      root.textContent = result.changelog ? relativePath(result.changelog) : '';
      const issues = document.createElement('p');
      issues.className = 'hint';
      issues.hidden = !result.issues.length;
      if (result.issues.length) setText(issues, ['Files to review', result.issues.map(relativePath).join(' · ')]);
      const rows = document.createElement('ul');
      rows.className = 'check-list';
      for (const [index, item] of result.changes.entries()) {
        const row = document.createElement('li');
        const id = document.createElement('code');
        id.textContent = item.id;
        row.append(id, ' · ', item.author, ' · ', relativePath(item.file));
        if (!item.verified) markUnverified(row);
        migrationHistoryState(row, result.database?.items?.[index]?.state);
        rows.append(row);
      }
      return [root, issues, rows];
    }
  });
}
