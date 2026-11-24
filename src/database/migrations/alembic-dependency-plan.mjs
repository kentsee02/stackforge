import { posix } from 'node:path';
import { runMigrationContainer } from '../docker/migration-container.mjs';

// Keep project Python out of the planner. Alembic runs no-op revisions generated from the verified declarations.
const planner = `import json, sys
from alembic import command
from alembic.config import Config
from alembic.util import CommandError

operation, revision = sys.argv[1:]
with open("/stackforge/heads.json", encoding="utf-8") as input_file:
    heads = json.load(input_file)
config = Config()
config.set_main_option("script_location", "/stackforge/alembic")
config.attributes.update(heads=heads, steps=[])
try:
    if operation == "apply":
        command.upgrade(config, revision, sql=True)
    else:
        command.downgrade(config, "base:" + revision, sql=True)
except CommandError:
    print(json.dumps({"invalid": True}))
    sys.exit(0)
print(json.dumps({"expected": sorted(config.attributes["heads"]), "steps": config.attributes["steps"]}))
`;

const environment = `from io import StringIO
from alembic import context

state = context.config.attributes
def record_step(ctx, step, heads, run_args):
    state["steps"].append(step.up_revision_id)
    state["heads"] = heads

context.configure(dialect_name="postgresql", starting_rev=tuple(state["heads"]),
                  output_buffer=StringIO(), on_version_apply=record_step)
with context.begin_transaction():
    context.run_migrations()
`;

function pythonRevisions(ids) {
  if (!ids.length) return 'None';
  if (ids.length === 1) return JSON.stringify(ids[0]);
  return '(' + ids.map(id => JSON.stringify(id)).join(', ') + ')';
}

export async function planAlembicDependencies({ revisions, heads, operation, selected, scope, image, directory, signal }) {
  const invalid = 'Choose a revision in the requested migration direction.';
  const files = new Map([['run.py', planner], ['heads.json', JSON.stringify(heads)], ['alembic/env.py', environment]]);
  for (const { file, revision, parents, dependencies } of revisions) {
    files.set('alembic/versions/' + posix.basename(file), [
      'revision = ' + JSON.stringify(revision),
      'down_revision = ' + pythonRevisions(parents),
      'depends_on = ' + pythonRevisions(dependencies),
      'branch_labels = None',
      'def upgrade(): pass',
      'def downgrade(): pass'
    ].join('\n') + '\n');
  }
  let plan;
  try {
    const output = await runMigrationContainer({ ...scope, offline: true, image, args: [operation, selected], files, directory,
      signal, env: { PYTHONHASHSEED: '0' }, verify: () => scope.verify() });
    plan = JSON.parse(output);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Could not preview Alembic dependencies. Check Docker and try again.');
  }
  if (plan.invalid) throw new Error(invalid);
  const indexed = new Map(revisions.map(row => [row.revision, row]));
  const { expected, steps } = plan;
  const known = ids => Array.isArray(ids) && new Set(ids).size === ids.length && ids.every(id => indexed.has(id));
  if (!known(expected) || !known(steps) || !steps.length) throw new Error(invalid);
  return { expected, range: steps.map(id => indexed.get(id)) };
}
