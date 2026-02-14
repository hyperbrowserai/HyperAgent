import { getDebugOptions, setDebugOptions } from "@/debug/options";

describe("debug options", () => {
  beforeEach(() => {
    setDebugOptions(undefined, false);
  });

  it("stores boolean debug flags and enabled state", () => {
    setDebugOptions(
      {
        cdpSessions: true,
        traceWait: false,
        profileDomCapture: true,
        structuredSchema: false,
      },
      true
    );

    expect(getDebugOptions()).toEqual({
      cdpSessions: true,
      traceWait: false,
      profileDomCapture: true,
      structuredSchema: false,
      enabled: true,
    });
  });

  it("ignores non-boolean debug option values", () => {
    setDebugOptions(
      {
        cdpSessions: true,
        traceWait: "true" as unknown as boolean,
      },
      false
    );

    expect(getDebugOptions()).toEqual({
      cdpSessions: true,
      enabled: false,
    });
  });

  it("omits trap-prone debug option getters without throwing", () => {
    const trappedOptions = new Proxy(
      {
        cdpSessions: true,
      },
      {
        get: (target, prop, receiver) => {
          if (prop === "traceWait") {
            throw new Error("traceWait trap");
          }
          return Reflect.get(target, prop, receiver);
        },
      }
    );

    expect(() =>
      setDebugOptions(
        trappedOptions as unknown as Parameters<typeof setDebugOptions>[0],
        true
      )
    ).not.toThrow();

    expect(getDebugOptions()).toEqual({
      cdpSessions: true,
      enabled: true,
    });
  });
});
