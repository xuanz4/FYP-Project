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

async function createSchema() {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'FYP_Transaction_Monitoring.sql'), 'utf8');
  const statements = splitSqlStatements(sql);
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });

  try {
    for (const statement of statements) {
      await connection.query(statement);
    }
  } finally {
    await connection.end();
  }
}

module.exports = { createSchema };
