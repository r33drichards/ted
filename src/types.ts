export type Role = 'user' | 'assistant';

export type Msg = {
  role: Role;
  content: string;
};

export type StreamReq = {
  sessionId: string;
  history: Msg[];
  userId: string;
};
