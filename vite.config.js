import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { worldEndpoint } from './worldserver.js';

// Dev-only helper: POST /__shot with a base64 data URL body saves a PNG to
// shots/. Lets tooling capture renders headlessly.
function shotEndpoint() {
  return {
    name: 'shot-endpoint',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end('POST only');
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const base64 = body.replace(/^data:image\/png;base64,/, '');
            const dir = path.resolve('shots');
            fs.mkdirSync(dir, { recursive: true });
            const name = (req.headers['x-shot-name'] || 'shot').toString().replace(/[^\w-]/g, '');
            const file = path.join(dir, `${name}.png`);
            fs.writeFileSync(file, Buffer.from(base64, 'base64'));
            res.end(file);
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      });
    },
  };
}

// Dev-only control API: external tools (anything that can speak HTTP) POST
// commands to /__cmd; the running app polls them, runs them against
// window.__relight and POSTs results back to /__result.
//   POST /__cmd    {"fn":"poseBone","args":["head",[-20,30,0]]}  -> {"id":1}
//   GET  /__result?id=1                                          -> {"ok":true,"data":...}
function commandEndpoint() {
  let nextId = 1;
  const queue = [];
  const results = new Map();
  // Only the most recently loaded page instance may drain commands — stale
  // "zombie" pages (hidden tabs, bfcache survivors) keep polling forever and
  // would steal commands meant for the live page.
  let currentClient = null;
  const readBody = (req) =>
    new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => resolve(body));
    });
  return {
    name: 'command-endpoint',
    configureServer(server) {
      server.middlewares.use('/__claim', async (req, res) => {
        res.setHeader('content-type', 'application/json');
        try {
          const { token } = JSON.parse(await readBody(req));
          currentClient = token;
          res.end('{}');
        } catch (e) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
      server.middlewares.use('/__cmd', async (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST') {
          try {
            const cmd = JSON.parse(await readBody(req));
            cmd.id = nextId++;
            queue.push(cmd);
            res.end(JSON.stringify({ id: cmd.id }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String(e) }));
          }
        } else {
          // App polls: only the current claimant drains the queue
          const token = new URL(req.url, 'http://x').searchParams.get('token');
          res.end(JSON.stringify(token && token === currentClient ? queue.splice(0) : []));
        }
      });
      server.middlewares.use('/__result', async (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST') {
          try {
            const r = JSON.parse(await readBody(req));
            results.set(r.id, r);
            if (results.size > 200) results.delete(results.keys().next().value);
            res.end('{}');
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String(e) }));
          }
        } else {
          const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
          res.end(JSON.stringify(results.get(id) || { pending: true }));
        }
      });
    },
  };
}

// Dev-only video pipeline: the app POSTs numbered PNG frames, then /end runs
// the bundled ffmpeg to encode exports/<name>.mp4.
//   POST /__video/begin  {"name","fps"}         -> {"id"}
//   POST /__video/frame?id=..&index=N            (body: PNG data URL)
//   POST /__video/end?id=..                     -> {"file"} when encoded
function videoEndpoint() {
  const sessions = new Map();
  let nextId = 1;
  const readBody = (req) =>
    new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => resolve(body));
    });
  return {
    name: 'video-endpoint',
    configureServer(server) {
      server.middlewares.use('/__video', async (req, res) => {
        res.setHeader('content-type', 'application/json');
        const url = new URL(req.url, 'http://x');
        try {
          if (url.pathname === '/begin') {
            const { name, fps, alpha } = JSON.parse(await readBody(req));
            const id = String(nextId++);
            const dir = path.resolve('exports', `.frames-${id}`);
            fs.mkdirSync(dir, { recursive: true });
            sessions.set(id, {
              dir,
              fps: fps || 30,
              alpha: !!alpha,
              name: (name || 'video').replace(/[^\w-]/g, ''),
            });
            res.end(JSON.stringify({ id }));
          } else if (url.pathname === '/frame') {
            const s = sessions.get(url.searchParams.get('id'));
            if (!s) throw new Error('unknown video session');
            const index = Number(url.searchParams.get('index'));
            const body = await readBody(req);
            const base64 = body.replace(/^data:image\/png;base64,/, '');
            fs.writeFileSync(
              path.join(s.dir, `frame_${String(index).padStart(5, '0')}.png`),
              Buffer.from(base64, 'base64')
            );
            res.end('{}');
          } else if (url.pathname === '/end') {
            const id = url.searchParams.get('id');
            const s = sessions.get(id);
            if (!s) throw new Error('unknown video session');
            sessions.delete(id);
            // Alpha clips encode as ProRes 4444 (.mov) — the editor-standard
            // transparent format; opaque clips as H.264 mp4.
            const out = path.resolve('exports', `${s.name}.${s.alpha ? 'mov' : 'mp4'}`);
            const encodeArgs = s.alpha
              ? ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']
              : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
            await new Promise((resolve, reject) => {
              const ff = spawn(ffmpegPath, [
                '-y',
                '-framerate', String(s.fps),
                '-i', path.join(s.dir, 'frame_%05d.png'),
                ...encodeArgs,
                out,
              ]);
              let err = '';
              ff.stderr.on('data', (d) => (err += d));
              ff.on('close', (code) =>
                code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`))
              );
            });
            fs.rmSync(s.dir, { recursive: true, force: true });
            res.end(JSON.stringify({ file: out }));
          } else {
            res.statusCode = 404;
            res.end('{"error":"unknown video op"}');
          }
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
        }
      });
    },
  };
}

export default defineConfig(async () => {
  const plugins = [shotEndpoint(), commandEndpoint(), videoEndpoint(), worldEndpoint()];
  // Optional local extensions: a local.plugins.mjs next to this file
  // (untracked) can contribute extra dev-server plugins. Absent on fresh
  // clones — everything above works without it.
  const localFile = path.resolve('local.plugins.mjs');
  if (fs.existsSync(localFile)) {
    try {
      const local = await import(pathToFileURL(localFile).href);
      if (Array.isArray(local.plugins)) plugins.push(...local.plugins);
    } catch (e) {
      console.warn('local.plugins.mjs failed to load:', e.message);
    }
  }
  return { plugins };
});
