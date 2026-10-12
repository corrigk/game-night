import { createContext, useContext } from 'react';
import type { Team } from './types';

/** All teams in the current room, in stable order. Provided by the TV and phone pages. */
export const TeamsContext = createContext<Team[]>([]);

export const useTeams = () => useContext(TeamsContext);
