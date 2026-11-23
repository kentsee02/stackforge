# Migration adapter test cases

This matrix covers Drizzle, Alembic, EF Core, Flyway, and Liquibase. Each upstream revision is fixed. Source checks exercise both StackForge import and clone. The clone tests use Git's local transport after fetching the exact public commit, so replay does not follow a moving branch.

## Run the suites

```sh
npm run check
npm test
npm run test:public-migrations
npm run test:database-integration
npm run test:development-postgres
npm run test:development-mysql
npm run test:migration-sql-server
npm run test:native-migrations
npm run test:browser
```

Use Node.js 22.12+ and Git. The public-repository suite needs GitHub access. Live database suites need Docker with Linux containers. The browser suite needs `npm ci` and `npx playwright install chromium`. The native suite may download pinned image and runtime packages on its first run.

The public live suite exercises original upstream migrations on disposable project PostgreSQL and MySQL instances. The EF Core option additionally runs the pinned example's design-time build in an SDK container. It copies the public checkout into the container and uses the EF CLI to generate the scripts. The selected Docker databases and local test checkouts are temporary.

```sh
npm run test:public-migrations -- --postgres --ef-cli
npm run test:public-migrations -- --postgres --case=PUB-05 --case=PUB-09
npm run test:public-migrations -- --postgres --case=PUB-07
npm run test:native-migrations -- --structured-only
npm run test:native-migrations -- --mysql-only
npm run test:native-migrations -- --tags-only
npm run test:public-migrations -- --mysql --case=PUB-10 --case=PUB-11
```

## Public repositories and expected results

| Case | Upstream revision | Source checks through import and clone | Additional live checks |
| --- | --- | --- | --- |
| PUB-01 Drizzle | [nextjs/saas-starter](https://github.com/nextjs/saas-starter/tree/6e33e58b1e553a41fe22e6b941a7229a002de361) | Discover `drizzle.config.ts` and one PostgreSQL journal entry with no saved URL. | Save the temporary connection, apply the original journal, then verify it is current. |
| PUB-02 Alembic | [fastapi/full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template/tree/77e550a73bb49dd2967622c5ed11bf7a49603c93) | Find all five revisions under the nested backend's `alembic.ini`. | Upgrade to the first revision, verify the head, downgrade to `base`, apply the full chain and verify current history. |
| PUB-03 EF Core | [dotnet/eShop](https://github.com/dotnet/eShop/tree/ab10e4c68fd26369578ebfb3fd1ccf3b867d0444) | Find nine migrations across four .NET projects, including a separate infrastructure project. | Source coverage. |
| PUB-04 EF Core | [ModularMonolithSharedDbContextSample](https://github.com/I-RzR-I/ModularMonolithSharedDbContextSample/tree/aa79eeffb5a4a02785e24c500d2524a3095d3adb) | Find ten assemblies with separate Identity and Document contexts across five layouts. | Export the real v1 Document migration and its reverse SQL with `dotnet ef`. Apply and roll back on PostgreSQL using the custom `doc` history schema. |
| PUB-05 Flyway | [Java Spring Boot samples](https://github.com/nanotaboada/java.samples.spring.boot/tree/2cbc59f0d968951a5f80b6624ec1fd27c93363ed) | Find three SQL migrations from Spring Boot's classpath location. | Add a test-only PostgreSQL declaration. Keep the native Spring configuration and SQL intact. The full run must fail as a group because the seed migrations insert SQLite-style integer values into PostgreSQL Boolean columns. Apply to V1 and verify its checksum and that V2 and V3 remain pending. |
| PUB-06 Flyway | [Maven profile example](https://github.com/BootcampToProd/flyway-with-spring-boot-maven/tree/046d4ae118e99f9197bea434daf870873c789b2e) | Keep the dev, stage and prod configurations separate and retain the disabled runtime source. | Source coverage. |
| PUB-07 Liquibase | [Spring Boot Liquibase example](https://github.com/h3yzack/springboot3-liquibase-example/tree/baa98678824b59476bf09805ac516e4aa8729916) | Find four changesets through both the Maven and Spring declarations. | Apply all four unchanged changesets through the original Spring Boot YAML changelog and its classpath `includeAll`. Verify all four recorded identities. |
| PUB-08 Liquibase | [JHipster sample app](https://github.com/jhipster/jhipster-sample-app/tree/6b000b5d23a36c45e01472471b84a44fa2464044) | Resolve the nested XML changelog and its 12 changesets. | Source coverage. |
| PUB-09 Liquibase | [Liquibase PostgreSQL formatted SQL fixture](https://github.com/liquibase/liquibase/blob/75773ed9b45b0a5adf3c42872d2e5494da669427/liquibase-integration-tests/src/test/resources/changelogs/pgsql/complete/basic.formatted.sql) | Import the upstream SQL file with a test-only properties file that points to it. | Apply the original changeset and check its recorded history. The native suite separately tests rollback. |
| PUB-10 Flyway | [Spring Boot Flyway demo](https://github.com/talenteddeveloper/spring-boot-flyway-demo/tree/77403a2a10af102452b6f026bf6473021decbf99) | Detect the two versioned migrations in Spring Boot's default classpath location. | Apply the original table and seed migrations on MySQL 8.4 and verify both checksums. |
| PUB-11 Liquibase | [Liquibase MySQL table and view fixture](https://github.com/liquibase/liquibase/blob/75773ed9b45b0a5adf3c42872d2e5494da669427/liquibase-integration-tests/src/test/resources/changelogs/mysql/complete/createtable.and.view.changelog.xml) | Import the original XML with a test-only properties file that points to it. | Create the table and view on MySQL 8.4, verify their history, then preview and roll them back in reverse order. |

## Adapter-specific cases

| Case | Scenario | Expected result | Automated suite |
| --- | --- | --- | --- |
| DRZ-01 | PostgreSQL v7 journal with missing or conflicting configuration | Files can appear as unverified. Connection and writes stay blocked. | `test`, `test:public-migrations` |
| DRZ-02 | Pending, applied, altered or mismatched journal history | Timestamps and file hashes determine states. Unmatched history blocks the plan. | `test:development-postgres` |
| DRZ-03 | Supported additive SQL and failing SQL in the same batch | Changes and history commit together. An error rolls back the entire batch. | `test:development-postgres` |
| DRZ-04 | Unsupported SQL or an altered approval | Block execution. A fresh supported plan requires exact database-name confirmation. | `test`, `test:development-postgres` |
| DRZ-05 | Project PostgreSQL migration renames and drops columns and inserts data | Display the full pending SQL and verify resulting columns, rows and Drizzle history. If SQL alters approved history, roll back the entire batch. | `test:development-postgres` |
| DRZ-06 | Reviewed explicit rollback SQL to an earlier journal revision | Reject escaped paths and stale scripts. Preserve tables and history when the script fails or is cancelled. End the cancelled PostgreSQL session. On success remove only the selected revision suffix and verify migrations can be reapplied. | `test:development-postgres`, `test:browser` |
| ALE-01 | Linear, branching, merging, incomplete and dynamic Python revisions | Verify literal DAGs and flag unresolved, duplicate or linked sources. | `test` |
| ALE-02 | Default or customized PostgreSQL version table | Compare the selected table. Report missing, restricted, conflicting or replaced targets. | `test:development-postgres`, `test:database-integration` |
| ALE-03 | Upgrade a public sequence to a known revision; downgrade and replay | After each operation, recorded heads match the selected target. | `test:public-migrations -- --postgres` |
| ALE-04 | Multiple branch heads and rollback | Apply all heads. Require an explicit branched rollback target and verify the empty head set after downgrading to `base`. | `test:native-migrations` |
| EF-01 | Split partial classes, custom directories, BOM and multiple contexts | Keep each migration in its own project and `DbContext`. Flag duplicate or unresolved declarations. | `test`, `test:public-migrations` |
| EF-02 | Default and custom history tables on PostgreSQL and SQL Server | Report missing, pending, applied or conflicting history. Keep credentials out of API results. | `test:development-postgres`, `test:migration-sql-server` |
| EF-03 | Reviewed PostgreSQL apply and rollback SQL | Verify the selected context and migration range, then check the exact history in the same transaction before commit. | `test:native-migrations`, PUB-04 |
| EF-04 | Wrong history, stale SQL, escaped path, client meta-command or malformed SQL | Roll back the whole write on history mismatch. Reject altered and unsafe input. | `test`, `test:native-migrations` |
| FLY-01 | CLI, Spring Boot, Maven profiles and Gradle paths | Discover local SQL in numeric version order. Report duplicates, unavailable files and unsupported settings. | `test`, `test:public-migrations` |
| FLY-02 | PostgreSQL and MySQL history, versioned checksums and repeatables | Report applied, changed, outdated and unverifiable records with custom table support. | `test:development-postgres`, `test:development-mysql` |
| FLY-03 | Native grouped apply, repeatable replay, error or cancellation | Confirm valid history after writes. Roll back a failing group and clear the cancelled session. | `test:native-migrations`, PUB-05 |
| FLY-04 | Native MySQL version target and a later failing migration | Verify the first version. Report failure when DDL committed before a later statement failed, and retain the failed Flyway history row for diagnosis. | `test:native-migrations -- --mysql-only`, PUB-10 |
| LIQ-01 | Structured and formatted changelogs, includes and logical paths | Inspect supported declarations and flag repeated identities, cycles and unreadable files. | `test`, `test:public-migrations` |
| LIQ-02 | PostgreSQL and MySQL history with executed and marked-ran entries | Match changeset identity and distinguish marked-ran records. Reject incompatible history tables. | `test:development-postgres`, `test:development-mysql` |
| LIQ-03 | Native apply, rollback of one or several changesets, and replay | Preview rollback statements in reverse apply order. Reject an invalid or altered count. Verify history after each operation. | `test:native-migrations`, PUB-09 |
| LIQ-04 | A JSON root includes YAML and XML changelogs | Preserve declaration order and file identities. Reject approval after an included resource changes. Verify that rollback preview leaves the tables and history intact, then confirm that native rollback removes both the tables and their history rows. | `test:native-migrations -- --structured-only` |
| LIQ-05 | Unsafe includes, external data-file declarations, custom runtime change types and encoded property expressions | Refuse to stage execution. Keep supported read-only discovery evidence. | `test` |
| LIQ-06 | Native MySQL structured rollback and cancellation | Keep the database unchanged during SQL preview. Verify rolled-back tables and history. Cancel a running worker and check that its MySQL session and remaining changes are gone. | `test:native-migrations -- --mysql-only`, PUB-11 |
| LIQ-07 | Rollback using a recorded tag on PostgreSQL and MySQL | Suggest unique recorded tags. Refuse missing tags, duplicate tags, and requests that combine a tag with a count. Verify that native rollback retains a manually tagged row and honors the changelog's tag retention setting. | `test:native-migrations -- --tags-only`, `test:browser` |
| FLOW-01 | Mismatched confirmation, altered files, shared or replaced target | Refuse the write. Use a fresh approval after changes. | `test:native-migrations`, `test:development-postgres` |
| FLOW-02 | Verified backup recovery to a fresh PostgreSQL database | Refuse a populated restore target. On an eligible empty target, restore the archive and verify migration history. | `test:native-migrations` |
| FLOW-03 | Imported and cloned Projects views in English and Chinese | Render file previews, statuses and confirmation controls. Exact database-name matching gates execution. | `test:browser` |
| FLOW-04 | MySQL database is recreated with the same name, or shared by another project | Reject the old plan after recreation. Reject execution against a shared endpoint. | `test:native-migrations -- --mysql-only` |

## Remaining coverage

- Drizzle writes cover supported PostgreSQL journal v7 migrations, with common transactional changes and reviewed SQL rollback on project PostgreSQL. Additional engines, journal formats and arbitrary runtime SQL remain open. Recovery also supports a verified database archive.
- Alembic writes cover supported revisions that use the staged runtime and version graph. Project-specific `env.py`, project imports, external dependencies, `depends_on` and nontransactional migrations need their own execution path.
- EF Core executes reviewed PostgreSQL SQL exports. Direct project-tool invocation and SQL Server writes remain separate coverage. The real SQL Server test currently checks history.
- Flyway writes cover supported standalone and Spring Boot properties configurations on project PostgreSQL and MySQL. Maven and Gradle runtime integration and licensed Undo remain open.
- Liquibase writes cover supported formatted SQL and declarative XML, YAML and JSON changelogs on project PostgreSQL and MySQL, with rollback by count or recorded tag. Runtime-dependent migrations, external CSV or SQL resources, and context or label filters remain open. PUB-08 covers source discovery.
- A history match verifies recorded migrations. Schema drift and data correctness need separate checks.
