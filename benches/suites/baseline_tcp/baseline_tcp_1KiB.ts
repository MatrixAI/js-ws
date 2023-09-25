import type { Host } from '../../../src/types';
import * as net from 'net';
import b from 'benny';
import { promise } from '@/utils';
import { suiteCommon, summaryName } from '../../utils';

async function main() {
  // Setting up initial state
  const data1KiB = Buffer.alloc(1024, 0xf0);
  const host = '127.0.0.1' as Host;

  const listenProm = promise();

  const server = net.createServer((socket) => {
    // Noop to drop the data
    socket.on('data', () => {});
  });
  server.listen(0, host, listenProm.resolveP);

  await listenProm.p;

  const address = server.address() as net.AddressInfo;

  const connectProm = promise();

  const client = net.createConnection(
    {
      port: address.port,
      host,
    },
    connectProm.resolveP,
  );

  await connectProm.p;

  // Running benchmark
  const summary = await b.suite(
    summaryName(__filename),
    b.add('send 1KiB of data over tcp', async () => {
      const prom = promise();
      client.write(data1KiB, () => {
        prom.resolveP();
      });
      await prom.p;
    }),
    ...suiteCommon,
  );
  client.end();
  server.close();
  return summary;
}

if (require.main === module) {
  void main();
}

export default main;
