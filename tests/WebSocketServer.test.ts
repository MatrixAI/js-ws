import type { WebSocketServerConnectionEvent } from '@/events';
import WebSocketServer from '@/WebSocketServer';
import { WebSocket } from 'ws';
import * as testsUtils from './utils';

describe('test', () => {
  beforeEach(() => {

  });
  test('test', async () => {
    const tlsConfigServer = await testsUtils.generateConfig('RSA');
    const server = new WebSocketServer({
      config: {
        ...tlsConfigServer,
      },
    });
    server.start({
      port: 3000,
    });
    server.addEventListener(
      'serverConnection',
      async (event: WebSocketServerConnectionEvent) => {
        const connection = event.detail;
        const stream = await connection.streamNew('bidi');
        const writer = stream.writable.getWriter();
        await writer.ready;
        writer.write(new Uint8Array([1, 2, 3]));
        writer.write(new Uint8Array([1, 2, 3]));
      },
    );
  });
});
