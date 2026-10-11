const express = require('express');

const routes = require('./routes');
const requestId = require('./middleware/request-id.middleware');
const { errorHandler, notFound } = require('./utils/api-error');

const app = express();

app.disable('x-powered-by');
app.use(requestId);
app.use(express.json({ limit: '32kb' }));

app.use(routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
