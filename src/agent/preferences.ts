import type { AgentProvider } from "./types";

/** Resolve a stored model selection, replacing the sentinel with the provider default. */
export const resolveModelChoice = (provider: AgentProvider, stored?: string) =>
  !stored || stored === "default" ? provider.defaultModel : stored;

/** Resolve a stored effort selection, replacing the sentinel with the provider default. */
export const resolveEffortChoice = (
  provider: AgentProvider,
  stored?: string
) => (!stored || stored === "default" ? provider.defaultEffort : stored);
