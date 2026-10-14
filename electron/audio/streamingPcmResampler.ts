/** PCM16LE mono conversion with a continuous audio clock across capture callbacks.
 * Integrate each input sample over the output interval rather than decimating:
 * this attenuates aliasing and preserves fractional positions at 44.1 kHz.
 */
export class StreamingPcmResampler {
    private filled = 0;
    private sum = 0;
    constructor(private inputRate = 48000, private readonly outputRate = 16000) {}

    reset(inputRate = this.inputRate): void {
        if (!Number.isFinite(inputRate) || inputRate <= 0) throw new Error('Invalid audio sample rate');
        this.inputRate = inputRate;
        this.filled = 0;
        this.sum = 0;
    }

    convert(pcm: Buffer): Int16Array {
        if (pcm.length % 2) throw new Error('PCM16 audio must contain complete samples');
        const width = this.inputRate / this.outputRate;
        const samples: number[] = [];
        for (let offset = 0; offset < pcm.length; offset += 2) {
            const value = pcm.readInt16LE(offset); // also safe for unaligned Buffer slices
            let remaining = 1;
            while (remaining > 1e-9) {
                const take = Math.min(remaining, width - this.filled);
                this.sum += value * take;
                this.filled += take;
                remaining -= take;
                if (this.filled >= width - 1e-9) {
                    samples.push(Math.max(-32768, Math.min(32767, Math.round(this.sum / width))));
                    this.filled = 0;
                    this.sum = 0;
                }
            }
        }
        return Int16Array.from(samples);
    }
}
