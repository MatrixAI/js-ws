import type { Host } from '../../../src/types.js';
import type { AddressInfo } from 'net';
import * as https from 'node:https';
import url from 'node:url';
import b from 'benny';
import * as ws from 'ws';
import { suiteCommon, summaryName } from '../../utils.js';
import * as testsUtils from '../../../tests/utils.js';
import { promise } from '#utils.js';

const filePath = url.fileURLToPath(import.meta.url);

async function main() {
  // Setting up initial state
  const data1KiB = Buffer.alloc(1024, 0xf0);
  const host = '127.0.0.1' as Host;
  const tlsConfig = await testsUtils.generateConfig('RSA');

  const listenProm = promise();

  const httpsServer = https.createServer({
    ...tlsConfig,
  });
  const wsServer = new ws.WebSocketServer({
    server: httpsServer,
  });
  httpsServer.listen(0, host, listenProm.resolveP);

  await listenProm.p;

  const address = httpsServer.address() as AddressInfo;

  const openProm = promise();

  const client = new ws.WebSocket(`wss://${host}:${address.port}`, {
    rejectUnauthorized: false,
  });

  client.on('open', openProm.resolveP);

  await openProm.p;

  // Running benchmark
  const summary = await b.suite(
    summaryName(filePath),
    b.add('send 1KiB of data over ws', async () => {
      const sendProm = promise();
      client.send(data1KiB, { binary: true }, () => {
        sendProm.resolveP();
      });
      await sendProm.p;
    }),
    ...suiteCommon,
  );
  client.close();
  wsServer.close();
  httpsServer.close();
  return summary;
}

if (import.meta.url.startsWith('file:')) {
  const modulePath = url.fileURLToPath(import.meta.url);
  if (process.argv[1] === modulePath) {
    void main();
  }
}

export default main;
