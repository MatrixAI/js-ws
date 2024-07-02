# js-ws

WebSocket library for TypeScript/JavaScript applications.

This is built on top of the [ws](https://github.com/websockets/ws) library, providing a multiplexed WebStreams API on top of WebSocket.

## Installation

```sh
npm install --save @matrixai/ws
```

### Browser Usage

To use `WebSocketClient` in a browser environment, you will need to polyfill:

- [`buffer`](https://nodejs.org/api/buffer.html)
- [`perf_hooks`](https://nodejs.org/api/perf_hooks.html)

A good choice for a `buffer` polyfill is [`feross/buffer`](https://github.com/feross/buffer)

To polyfill `perf_hooks`, you can alias the `perf_hooks` using your bundler of choice with a file containing the following code:

```ts
const { performance } = globalThis;
export { performance };
```

## Development

Run `nix-shell`, and once you're inside, you can use:

```sh
# install (or reinstall packages from package.json)
npm install
# build the dist
npm run build
# run the repl (this allows you to import from ./src)
npm run ts-node
# run the tests
npm run test
# lint the source code
npm run lint
# automatically fix the source
npm run lintfix
```

### Benchmarks

View benchmarks here: https://github.com/MatrixAI/js-ws/blob/master/benches/results with https://raw.githack.com/

### Docs Generation

```sh
npm run docs
```

See the docs at: https://matrixai.github.io/js-ws/

### Publishing

Publishing is handled automatically by the staging pipeline.

Prerelease:

```sh
# npm login
npm version prepatch --preid alpha # premajor/preminor/prepatch
git push --follow-tags
```

Release:

```sh
# npm login
npm version patch # major/minor/patch
git push --follow-tags
```

Manually:

```sh
# npm login
npm version patch # major/minor/patch
npm run build
npm publish --access public
git push
git push --tags
```
