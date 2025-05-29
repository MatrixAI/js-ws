import type { Host } from '#types.js';
import path from 'node:path';
import url from 'node:url';
import b from 'benny';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { suiteCommon } from './utils/utils.js';
import * as testsUtils from '../tests/utils.js';
import * as events from '#events.js';
import WebSocketServer from '#WebSocketServer.js';
import WebSocketClient from '#WebSocketClient.js';

const filePath = url.fileURLToPath(import.meta.url);

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
    port: wsServer.port,
    logger,
    config: {
      verifyPeer: false,
    },
  });

  const stream = await client.connection.newStream();
  const writer = stream.writable.getWriter();

  const readProm = (async () => {
    // Consume data
    for await (const _ of stream.readable) {
      // Do nothing, only consume
    }
  })();

  // Running benchmark
  const summary = await b.suite(
    path.basename(filePath, path.extname(filePath)),
    b.add('send 1KiB of data over stream', async () => {
      await writer.write(data1KiB);
    }),
    ...suiteCommon,
  );
  await wsServer.stop({ force: true });
  await client.destroy({ force: true });
  await readProm;
  return summary;
}

if (import.meta.url.startsWith('file:')) {
  const modulePath = url.fileURLToPath(import.meta.url);
  if (process.argv[1] === modulePath) {
    void main();
  }
}

export default main;
