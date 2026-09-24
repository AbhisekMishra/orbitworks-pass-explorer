import closeWithGrace from 'close-with-grace';

import { buildApp } from './app.js';
import { dataFiles, loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { loadDatasetInfo } from './services/dataset.js';
import { loadArtifacts } from './services/trackArtifacts.js';

const config = loadConfig();
const files = dataFiles(config.DATA_DIR);

/** Pretty logs in development only if pino-pretty (a devDependency) is installed; JSON otherwise. */
function canResolve(specifier: string): boolean {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}
const logger =
  config.NODE_ENV === 'development' && canResolve('pino-pretty')
    ? {
        level: config.LOG_LEVEL,
        transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
      }
    : { level: config.LOG_LEVEL };

const db = await openDatabase({
  path: files.database,
  poolSize: config.DUCKDB_POOL_SIZE,
});
const artifacts = await loadArtifacts(config.DATA_DIR);
const info = await loadDatasetInfo(db, artifacts.manifest);
const geometryStarted = performance.now();
const geometry = await db.loadGeometry();
const geometryLoadMs = Math.round(performance.now() - geometryStarted);
const app = await buildApp({ config, db, geometry, info, artifacts, logger });

closeWithGrace({ delay: 10_000 }, async ({ err, signal }) => {
  if (err) app.log.error({ err }, 'Shutting down after an unexpected error');
  else app.log.info({ signal }, 'Shutting down gracefully');
  await app.close();
  db.close();
});

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info(
  { dataset: info.name, satellites: info.satellites.length, tracksEtag: artifacts.etag, geometryLoadMs },
  `API docs at http://localhost:${config.PORT}/api/docs`,
);
