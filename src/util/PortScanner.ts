import * as net from 'net';

export function isPortOpen(port: number, host: string = '127.0.0.1', timeout: number = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

export async function findOpenPorts(ports: number[], host: string = '127.0.0.1'): Promise<number[]> {
  const results = await Promise.all(
    ports.map(async (port) => ({ port, open: await isPortOpen(port, host) }))
  );
  return results.filter(r => r.open).map(r => r.port);
}
