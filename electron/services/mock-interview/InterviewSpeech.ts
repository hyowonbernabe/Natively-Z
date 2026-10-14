import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Text travels through stdin/a UTF-8 file, never through a shell command.
const WINDOWS_SPEECH = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Speech; $voice=New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $voice.Speak([Console]::In.ReadToEnd()) } finally { $voice.Dispose() }`;

export function speechCommand(platform: string, file?: string): { command: string; args: string[] } {
    if (platform === 'win32') return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_SPEECH, 'utf16le').toString('base64')],
    };
    if (platform === 'darwin' && file) return { command: '/usr/bin/say', args: ['-f', file] };
    throw new Error('Spoken interviews are supported on Windows and macOS. You can still read the questions.');
}

export class InterviewSpeech {
    private child: ChildProcess | null = null;
    private finish: (() => void) | null = null;

    cancel(): void {
        const child = this.child;
        if (!child) return;
        if (process.platform === 'win32' && child.pid) {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => { child.kill(); });
        } else child.kill();
        this.finish?.();
    }

    async speak(text: string, signal: AbortSignal): Promise<void> {
        this.cancel();
        if (signal.aborted) return;
        let folder: string | undefined;
        let file: string | undefined;
        if (process.platform === 'darwin') {
            folder = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-interview-speech-'));
            file = path.join(folder, 'question.txt');
            fs.writeFileSync(file, text, 'utf8');
        }
        try {
            const { command, args } = speechCommand(process.platform, file);
            await new Promise<void>((resolve, reject) => {
                const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
                this.child = child;
                let settled = false;
                const done = (error?: Error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    signal.removeEventListener('abort', abort);
                    if (this.child === child) { this.child = null; this.finish = null; }
                    error ? reject(error) : resolve();
                };
                this.finish = () => done();
                const abort = () => this.cancel();
                const timer = setTimeout(() => {
                    this.finish = () => done(new Error('Speech playback took too long. You can read the question or try Replay.'));
                    this.cancel();
                }, 90_000);
                signal.addEventListener('abort', abort, { once: true });
                child.on('error', () => done(new Error('Speech could not start. Check that a system voice is installed, or read the question.')));
                child.on('close', code => done(code && !signal.aborted ? new Error('Speech playback failed. You can read the question or try Replay.') : undefined));
                child.stdin?.on('error', () => {});
                child.stderr?.resume();
                child.stdin?.end(process.platform === 'win32' ? text : undefined, 'utf8');
                if (signal.aborted) abort();
            });
        } finally {
            if (file) fs.unlinkSync(file);
            if (folder) fs.rmdirSync(folder);
        }
    }
}
