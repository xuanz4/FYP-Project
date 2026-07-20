require('dotenv').config();
const { createSchema } = require('../src/lib/dbProvision');

createSchema()
  .then(() => {
    console.log('Database created from FYP_Transaction_Monitoring.sql');
    console.log('Run `npm run import:test-data` next to load the partner transaction history.');
  })
  .catch((error) => {
    console.error(`Database setup failed: ${error.message}`);
    process.exit(1);
  });
