// Module Manager API (Slides 13, 14, 20)
import express from 'express';
import { db, orgId } from '../db/index.mjs';
import { wrap, fail } from './http.mjs';
import { MODULE_CATALOG, getInstalledModules, syncModuleRegistry } from '../lib/modules.mjs';
import { bus } from '../lib/events.mjs';

export const modulesRouter = () => {
  const r = express.Router();

  /** List all modules with installed status */
  r.get('/', wrap(async (req, res) => {
    await syncModuleRegistry();
    const rows = await getInstalledModules();
    
    // Group into Core, Shared, Travel Pack
    const core = rows.filter(m => m.category === 'core');
    const shared = rows.filter(m => m.category === 'shared');
    const travel = rows.filter(m => m.category === 'travel');

    res.json({
      all: rows,
      core,
      shared,
      travel,
      catalog: MODULE_CATALOG,
      summary: {
        total: rows.length,
        installed: rows.filter(m => m.installed).length,
      },
    });
  }));

  /** Toggle installation state of a module */
  r.post('/:id/toggle', wrap(async (req, res) => {
    const organizationId = await orgId();
    const moduleId = req.params.id;
    if (moduleId === 'core') throw fail(400, 'Core platform module cannot be uninstalled');

    const mod = await db.one('SELECT * FROM module_registry WHERE "moduleId" = $1 AND "organizationId" = $2', [moduleId, organizationId]);
    if (!mod) throw fail(404, 'module not found in registry');

    const nextState = !mod.installed;
    const updated = await db.one(`
      UPDATE module_registry
      SET installed = $1, "installedAt" = now()
      WHERE id = $2 RETURNING *
    `, [nextState, mod.id]);

    bus.broadcast(nextState ? 'module.installed' : 'module.uninstalled', { organizationId, moduleId });

    res.json({ ok: true, module: updated });
  }));

  return r;
};

