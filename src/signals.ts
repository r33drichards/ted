import { defineSignal, defineQuery } from '@temporalio/workflow';
import type { Msg } from './types.js';

export const userMessageSignal = defineSignal<[string]>('userMessage');
export const closeSignal       = defineSignal<[]>('close');
export const transcriptQuery   = defineQuery<Msg[]>('transcript');
