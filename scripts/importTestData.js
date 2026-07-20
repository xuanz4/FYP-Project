require('dotenv').config();
const database = require('../src/database');
const { seedTestData } = require('../src/lib/testDataSeed');

async function main() {
  const connected = await database.initDatabase();
  if (!connected) throw new Error('Could not connect to the database - check .env DB_* settings.');

  const result = await seedTestData(database);
  if (!result.seeded) {
    console.log('Test data already imported (first row already present) - nothing to do.');
    return;
  }

  console.log(`Done. ${result.imported} transactions imported, ${result.flagged} flagged (cases auto-opened by DB trigger).`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Import failed:', error);
    process.exit(1);
  });
