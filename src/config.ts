import type { WebSocketConfig } from './types.js';

const connectTimeoutTime = Infinity;

const serverDefault: WebSocketConfig = {
  keepAliveIntervalTime: Infinity,
  keepAliveTimeoutTime: Infinity,
  streamBufferSize: 1 * 1024 * 1024, // 1MB
  verifyPeer: false,
};

const clientDefault: WebSocketConfig = {
  keepAliveIntervalTime: Infinity,
  keepAliveTimeoutTime: Infinity,
  streamBufferSize: 1 * 1024 * 1024, // 1MB
  verifyPeer: true,
};

export { connectTimeoutTime, serverDefault, clientDefault };
