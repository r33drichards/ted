import { defineSignal, defineQuery } from '@temporalio/workflow';
import type { Msg } from './types.js';

export const userMessageSignal = defineSignal<[string]>('userMessage');
export const closeSignal       = defineSignal<[]>('close');
export const transcriptQuery   = defineQuery<Msg[]>('transcript');

/** Steering message for an autoresearch experiment workflow. */
export const experimentSteerSignal = defineSignal<[string]>('experimentSteer');

/** Force-stop the in-flight agent turn (halts at the next activity boundary). */
export const cancelTurnSignal = defineSignal<[]>('cancelTurn');
