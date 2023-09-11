import type { WebSocketConfig } from './types';

const serverDefault: WebSocketConfig = {
  connectTimeoutTime: Infinity,
  keepAliveIntervalTime: Infinity,
  keepAliveTimeoutTime: Infinity,
  streamBufferSize: 1 * 1024 * 1024, // 1MB
};

const clientDefault: WebSocketConfig = {
  connectTimeoutTime: Infinity,
  keepAliveIntervalTime: Infinity,
  keepAliveTimeoutTime: Infinity,
  streamBufferSize: 1 * 1024 * 1024, // 1MB
};

export { serverDefault, clientDefault };
