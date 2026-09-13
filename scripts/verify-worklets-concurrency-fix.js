const fs = require('fs');
const path = require('path');

const headerPath = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-worklets',
  'Common',
  'cpp',
  'worklets',
  'SharedItems',
  'Serializable.h',
);

const requiredSynchronization = [
  'std::atomic<jsi::Runtime *> secondaryRuntime_',
  'std::mutex secondaryCacheMutex_',
  'std::lock_guard<std::mutex> lock(secondaryCacheMutex_)',
  'std::memory_order_acquire',
  'std::memory_order_release',
  'cleanupRuntimeAware(',
];

if (!fs.existsSync(headerPath)) {
  throw new Error(`Worklets Serializable header not found: ${headerPath}`);
}

const header = fs.readFileSync(headerPath, 'utf8');
const missing = requiredSynchronization.filter(token => !header.includes(token));

if (missing.length > 0) {
  throw new Error(
    `Worklets secondary-runtime synchronization is incomplete; missing: ${missing.join(
      ', ',
    )}`,
  );
}

console.log('Verified Worklets secondary-runtime cache synchronization.');
