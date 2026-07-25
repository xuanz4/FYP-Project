// Creates the database + schema from FYP_Transaction_Monitoring.sql. Used both by the
// `npm run db:init` CLI and by database.js's auto-provisioning on server startup when the
// configured database doesn't exist yet.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function splitSqlStatements(sql) {
  const statements = [];
  let delimiter = ';';
  let buffer = '';

  for (const line of sql.split(/\r?\n/)) {
    const trimmed = line.trim();
    const delimiterMatch = trimmed.match(/^DELIMITER\s+(.+)$/i);

    if (delimiterMatch) {
      delimiter = delimiterMatch[1];
      continue;
    }

    buffer += `${line}\n`;
    if (buffer.trimEnd().endsWith(delimiter)) {
      statements.push(buffer.trimEnd().slice(0, -delimiter.length).trim());
      buffer = '';
    }
  }

  if (buffer.trim()) statements.push(buffer.trim());
  return statements.filter(Boolean);
}

// The first three statements in FYP_Transaction_Monitoring.sql (DROP DATABASE IF EXISTS /
// CREATE DATABASE / USE) assume the app's login owns the whole MySQL server - true on a
// personal local install, not true on a shared/managed server (e.g. a lecturer-provisioned
// Azure database) where the database already exists and the login is usually only granted
// rights inside it, not CREATE DATABASE/DROP DATABASE. Strips comment lines before checking
// so it still matches a statement that starts with one of these after its leading comment
// block (see the header comment above DROP DATABASE in the SQL file).
function isDatabaseLevelStatement(statement) {
  const withoutComments = statement
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .trim();
  return /^(DROP DATABASE|CREATE DATABASE|USE)\b/i.test(withoutComments);
}

async function createSchema() {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'FYP_Transaction_Monitoring.sql'), 'utf8');
  let statements = splitSqlStatements(sql);

  // Set DB_AUTO_CREATE=false for a shared/managed server where the database already exists
  // and your login can't create or drop databases (e.g. Azure). This skips the DROP/CREATE
  // DATABASE/USE statements and builds the tables directly inside DB_NAME instead. Left unset
  // (or "true"), behaviour is unchanged: a personal local MySQL server gets the database
  // dropped and recreated fresh, exactly as before.
  const autoCreate = process.env.DB_AUTO_CREATE !== 'false';
  const connectionConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    // See src/database.js for the same DB_SSL/DB_SSL_REJECT_UNAUTHORIZED handling - kept
    // consistent so `npm run db:init` connects the same way the running app does.
    ...(process.env.DB_SSL === 'true'
      ? { ssl: { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } }
      : {}),
  };

  if (!autoCreate) {
    if (!process.env.DB_NAME) {
      throw new Error('DB_NAME must be set when DB_AUTO_CREATE=false - the database must already exist on the server.');
    }
    connectionConfig.database = process.env.DB_NAME;
    statements = statements.filter((statement) => !isDatabaseLevelStatement(statement));
  }

  const connection = await mysql.createConnection(connectionConfig);

  try {
    for (const statement of statements) {
      await connection.query(statement);
    }
  } finally {
    await connection.end();
  }
}

module.exports = { createSchema };
