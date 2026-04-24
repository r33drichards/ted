declare module 'irc-framework' {
  export default class IRC {
    static Client: new () => IRC;
    connect(options: Record<string, unknown>): void;
    join(channel: string): void;
    say(target: string, message: string): void;
    quit(message?: string): void;
    on(event: string, listener: (...args: any[]) => void): void;
  }
}
