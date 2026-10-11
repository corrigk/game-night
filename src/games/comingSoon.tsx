import type { GameModule } from './types';

/** Hub tile for a game that hasn't been built yet. Can't be started. */
export function comingSoon(meta: Pick<GameModule, 'id' | 'title' | 'emoji' | 'tagline' | 'scored' | 'defaultRounds'> & { step: number }): GameModule {
  const { step, ...rest } = meta;
  return {
    ...rest,
    rules: [],
    maxRounds: 20,
    status: 'soon',
    soonNote: `Arrives in build step ${step}`,
    startRound: async () => {},
    next: async (ctx) => ctx.endRound(),
    TV: () => <div className="center-stack"><h1 className="display">Coming soon</h1></div>,
    Phone: () => <div className="center-stack"><p>Coming soon</p></div>,
  };
}
