// Entry point of worksuite-ai-engine.service (and of the control service's own child in development).
import { serveEngine } from './worker.ts';

const path = process.argv[2] ?? process.env.WORKSUITE_AI_ENGINE_SOCKET;
if (!path) { process.stderr.write('usage: engine-main.ts <socket>\n'); process.exit(2); }
const { server, engine } = serveEngine(path);
const stop = () => { server.close(); void engine.dispose().finally(() => process.exit(0)); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
