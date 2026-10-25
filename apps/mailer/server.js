#!/usr/bin/env node
'use strict';

/**
 * ManuMail: herramienta de email marketing autoalojada.
 *
 *   PORT=3000 DATA_DIR=./data node server.js
 */

const http = require('http');
const path = require('path');
const { Store } = require('./src/store');
const { createTransport } = require('./src/transport');
const { createSender } = require('./src/sender');
const { createApp } = require('./src/app');

const port = Number(process.env.PORT) || 3000;
const store = new Store(process.env.DATA_DIR || path.join(__dirname, 'data'));
const transport = createTransport(store);
const sender = createSender(store, transport);
const server = http.createServer(createApp({ store, transport }));

server.listen(port, () => {
  console.log(`ManuMail en http://localhost:${port}`);
  console.log(`Envio: ${transport.describe()}`);
  sender.start();
});

function shutdown() {
  sender.stop();
  store.save();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
