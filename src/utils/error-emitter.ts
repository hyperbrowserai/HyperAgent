import EventEmitter from "events";

type ErrorEvents = {
  error: (error: Error) => void;
};

export class ErrorEmitter extends EventEmitter {
  override on<K extends keyof ErrorEvents>(
    event: K,
    listener: ErrorEvents[K]
  ): this {
    return super.on(event, listener);
  }

  override once<K extends keyof ErrorEvents>(
    event: K,
    listener: ErrorEvents[K]
  ): this {
    return super.once(event, listener);
  }

  override off<K extends keyof ErrorEvents>(
    event: K,
    listener: ErrorEvents[K]
  ): this {
    return super.off(event, listener);
  }

  override emit<K extends keyof ErrorEvents>(
    event: K,
    ...args: Parameters<ErrorEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  override addListener<K extends keyof ErrorEvents>(
    eventName: K,
    listener: (...args: Parameters<ErrorEvents[K]>) => void
  ): this {
    return super.addListener(eventName, listener);
  }
}
