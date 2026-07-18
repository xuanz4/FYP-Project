const fs = require('fs');
const path = require('path');
require('dotenv').config();

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

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'FYP_Transaction_Monitoring_test.sql'), 'utf8');
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
    console.log('Database created from FYP_Transaction_Monitoring_test.sql');
    console.log('Run `npm run import:test-data` next to load the partner transaction history.');
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`Database setup failed: ${error.message}`);
  process.exit(1);
});
