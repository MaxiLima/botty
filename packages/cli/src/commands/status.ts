import type { CliConfig } from '../config.js';
import { getJson } from '../http.js';
import { ownership } from '../procs.js';

function describe(state: 'owned' | 'foreign' | 'down', pid?: number): string {
  if (state === 'down') return 'DOWN';
  return state === 'owned' ? `up (botty cli, pid ${pid})` : `up (foreign, pid ${pid} — not started by botty)`;
}

export async function status(cfg: CliConfig): Promise<void> {
  const agent = ownership(cfg, 'agent');
  const health = await getJson(`${cfg.agentUrl}/api/health`).catch(() => null);
  console.log(`agent :${cfg.port} — ${describe(agent.state, agent.pid)}${health ? ` → ${JSON.stringify(health)}` : ''}`);

  if (cfg.mode === 'sim') {
    const sim = ownership(cfg, 'sim');
    const state = await getJson(`${cfg.simUrl}/control/state`).catch(() => null);
    const scenario = state && (typeof state.scenario === 'string' ? state.scenario : (state.scenario?.name ?? 'none'));
    console.log(
      `sim   :${cfg.simPort} — ${describe(sim.state, sim.pid)}${state ? ` → scenario=${scenario} clock=${JSON.stringify(state.clock)}` : ''}`,
    );
  }

  console.log(`data  ${cfg.dataDir}`);
  if (!health) process.exitCode = 1;
}
