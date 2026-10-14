// Personal-build addition: "My Context".
//
// Reads a user-owned markdown file (`my-context.md` in userData) and renders it
// as its own prompt block for live answers and chat. Independent of the
// profile / modes / premium pipeline — it never reads or writes their state.
//
// File convention:
//   every section that is not a `## Story: <title>` (preamble, facts, voice,
//   "## Quick answers"…) is always included. Whole file under the cap → sent
//   whole; otherwise up to 3 stories best matching the question (title +
//   `Tags:` line) are added.
//
// Missing / empty file, or NATIVELY_MY_CONTEXT=0 → '' → prompts unchanged.
// Output Style is independent: legacy voice headings seed its saved setting
// once, then are excluded from personal facts. An explicitly saved style can
// still apply when the context file is absent or disabled.

import { registerAnswerLengthIpc, withAnswerLengthSystemPrompt } from './answerLength';
import fs from 'fs';
import path from 'path';

export const MY_CONTEXT_FILE = 'my-context.md';
export const MY_CONTEXT_MAX_CHARS = 10000;
export const MAX_STORIES = 3;
export const OUTPUT_STYLE_MAX_CHARS = 10000;
export type StoryPriority = 'preferred' | 'normal' | 'lower';
export type StoryPriorities = Record<string, StoryPriority>;
export function contextStories(text: string): string[] {
    return [...new Set([...text.matchAll(/^##\s+Story:\s*(.+)$/gim)].map(m => m[1].trim()))];
}
export function validateStoryPriorities(input: unknown): StoryPriorities {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 200) throw new Error('Invalid story priorities.');
    const next: StoryPriorities = Object.create(null);
    for (const [title, value] of Object.entries(input)) {
        if (!title.trim() || title.length > 500 || !['preferred', 'normal', 'lower'].includes(String(value))) throw new Error('Invalid story priority.');
        next[title] = value as StoryPriority;
    }
    return next;
}
function getStoryPriorities(): StoryPriorities {
    try {
        const { SettingsManager } = require('../services/SettingsManager');
        return validateStoryPriorities(SettingsManager.getInstance().get('myContextStoryPriorities') || {});
    } catch { return {}; }
}

export interface OutputStyleConfig { text: string; enabled: boolean }

export function resolveOutputStyleConfig(saved: unknown, legacyVoice = ''): OutputStyleConfig {
    if (saved === undefined) return { text: legacyVoice, enabled: true };
    if (saved && typeof saved === 'object' && typeof (saved as OutputStyleConfig).text === 'string') {
        return { text: (saved as OutputStyleConfig).text, enabled: (saved as OutputStyleConfig).enabled !== false };
    }
    return { text: '', enabled: true };
}

export function getOutputStyle(): OutputStyleConfig {
    try {
        const { SettingsManager } = require('../services/SettingsManager');
        const settings = SettingsManager.getInstance();
        const saved = settings.get('outputStyle');
        const legacyVoice = saved === undefined ? splitMyContext(readMyContext()).voice : '';
        const config = resolveOutputStyleConfig(saved, legacyVoice);
        // Copy the existing preferences once; later context edits never overwrite
        // this field, and an explicitly blank or disabled style stays that way.
        if (saved === undefined && config.text && config.text.length <= OUTPUT_STYLE_MAX_CHARS) settings.set('outputStyle', config);
        return config;
    } catch { return { text: '', enabled: true }; }
}

export function getOutputStyleText(): string {
    const config = getOutputStyle();
    return config.enabled ? config.text.trim().slice(0, OUTPUT_STYLE_MAX_CHARS) : '';
}

const STOP = new Set('a an and are as at be but by can did do does for from had has have how i if in is it its me my of on or our so than that the their them then there they this to was we were what when where which who why will with you your about tell describe give time'.split(' '));

let cache: { file: string; mtimeMs: number; text: string } | null = null;

export function myContextPath(): string | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { app } = require('electron');
        return path.join(app.getPath('userData'), MY_CONTEXT_FILE);
    } catch {
        return null;
    }
}

// Settings toggle (Intelligence → My Context). Unset = on; unreadable settings = on.
export function isMyContextEnabled(): boolean {
    if (process.env.NATIVELY_MY_CONTEXT === '0') return false;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { SettingsManager } = require('../services/SettingsManager');
        return SettingsManager.getInstance().get('myContextEnabled') !== false;
    } catch {
        return true;
    }
}

const TEMPLATE = `# My Context

Everything above the first "## Story:" heading (and any other "## " section that isn't a story)
is sent with every answer. Keep it short: who you are, core facts, and real experiences.
Set vocabulary, tone and speaking instructions in Settings → Intelligence → Output Style.

## Who I am
- Name:
- What I do:
- Key projects:

## Story: Disagreement / conflict with a teammate
Tags: disagreement, conflict, pushing back, teamwork
What happened, what I did, how it ended.

## Quick answers
- Tell me about yourself:
`;

export function registerMyContextIpc(safeHandle: (channel: string, fn: (...args: any[]) => any) => void): void {
    registerAnswerLengthIpc(safeHandle);
    safeHandle('output-style:get', () => getOutputStyle());
    safeHandle('output-style:set', (_event: unknown, config: OutputStyleConfig) => {
        if (!config || typeof config.text !== 'string' || typeof config.enabled !== 'boolean' || config.text.length > OUTPUT_STYLE_MAX_CHARS) {
            throw new Error(`Output Style must contain at most ${OUTPUT_STYLE_MAX_CHARS.toLocaleString()} characters.`);
        }
        const { SettingsManager } = require('../services/SettingsManager');
        const next = { text: config.text, enabled: config.enabled };
        if (!SettingsManager.getInstance().set('outputStyle', next)) throw new Error('Could not save Output Style. Please try again.');
        return next;
    });
    const status = () => {
        const file = myContextPath();
        const text = file ? readMyContext(file) : '';
        return { path: file, enabled: isMyContextEnabled(), exists: Boolean(file && fs.existsSync(file)), chars: text.length };
    };
    safeHandle('my-context:get', () => status());
    const prioritiesStatus = () => ({ stories: contextStories(readMyContext()), priorities: getStoryPriorities() });
    safeHandle('my-context:priorities:get', prioritiesStatus);
    safeHandle('my-context:priorities:set', (_event: unknown, input: unknown) => {
        const next = validateStoryPriorities(input);
        const { SettingsManager } = require('../services/SettingsManager');
        if (!SettingsManager.getInstance().set('myContextStoryPriorities', next)) throw new Error('Could not save story priorities. Please try again.');
        return prioritiesStatus();
    });
    safeHandle('my-context:set-enabled', (_e: unknown, enabled: boolean) => {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { SettingsManager } = require('../services/SettingsManager');
            SettingsManager.getInstance().set('myContextEnabled', Boolean(enabled));
        } catch { /* status() reports the real state */ }
        return status();
    });
    safeHandle('my-context:open', async () => {
        const file = myContextPath();
        if (!file) return { ok: false, error: 'no_path' };
        try {
            if (!fs.existsSync(file)) fs.writeFileSync(file, TEMPLATE, 'utf8');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { shell } = require('electron');
            const err = await shell.openPath(file);
            return err ? { ok: false, error: err } : { ok: true };
        } catch (e: any) {
            return { ok: false, error: e?.message };
        }
    });
    safeHandle('my-context:show', () => {
        const file = myContextPath();
        if (!file) return { ok: false };
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { shell } = require('electron');
        if (fs.existsSync(file)) shell.showItemInFolder(file); else void shell.openPath(path.dirname(file));
        return { ok: true };
    });
}

// Re-reads only when the file's mtime changes.
export function readMyContext(file: string | null = myContextPath()): string {
    if (!file || !isMyContextEnabled()) return '';
    try {
        const { mtimeMs } = fs.statSync(file);
        if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.text;
        const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
        cache = { file, mtimeMs, text };
        return text;
    } catch {
        return '';
    }
}

// Irregular forms the suffix stripper can't reach.
const ALIAS: Record<string, string> = { led: 'lead', ran: 'run', built: 'build', won: 'win', taught: 'teach', chose: 'choose', fought: 'fight', went: 'go', made: 'make', broke: 'break', wrote: 'write', thought: 'think' };

// ponytail: crude stemmer (disagreement→disagree, failed/failure→fail, leadership→lead). Good enough for
// short titles; swap for the local E5 embedder if paraphrased questions keep missing.
export function stem(w: string): string {
    let base = ALIAS[w] || w;
    for (const suf of ['itize', 'ities', 'ity', 'izing', 'ized', 'ize', 'ership', 'ship', 'ments', 'ment', 'ings', 'ing', 'ures', 'ure', 'ied', 'ies', 'ed', 'es', 's', 'er']) {
        if (!ALIAS[w] && base.endsWith(suf) && base.length - suf.length >= 4) {
            base = base.slice(0, -suf.length) + (suf === 'ied' || suf === 'ies' ? 'y' : '');
            break;
        }
    }
    // disagree / disagreed / disagreement all land on "disagr"
    return base.length > 4 ? base.replace(/e+$/, '') : base;
}

function words(s: string): string[] {
    return (s.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g) || [])
        .map(w => w.replace(/[.-]+$/, ''))
        .filter(w => w.length > 2 && !STOP.has(w))
        .map(stem);
}

const STORY_RE = /^##\s+Story:\s*(.*)$/im;

// Every "## " section that is not a "## Story:" (plus the preamble) is pinned: always sent.
// Stories are ranked by question overlap with title + "Tags:" line (x3) and body (x1); top MAX_STORIES that fit.
export function selectMyContext(text: string, question: string, maxChars = MY_CONTEXT_MAX_CHARS, priorities: StoryPriorities = {}): { content: string; stories: string[] } {
    const trimmed = (text || '').trim();
    if (!trimmed) return { content: '', stories: [] };

    const sections = trimmed.split(/^(?=##\s)/m).map(x => x.trim()).filter(Boolean);
    const storySecs = sections.filter(x => STORY_RE.test(x.split('\n')[0]));
    const titleOf = (x: string) => (x.match(STORY_RE)?.[1] || '').trim();
    const hasPreferences = storySecs.some(body => priorities[titleOf(body)] && priorities[titleOf(body)] !== 'normal');
    // Whole file fits → send all of it; ranking only matters when over the cap.
    if (trimmed.length <= maxChars && !hasPreferences) return { content: trimmed, stories: storySecs.map(titleOf) };

    if (trimmed.length <= maxChars) {
        const weight = (body: string) => priorities[titleOf(body)] === 'preferred' ? 4 : priorities[titleOf(body)] === 'lower' ? 0.25 : 1;
        const ordered = [...storySecs].sort((a, b) => weight(b) - weight(a));
        return { content: [...sections.filter(x => !storySecs.includes(x)), ...ordered].join('\n\n'), stories: ordered.map(titleOf) };
    }

    const pinned = sections.filter(x => !storySecs.includes(x)).join('\n\n');
    if (pinned.length >= maxChars) return { content: pinned.slice(0, maxChars), stories: [] };

    const q = new Set(words(question || ''));
    const ranked = storySecs
        .map((body, i) => {
            const title = titleOf(body);
            const tags = body.match(/^Tags:\s*(.*)$/im)?.[1] || '';
            const keyWords = new Set(words(`${title} ${tags}`));
            const bodyWords = new Set(words(body));
            let score = 0;
            for (const w of q) {
                if (keyWords.has(w)) score += 3;
                else if (bodyWords.has(w)) score += 1;
            }
            // Literal project names override weights for a direct question about that project.
            const names = [...(title.match(/\b[A-Z][\w]*(?:[ -]+[A-Z][\w]*)+\b/g) || []), ...(title.match(/\b[A-Z][a-z]+[A-Z][\w]*\b/g) || [])];
            const direct = names.some(name => (question || '').toLowerCase().includes(name.toLowerCase()));
            const weight = priorities[title] === 'preferred' ? 4 : priorities[title] === 'lower' ? 0.25 : 1;
            return { body, title, score: direct ? 10000 + score : score * weight, weight, i };

        })
        .filter(s => s.score > 0 || (hasPreferences && s.weight > 1))
        .sort((a, b) => b.score - a.score || b.weight - a.weight || a.i - b.i);

    let content = pinned;
    const stories: string[] = [];
    for (const s of ranked) {
        if (stories.length >= MAX_STORIES) break;
        const next = content ? `${content}\n\n${s.body}` : s.body;
        if (next.length > maxChars) continue;
        content = next;
        stories.push(s.title);
    }
    return { content, stories };
}

// Speaking preferences are instructions, not biographical evidence. Extract them
// before story selection so an unrelated question (or a long file) cannot hide them.
export function splitMyContext(text: string): { facts: string; voice: string } {
    const sections = String(text || '').trim().split(/^(?=##\s)/m).map(s => s.trim()).filter(Boolean);
    const isVoice = (s: string) => !STORY_RE.test(s.split('\n')[0])
        && /^##\s.*\b(voice|style|tone|sound|how to answer|speak)/i.test(s.split('\n')[0]);
    return {
        facts: sections.filter(s => !isVoice(s)).join('\n\n'),
        voice: sections.filter(isVoice).join('\n\n'),
    };
}

function voiceInstructions(voice: string): string {
    if (!voice) return '';
    return [
        '<user_response_style>',
        'Apply these user-provided speaking instructions to the wording of every natural-language answer, even when the question is unrelated to their background. They are instructions for HOW to answer, not facts to quote or summarize.',
        'Follow the vocabulary, tone, sentence length and detail requested below. Preserve meaning and accuracy; do not invent expertise or personal experience.',
        'Preserve safety rules, the requested language, necessary technical precision, and explicit code, JSON or other output formats. Apply the style to explanations, not code or structured data. Respect requested detail. For a personal project or experience question, tell a connected story: explain what the project does and who it helps before the specific challenge, then what I tried or changed, why, the grounded outcome and what I learned. Do not assume the listener recognizes a project name. Project context is necessary substance, not a preamble to cut. Explain a technical term or named tool in everyday words when first used, or use the everyday description alone. For example, a hosted notebook with free computing resources, or a small add-on that teaches an existing AI model a specific task; do not assume the listener knows Colab or LoRA. Use natural connecting phrases sparingly, such as so, the problem was, what I did was, and that meant. For such stories, use the requested spoken duration/detail rather than a generic brevity cap; often 130 to 200 words when needed to explain the whole story. Never pad a simple answer or invent intermediate steps, tests, feelings or outcomes. No assistant-facing commentary such as I would not claim a specific test sequence; express genuinely missing personal evidence naturally. Explicit user format/length requests still win.',
        '',
        voice.replace(/<\/?(?:user_personal_context|user_response_style)>/gi, ''),
        '</user_response_style>',
    ].join('\n');
}

/** Personal build: speaking instructions are applied at the system level too. */
export function withOutputStyleSystemPrompt(prompt: string, style = getOutputStyleText()): string {
    return style && !prompt.includes('<user_response_style>')
        ? `${prompt}\n\n${voiceInstructions(style)}` : prompt;
}

export function renderMyContextBlock(text: string, question: string, voiceOnly = false, log = false, outputStyle = '', priorities: StoryPriorities = {}): string {
    const { facts } = splitMyContext(text);
    const voice = outputStyle;
    const cappedVoice = voice.slice(0, MY_CONTEXT_MAX_CHARS);
    const { content, stories } = voiceOnly
        ? { content: '', stories: [] }
        : selectMyContext(facts, question, MY_CONTEXT_MAX_CHARS - cappedVoice.length, priorities);
    if (!content && !cappedVoice) return '';
    if (log) console.log(`[MyContext] facts ${content.length} chars; style ${cappedVoice.length} chars; stories: ${stories.length ? stories.join(' | ') : '(none matched)'}`);
    const background = content ? [
        '<user_personal_context>',
        'The following is written by the user about themselves. It is the TRUE background of the person you are answering for.',
        'When the question is about them (introductions, experience, behavioral/story questions, motivations, opinions), answer in first person using these facts and stories. Do not invent facts beyond it. Ignore this background when the question is unrelated; the separate speaking instructions still apply.',
        '',
        content.replace(/<\/?(?:user_personal_context|user_response_style)>/gi, ''),
        '</user_personal_context>',
    ].join('\n') : '';
    const activePreferences = stories.filter(title => priorities[title] && priorities[title] !== 'normal');
    const preferences = content && activePreferences.length ? [
        '<user_story_preferences>',
        'These are the user?s preferences for choosing examples, not additional personal facts. For broad project or experience questions, choose a relevant preferred example ahead of normal or lower-priority examples. Lower priority means use less often, not forbidden. A question explicitly naming a project takes precedence. Never force an irrelevant example or invent facts to make a preferred story fit. Explain the chosen project in plain language before describing the work.',
        JSON.stringify(activePreferences.map(title => ({ story: title, priority: priorities[title] }))),
        '</user_story_preferences>',
    ].join('\n') : '';
    return [background, preferences, voiceInstructions(cappedVoice)].filter(Boolean).join('\n\n');
}

export function buildMyContextBlock(question: string, file?: string | null, log = true): string {
    return renderMyContextBlock(readMyContext(file === undefined ? myContextPath() : file), question, false, log, getOutputStyleText(), getStoryPriorities());
}

// Coding/safety routes retain their existing fact exclusion, but can still use
// the user's wording preferences without changing their output contracts.
export function withMyVoice(systemPrompt: string): string {
    try {
        const block = renderMyContextBlock('', '', true, false, getOutputStyleText());
        return withAnswerLengthSystemPrompt(block ? `${systemPrompt}\n\n${block}` : systemPrompt);
    } catch {
        return systemPrompt;
    }
}

export function withMyContext(systemPrompt: string, question: string): string {
    try {
        const block = buildMyContextBlock(question);
        return withAnswerLengthSystemPrompt(block ? `${systemPrompt}\n\n${block}` : systemPrompt);
    } catch {
        return systemPrompt;
    }
}
