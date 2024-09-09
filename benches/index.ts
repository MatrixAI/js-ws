#!/usr/bin/env ts-node

import type { Summary } from 'benny/lib/internal/common-types.js';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import si from 'systeminformation';
import { fsWalk, resultsPath, suitesPath } from './utils.js';

const projectPath = path.dirname(url.fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  await fs.promises.mkdir(path.join(projectPath, 'results'), {
    recursive: true,
  });
  // Running all suites
  for await (const suitePath of fsWalk(suitesPath)) {
    // Skip over non-ts and non-js files
    const ext = path.extname(suitePath);
    if (ext !== '.ts' && ext !== '.js') {
      continue;
    }
    const suite: () => Promise<Summary> = (await import(suitePath)).default;
    await suite();
  }
  // Concatenating metrics
  const metricsPath = path.join(resultsPath, 'metrics.txt');
  let concatenating = false;
  for await (const metricPath of fsWalk(resultsPath)) {
    // Skip over non-metrics files
    if (!metricPath.endsWith('_metrics.txt')) {
      continue;
    }
    const metricData = await fs.promises.readFile(metricPath);
    if (concatenating) {
      await fs.promises.appendFile(metricsPath, '\n');
    }
    await fs.promises.appendFile(metricsPath, metricData);
    concatenating = true;
  }
  const systemData = await si.get({
    cpu: '*',
    osInfo: 'platform, distro, release, kernel, arch',
    system: 'model, manufacturer',
  });
  await fs.promises.writeFile(
    path.join(projectPath, 'results', 'system.json'),
    JSON.stringify(systemData, null, 2),
  );
}

if (import.meta.url.startsWith('file:')) {
  const modulePath = url.fileURLToPath(import.meta.url);
  if (process.argv[1] === modulePath) {
    void main();
  }
}

export default main;
