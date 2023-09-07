import type { Host } from '../../../src/types';
import type { AddressInfo } from 'net';
import * as https from 'https';
import b from 'benny';
import * as ws from 'ws';
import { promise } from '@/utils';
import { suiteCommon, summaryName } from '../../utils';
import * as testsUtils from '../../../tests/utils';

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
    summaryName(__filename),
    b.add('send 1Kib of data over ws', async () => {
      const sendProm = promise();
      client.send(data1KiB, () => {
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

if (require.main === module) {
  void main();
}

export default main;
