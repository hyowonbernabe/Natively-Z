// Personal build: independent interview practice, separate from paid Modes/Profile.
export interface InterviewOptions {
    role: string;
    focus: 'mixed' | 'behavioral' | 'technical';
    language: 'English' | 'Filipino' | 'English and Filipino';
    questions: number;
    microphone: boolean;
    spoken: boolean;
    autoAdvance: boolean;
    pauseSeconds: number;
}

export interface InterviewTurn {
    speaker: 'interviewer' | 'candidate';
    text: string;
    timestamp: number;
}

export interface InterviewSession {
    id: string;
    startedAt: number;
    endedAt?: number;
    options: InterviewOptions;
    model: string;
    status: 'active' | 'completed';
    turns: InterviewTurn[];
    feedback?: string;
}

export interface InterviewState {
    session: InterviewSession | null;
    phase: 'idle' | 'generating' | 'speaking' | 'answering' | 'reviewing' | 'completed';
    draft: string;
    partial: string;
    microphoneActive: boolean;
    level: number;
    countdown: number | null;
    error: string | null;
    speechError: string | null;
}

export type InterviewResult = { success: boolean; state: InterviewState; error?: string };
