import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server;
let DB;
let exportSQL;
let getIssues;
let i18n;
let parseDefault;

before(async () => {
  server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
  });

  const [constants, exportSQLModule, issues, i18nModule, shared] =
    await Promise.all([
      server.ssrLoadModule("/src/data/constants.js"),
      server.ssrLoadModule("/src/utils/exportSQL/index.js"),
      server.ssrLoadModule("/src/utils/issues.js"),
      server.ssrLoadModule("/src/i18n/i18n.js"),
      server.ssrLoadModule("/src/utils/exportSQL/shared.js"),
    ]);

  DB = constants.DB;
  exportSQL = exportSQLModule.exportSQL;
  getIssues = issues.getIssues;
  i18n = i18nModule.default;
  parseDefault = shared.parseDefault;
});

after(async () => {
  await server?.close();
});

function makeField(name, type, defaultValue, options = {}) {
  return {
    name,
    type,
    default: defaultValue,
    size: options.size,
    notNull: options.notNull ?? false,
    primary: options.primary ?? false,
    unique: false,
    increment: false,
    isArray: false,
    check: "",
    comment: "",
  };
}

function makeDiagram(database, fields) {
  return {
    database,
    enums: [],
    types: [],
    references: [],
    relationships: [],
    views: [],
    tables: [
      {
        id: "table-id",
        name: "defaults",
        comment: "",
        inherits: [],
        indices: [],
        uniqueConstraints: [],
        fields,
      },
    ],
  };
}

function defaultIssue(fieldName) {
  return i18n.t("default_doesnt_match_type", {
    tableName: "defaults",
    fieldName,
  });
}

test("PostgreSQL validates and exports string defaults without losing content", () => {
  const diagram = makeDiagram(DB.POSTGRES, [
    makeField("id", "INTEGER", "", { primary: true }),
    makeField("text_value", "TEXT", "normal string"),
    makeField("varchar_value", "VARCHAR", "normal string", { size: "" }),
    makeField("sized_boundary", "VARCHAR", "abc", { size: "3" }),
    makeField("sized_too_long", "VARCHAR", "abcd", { size: "3" }),
    makeField("quoted_boundary", "VARCHAR", '"abc"', { size: "5" }),
    makeField("quoted_too_long", "VARCHAR", '"abc"', { size: "4" }),
    makeField("empty_string", "VARCHAR", "''", { size: "3" }),
    makeField("blank_default", "TEXT", ""),
    makeField("sql_null", "TEXT", "NULL"),
    makeField("not_null_sql_null", "TEXT", "NULL", { notNull: true }),
    makeField("apostrophe", "TEXT", "O'Brien"),
    makeField("whitespace", "TEXT", "   "),
    makeField("double_quote", "TEXT", '"'),
    makeField("single_quote", "TEXT", "'"),
  ]);
  const issues = getIssues(diagram);
  const sql = exportSQL(diagram);

  for (const fieldName of [
    "text_value",
    "varchar_value",
    "sized_boundary",
    "quoted_boundary",
    "empty_string",
  ]) {
    assert.equal(issues.includes(defaultIssue(fieldName)), false, fieldName);
  }
  for (const fieldName of ["sized_too_long", "quoted_too_long"]) {
    assert.equal(issues.includes(defaultIssue(fieldName)), true, fieldName);
  }
  assert.equal(
    issues.includes(
      i18n.t("not_null_is_null", {
        tableName: "defaults",
        fieldName: "not_null_sql_null",
      }),
    ),
    true,
  );

  assert.match(sql, /"text_value" TEXT DEFAULT 'normal string'/);
  assert.match(sql, /"varchar_value" VARCHAR DEFAULT 'normal string'/);
  assert.match(sql, /"sized_boundary" VARCHAR\(3\) DEFAULT 'abc'/);
  assert.match(sql, /"sized_too_long" VARCHAR\(3\) DEFAULT 'abcd'/);
  assert.match(sql, /"quoted_boundary" VARCHAR\(5\) DEFAULT '"abc"'/);
  assert.match(sql, /"quoted_too_long" VARCHAR\(4\) DEFAULT '"abc"'/);
  assert.match(sql, /^\t"empty_string" VARCHAR\(3\) DEFAULT '',$/m);
  assert.match(sql, /"blank_default" TEXT(?! DEFAULT)/);
  assert.match(sql, /"sql_null" TEXT DEFAULT NULL/);
  assert.match(sql, /"not_null_sql_null" TEXT NOT NULL DEFAULT NULL/);
  assert.match(sql, /"apostrophe" TEXT DEFAULT 'O''Brien'/);
  assert.match(sql, /"whitespace" TEXT DEFAULT ' {3}'/);
  assert.match(sql, /"double_quote" TEXT DEFAULT '"'/);
  assert.match(sql, /"single_quote" TEXT DEFAULT ''''/);
});

test("shared default parsing remains unchanged for other database engines", () => {
  const cases = [
    [DB.MYSQL, "VARCHAR"],
    [DB.MARIADB, "VARCHAR"],
    [DB.MSSQL, "VARCHAR"],
    [DB.SQLITE, "VARCHAR"],
    [DB.ORACLESQL, "VARCHAR2"],
    [DB.GENERIC, "VARCHAR"],
  ];

  for (const [database, type] of cases) {
    assert.equal(
      parseDefault({ type, default: "O'Brien" }, database),
      "'O''Brien'",
      database,
    );
    assert.equal(
      parseDefault({ type, default: "NULL" }, database),
      "NULL",
      database,
    );
    assert.equal(
      parseDefault({ type, default: "''" }, database),
      "''''''",
      database,
    );
    assert.equal(
      parseDefault({ type, default: '"' }, database),
      "'\"'",
      database,
    );
  }
});

test("non-PostgreSQL exporters retain their existing shared escaping", () => {
  const cases = [
    [DB.MYSQL, "VARCHAR", /`value` VARCHAR DEFAULT 'O''Brien'/],
    [DB.MARIADB, "VARCHAR", /`value` VARCHAR DEFAULT 'O''Brien'/],
    [DB.MSSQL, "VARCHAR", /\[value\] VARCHAR DEFAULT 'O''Brien'/],
    [DB.SQLITE, "VARCHAR", /"value" VARCHAR DEFAULT 'O''Brien'/],
    [DB.ORACLESQL, "VARCHAR2", /"value" VARCHAR2 DEFAULT 'O''Brien'/],
  ];

  for (const [database, type, valuePattern] of cases) {
    const diagram = makeDiagram(database, [
      makeField("value", type, "O'Brien"),
      makeField("null_value", type, "NULL"),
      makeField("quote_pair", type, "''"),
    ]);
    const sql = exportSQL(diagram);

    assert.match(sql, valuePattern, database);
    assert.match(sql, /DEFAULT NULL/, database);
    assert.match(sql, /DEFAULT ''''''/, database);
  }
});
