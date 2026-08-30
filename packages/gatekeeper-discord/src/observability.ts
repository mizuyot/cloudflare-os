import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";

/** Observability fields emitted by the Discord gatekeeper. */
export type DiscordObservabilityFields = {
  vendorId: string;
  guildId: string;
  channelId: string;
};

/** Ambient observability fields for one Discord gatekeeper operation. */
export const obsContext = createObservabilityContext<DiscordObservabilityFields>();
