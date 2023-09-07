import type { Host } from '../../../src/types';
import b from 'benny';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { suiteCommon, summaryName } from '../../utils';
import * as events from '../../../src/events';
import * as testsUtils from '../../../tests/utils';
import WebSocketServer from '../../../src/WebSocketServer';
import WebSocketClient from '../../../src/WebSocketClient';

async function main() {
  const logger = new Logger(`Stream1KB Bench`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  // Setting up initial state
  const data1KiB = Buffer.alloc(1024, 0xf0);
  const host = '127.0.0.1' as Host;
  const tlsConfig = await testsUtils.generateConfig('RSA');

  const wsServer = new WebSocketServer({
    config: {
      key: tlsConfig.key,
      cert: tlsConfig.cert,
    },
    logger,
  });

  wsServer.addEventListener(
    events.EventWebSocketServerConnection.name,
    async (e: events.EventWebSocketServerConnection) => {
      const conn = e.detail;
      conn.addEventListener(
        events.EventWebSocketConnectionStream.name,
        (streamEvent: events.EventWebSocketConnectionStream) => {
          const stream = streamEvent.detail;
          void Promise.allSettled([
            (async () => {
              // Consume data
              for await (const _ of stream.readable) {
                // Do nothing, only consume
              }
            })(),
            (async () => {
              // End writable immediately
              await stream.writable.close();
            })(),
          ]);
        },
      );
    },
  );
  await wsServer.start({
    host,
  });
  const client = await WebSocketClient.createWebSocketClient({
    host,
    port: wsServer.getPort(),
    logger,
    verifyCallback: async () => {},
  });

  // Running benchmark
  const summary = await b.suite(
    summaryName(__filename),
    b.add('send 1Kib of data over stream', async () => {
      const stream = await client.connection.streamNew();
      await Promise.all([
        (async () => {
          // Consume data
          for await (const _ of stream.readable) {
            // Do nothing, only consume
          }
        })(),
        (async () => {
          // Write data
          const writer = stream.writable.getWriter();
          await writer.write(data1KiB);
          await writer.close();
        })(),
      ]);
    }),
    ...suiteCommon,
  );
  await wsServer.stop({ force: true });
  await client.destroy({ force: true });
  return summary;
}

if (require.main === module) {
  void main();
}

export default main;
