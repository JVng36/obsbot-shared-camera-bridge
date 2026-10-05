// No runtime or vendor imports until the bounded config preflight succeeds.
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateRuntimeConfig } from './config.js';

export function readLinuxConfig(configPath, minutes) {
  const uid = process.getuid();
  if (uid === 0 || !Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new Error('invalid launch');
  const path = resolve(configPath);
  const parent = dirname(path);
  const rootUid = lstatSync("/").uid;
  const identities = new Map();
  let current = parent;
  while (true) {
    const stat = lstatSync(current);
    identities.set(current, stat);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe config directory');
    if (current === parent) {
      if (stat.uid !== uid || (stat.mode & 0o777) !== 0o700) throw new Error('unsafe config parent');
    } else if ((stat.uid !== uid && stat.uid !== rootUid) || ((stat.mode & 0o022) && !(current === '/tmp' && stat.uid === rootUid && (stat.mode & 0o1000)))) {
      throw new Error('unsafe config ancestor');
    }
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  const before = lstatSync(path);
  const fds = [];
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const validateDirectory = (stat, name) => {
    if (!stat.isDirectory() || !same(stat, identities.get(name))) throw new Error('unsafe config directory identity');
    if (name === parent) {
      if (stat.uid !== uid || (stat.mode & 0o777) !== 0o700) throw new Error('unsafe config parent');
    } else if ((stat.uid !== uid && stat.uid !== rootUid) ||
      ((stat.mode & 0o022) && !(name === '/tmp' && stat.uid === rootUid && (stat.mode & 0o1000)))) {
      throw new Error('unsafe config ancestor');
    }
  };
  try {
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
    let directory = openSync('/', flags);
    fds.push(directory);
    validateDirectory(fstatSync(directory), '/');
    const edges = [];
    let name = '';
    for (const part of parent.split('/').filter(Boolean)) {
      name += '/' + part;
      const entry = `/proc/self/fd/${directory}/${part}`;
      const next = openSync(entry, flags);
      fds.push(next);
      validateDirectory(fstatSync(next), name);
      edges.push({entry, fd: next, name});
      directory = next;
    }
    // Catch replacement at the original seam, and changes between verified opens.
    // These checks detect observed replacements, not an OS filesystem freeze.
    for (const edge of edges) {
      const named = lstatSync(edge.entry);
      if (named.isSymbolicLink() || !same(named, fstatSync(edge.fd))) throw new Error('unsafe config directory identity');
      validateDirectory(fstatSync(edge.fd), edge.name);
    }
    const fd = openSync(`/proc/self/fd/${directory}/${basename(path)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    fds.push(fd);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > 65536 || !same(stat, before)) throw new Error('unsafe config file');
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > 65536) throw new Error('config too large');
    const rawConfig = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)));
    validateRuntimeConfig({...rawConfig, minutes});
    return rawConfig;
  } finally { for (const fd of fds.reverse()) closeSync(fd); }

}

export async function startLinux(argv = process.argv.slice(2)) {
  const args = {};
  for (let i=0; i<argv.length; i+=2) {
    if (!['--config','--vendor-root','--minutes'].includes(argv[i]) || argv[i+1] === undefined || args[argv[i]] !== undefined) throw new Error('invalid arguments');
    args[argv[i]] = argv[i+1];
  }
  if (!args['--config'] || !args['--vendor-root'] || !/^[0-9]{1,5}$/.test(args['--minutes'] ?? '')) throw new Error('invalid arguments');
  const minutes = Number(args['--minutes']);
  const rawConfig = readLinuxConfig(args['--config'],minutes);
  // The shell owns flock on inherited fd 9; direct invocation is unsupported.
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) throw new Error('terminal required');
  const lock = fstatSync(9);
  const namedLock = lstatSync(`/tmp/obsbot-shared-camera-${process.getuid()}/owner.lock`);
  if (!lock.isFile() || lock.uid !== process.getuid() || lock.dev !== namedLock.dev || lock.ino !== namedLock.ino) throw new Error('owner lock required');
  const { run } = await import('./main.js');
  return run(['--config',resolve(args['--config']),'--vendor-root',resolve(args['--vendor-root']),'--minutes',String(minutes)],{rawConfig});
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startLinux().catch(() => {
    process.stderr.write('Linux camera start rejected (validation or startup failure).\n');
    process.exitCode = 1;
  });
}
