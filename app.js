const express = require('express');
require('dotenv').config();
const path = require('path');
const http = require('http');
const session = require('express-session');
const database = require('./src/database');
const { seedTestData } = require('./src/lib/testDataSeed');
const emailService = require('./src/services/emailService');
const { authRedirect } = require('./src/middleware/auth');
const { initSocket } = require('./src/lib/socket');
const { addWorkingDays } = require('./src/lib/strDraft');
const {
  isValidTransactionId,
  selectRfiDeliveryRecipient,
  validateRfiAccess,
  validateRfiRequestBody,
} = require('./src/lib/rfiWorkflow');
const { validateStrTransition, autoAssignStaleCases, backfillCaseDueDates } = require('./controllers/transactionsController');

const app = express();
const PORT = process.env.PORT || 3000;
app.locals.emailService = emailService;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'transaction-monitor-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.currentRole = req.session.user?.role || null;
  next();
});

const server = http.createServer(app);
initSocket(server);

app.use(authRedirect);
app.use(require('./routes/auth'));
app.use(require('./routes/admin'));
app.use(require('./routes/analyst'));
app.use(require('./routes/seniorAnalyst'));
app.use(require('./routes/stro'));
app.use(require('./routes/transactions'));

async function startServer() {
  await database.initDatabase();
  await database.ensurePartnerSchema();

  if (database.isEnabled()) {
    const result = await seedTestData(database);
    if (result.seeded) {
      console.log(`Seeded test data: ${result.imported} transactions imported, ${result.flagged} flagged.`);
    }
    if (result.repaired) {
      console.log(`Repaired profile risk: ${result.repaired.updated} transactions updated, ${result.repaired.positiveProfileContributions} with profile contribution points.`);
    }
    await backfillCaseDueDates().catch((error) => {
      console.error(`Case due-date backfill failed: ${error.message}`);
    });
  }

  server.listen(PORT, () => {
    console.log(`UNIWEB local (domestic) card-payment monitoring running on http://localhost:${PORT} - any Singapore merchant profile, MCC-driven risk classification`);
  });

  server.on('error', (error) => {
    console.error(`Server failed to listen on port ${PORT}: ${error.message}`);
    process.exit(1);
  });

  setInterval(() => {
    autoAssignStaleCases().catch((error) => {
      console.error(`Stale case auto-assign failed: ${error.message}`);
    });
    backfillCaseDueDates().catch((error) => {
      console.error(`Case due-date backfill failed: ${error.message}`);
    });
  }, 60 * 1000);
}

app.locals.assignmentHelpers = {
  addWorkingDays,
};
app.locals.strWorkflowHelpers = {
  validateStrTransition,
};
app.locals.rfiWorkflowHelpers = {
  isValidTransactionId,
  selectRfiDeliveryRecipient,
  validateRfiAccess,
  validateRfiRequestBody,
};

if (require.main === module) {
  startServer().catch((error) => {
    console.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  });
}

module.exports = app;
