import { WebSocket } from 'ws';
import { EventWebSocketServerConnection } from '@/events';
import WebSocketServer from '@/WebSocketServer';
import { promise } from '@/utils';
import * as testsUtils from './utils';

describe('test', () => {
  beforeEach(() => {});
  test('test', async () => {
    const tlsConfigServer = await testsUtils.generateConfig('RSA');
    const server = new WebSocketServer({
      config: {
        ...tlsConfigServer,
      },
    });
    await server.start({
      port: 3000,
    });
    server.addEventListener(
      EventWebSocketServerConnection.name,
      async (event: EventWebSocketServerConnection) => {
        const connection = event.detail;
        const stream = await connection.streamNew('bidi');
        const writer = stream.writable.getWriter();
        await writer.ready;
        await writer.write(new Uint8Array([1, 2, 3]));
        await writer.write(new Uint8Array([1, 2, 3]));
      },
    );
  });
});
