export function warningAfterAudioRecovery<T extends { kind: string; channel?: string; terminal?: boolean }>(warning: T | null, channel: string): T | null;
