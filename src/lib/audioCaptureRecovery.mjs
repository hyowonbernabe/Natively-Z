/** Clear only the recovered channel's temporary capture warning. */
export function warningAfterAudioRecovery(warning, channel) {
    return warning?.kind === 'audio-capture-failure' && warning.channel === channel && !warning.terminal
        ? null : warning;
}
